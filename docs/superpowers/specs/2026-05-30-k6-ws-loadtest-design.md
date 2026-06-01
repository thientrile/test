# Design: Convert WebSocket load test from Artillery/socket.io-client → k6/ws

**Date:** 2026-05-30
**Status:** Approved (pending spec review)
**Scope:** `d:\CODE\appchat\test`

## Problem

The current 1000-socket load test runs on **Artillery** with `socket.io-client`
(`artillery/processor.js`), coordinated by a **Redis barrier** and an external
`coordinator/sync.js` that publishes a `GO` signal once all VUs have joined.
The multi-process model (N scaled Artillery replicas, each ~100 sockets) exists
only because a single Node event loop wedged at ~1000 sockets; it dragged in a
cross-process unique-user picker (`INCR userpick`), Redis-mirrored metric
counters, and a `dump-metrics.js` aggregator.

We are replacing the VU runtime with **k6** using the raw **`k6/ws`** client.
k6 runs all VUs in a single Go process (goroutine per VU), which removes the
reason for replicas, the Redis barrier, and the sync coordinator.

## Decisions (locked during brainstorming)

1. **Protocol:** Hand-roll Engine.IO v4 + Socket.IO framing over raw `k6/ws`.
   No backend change — the server stays a NestJS socket.io gateway on the
   `/chat` namespace.
2. **Barrier:** k6-native simultaneity. A single `fireAt` wall-clock timestamp
   is computed once in `setup()` and shared to every VU; all sockets schedule
   their `message:send` for that same instant. Redis barrier + `sync.js` +
   `GO` pub/sub are dropped.
3. **roomId handoff:** `prepare.js` writes `k6/room.json`; k6 reads it with
   `open()` at init. The VU path touches **zero** Redis.
4. **Scope:** VU runtime **and** orchestration (docker-compose, scripts, README).
5. **Cleanup:** Delete the now-dead files (see "Removed" below).

## Architecture & data flow

```
prepare.js  ──►  writes  k6/users.csv      (existing CSV format, unchanged)
                         k6/room.json       { "roomId": "<business room_id>" }  ← NEW
                                │
                  k6 run k6/loadtest.js     (single process, USER_COUNT VUs)
                                │
   setup():  fireAt = Date.now() + RAMP_MS + CONNECT_MARGIN_MS
             returns { fireAt }   ── shared to every VU (the k6-native barrier)
                                │
   each VU (executor: per-vu-iterations, vus=USER_COUNT, iterations=1):
     user  = users[(exec.vu.idInTest - 1) % users.length]   (globally unique)
     jitter: sleep(random * RAMP_S)        spread connects across the ramp window
     ws.connect(ws://nginx:8080/socket.io/?EIO=4&transport=websocket, {headers})
       on 'open'
         recv "0{sid,pingInterval,pingTimeout}"     Engine.IO OPEN
         send "40/chat,{\"token\":\"<accessToken>\"}" Socket.IO ns connect + auth
         recv "40/chat,{\"sid\":\"…\"}"               → check() connected
         send 42/chat,<ackId>["join",{roomId}]        → await "43" ack (join_time)
         socket.setTimeout(fire, max(0, fireAt - Date.now()))
       fire():
         send 42/chat,<ackId>["message:send",{roomId,type:"text",content,replyTo:""}]
           • await "43" ack            → ws_send_ack_* + check()
           • await "42 message:upsert" → ws_message_round_trip
       on 'message' "2" (Engine.IO PING) → send "3" (PONG)   keepalive
       after send: setTimeout(close, THINK_AFTER_GO * 1000)
       on 'error' / "44" connect_error → ws_connect_error / ws_exception
```

### Why `fireAt` gives true simultaneity

All VUs receive the **same** absolute timestamp from `setup()`. Each socket,
once joined, schedules its send via `socket.setTimeout(fire, fireAt - now)`.
`fireAt` is set far enough in the future (`RAMP_MS + CONNECT_MARGIN_MS`) that
every socket has connected and joined before it elapses. VUs that arrive late
(after `fireAt`) fire immediately (`max(0, …)`). No cross-process signaling
needed.

## Socket.IO / Engine.IO v4 framing (the core of the work)

Each WS text frame carries exactly one Engine.IO packet. First char = Engine.IO
packet type; for type `4` (MESSAGE) the remainder is a Socket.IO packet whose
first char is the Socket.IO type.

| Wire | Meaning | Action |
|---|---|---|
| `0{json}` | Engine.IO OPEN (sid, pingInterval, pingTimeout) | parse; then send the `40` connect |
| `40/chat,{auth}` → (send) | Socket.IO CONNECT to `/chat` with auth payload | sends the access token |
| `40/chat,{sid}` ← (recv) | CONNECT ack — namespace joined | mark connected |
| `42/chat,<id>[ev,arg]` | EVENT (with optional ack id) | emit (`join`, `message:send`) / receive (`message:upsert`) |
| `43/chat,<id>[arg]` | ACK for a prior event with id `<id>` | resolve pending ack handler |
| `44/chat,{err}` | CONNECT_ERROR (auth failure etc.) | count `ws_exception`, fail VU cleanly |
| `41/chat` | Socket.IO DISCONNECT | treat as close |
| `2` / `3` | Engine.IO PING / PONG (app-level text, **not** WS ping frame) | reply `3` to every `2` |

**Important:** socket.io's heartbeat is an application-level text message
handled in `socket.on('message')` (match `'2'`), **not** the WS-protocol ping
that `socket.on('ping')` would catch. Confirmed against k6/ws + Engine.IO v4.

Parsing a `42`/`43` packet: strip the Engine.IO `4` and the Socket.IO type
char, read an optional `/<namespace>,`, read optional leading digits (the ack
id), then `JSON.parse` the remaining array. Encoding mirrors this. An
incrementing per-socket ack-id counter pairs `42…<id>` emits with their `43…<id>`
replies via a pending-handler map.

## Components

| File | Change |
|---|---|
| `k6/socketio.js` | **NEW.** Pure helper module: `encodeConnect(ns, auth)`, `encodeEvent(ns, ackId, event, args)`, `parsePacket(raw)` → `{engineType, sioType, namespace, ackId, event, data}`, ack-id counter helper. No k6 imports → unit-testable under plain Node. |
| `k6/loadtest.js` | **NEW.** Main script. Init: `SharedArray` users from `users.csv`, `roomId` from `room.json`. `options.scenarios` = one `per-vu-iterations` (vus=`USER_COUNT`, iterations=1, `maxDuration`). `options.thresholds` for pass/fail. `setup()` returns `{ fireAt }`. `default(data)` runs the per-VU flow above. Custom metrics + `check()`. |
| `k6/probe.js` | **NEW.** Single-socket smoke (k6 equivalent of `artillery/probe-send.js`): connect → join → send one message → print ack + echo. Validates framing against the live backend before a full run. |
| `coordinator/prepare.js` | Add `writeRoomJson({ roomId })` → `k6/room.json` next to where it writes the CSV (CSV now lives in `k6/users.csv`). Remove the barrier/ready/userpick/`go:fired` Redis writes that only the old VU path consumed. Room creation, token refresh, CSV write unchanged. |
| `docker-compose.yml` | Replace `artillery` + `coordinator-sync` services with a single `k6` service using the official `grafana/k6` image (no build), bind-mounting `./k6:/scripts`, env from `.env`. Remove `coordinator-sync`. Redis container stays (still used by `bootstrap`/`reset` bookkeeping). |
| `scripts/run-test.ps1` | Rewrite: `up -d nginx redis` → build node image → run `prepare` → `k6 run /scripts/loadtest.js` (foreground; k6 prints its own end-of-test summary; optional `--summary-export k6/summary.json`). Drop sync start/stop and the Redis metric dump. |
| `README.md` | Update the diagram, file layout, metrics table, and run steps for k6. |

### Removed (dead after the switch)

- `artillery/processor.js`
- `artillery/scenario.yml`
- `coordinator/sync.js`
- `scripts/dump-metrics.js`
- `artillery` dependency in `package.json` (and `socket.io-client` if no other
  consumer remains — `artillery/probe-send.js` / `probe-room.js` are kept as
  Node debug tools and still use `socket.io-client`, so it stays).

### Config / env

`USER_COUNT`, `RAMP_DURATION`, `THINK_AFTER_GO`, `SOCKET_BASE`,
`SOCKET_NAMESPACE` carry over from `.env`. New (optional):
`CONNECT_MARGIN_MS` (default ~5000) — slack added to `fireAt` beyond the ramp
window so all sockets are joined before firing. These reach the k6 script via
`__ENV.*`.

## Metrics (k6-native, replacing Redis counters)

- **Trend:** `ws_connect_time`, `ws_join_time`, `ws_send_ack_time`,
  `ws_message_round_trip`.
- **Counter:** `ws_connected`, `ws_connect_error`, `ws_join_ack_ok`,
  `ws_join_ack_fail`, `ws_join_no_ack`, `ws_message_sent`, `ws_send_ack_ok`,
  `ws_send_ack_fail`, `ws_send_ack_timeout`, `ws_upsert_timeout`,
  `ws_exception`, `ws_disconnected`.
- **`check()`** (the requested import) gates: connected / join-acked /
  send-acked / echo-seen. `thresholds` (e.g. `checks: ['rate>0.95']`,
  `ws_message_round_trip: ['p(95)<…']`) turn these into a run pass/fail.

The old `ws.go_received*` counters disappear (no GO signal). A `ws_fired`
counter is added to confirm the simultaneous send fired.

## Error handling

- The VU flow never throws out of the iteration: connect failure, auth error
  (`44`), join no-ack, and send timeout each increment a counter, fail the
  relevant `check()`, and let the iteration end normally.
- Every `2` (Engine.IO ping) gets a `3` reply for the whole session so Cloud
  Run / the server don't drop the socket mid-test.
- `socket.setTimeout` guards: join-ack timeout (~5s), send-ack timeout (~15s),
  upsert-echo timeout (~15s), overall session close after `THINK_AFTER_GO`.

## Testing

- **Unit (TDD):** `k6/socketio.js` is pure string logic → tested under plain
  Node. Cases: parse `42/chat,3["message:upsert",{...}]` →
  `{sioType:2, namespace:'/chat', ackId:3, event:'message:upsert', data:{…}}`;
  parse `0{...}`, `40/chat,{sid}`, `43/chat,7[{ok:true}]`, `2`; round-trip
  `encodeEvent` → `parsePacket`.
- **Integration smoke:** `k6/probe.js` — one socket end-to-end against the live
  backend (validates the real handshake/auth/join/send path).
- **Load smoke:** `USER_COUNT=5 k6 run k6/loadtest.js` before the 1000 run.

## Open notes

- `test/` is **not** a git repository, so this spec cannot be committed. It is
  saved to `test/docs/superpowers/specs/`. (No `git init` without explicit ask.)
- k6's official image is `grafana/k6`; `k6/experimental/redis` is **not** used
  (VU path is Redis-free by decision #3).

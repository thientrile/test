# appchat — k6/ws load test

Stress-test the deployed chat backend (Cloud Run) over **raw WebSocket** with a
hand-rolled **Engine.IO v4 + Socket.IO** client (no socket.io-client, no
Artillery).

**Kịch bản khớp luồng FE thật** (`app-chat-fe` → `useMessageStore.sendMessage`):
sinh `id = new ObjectId()` → `emit("message:send", { roomId, type, content,
replyTo, id })` **không kèm ack** → coi là **gửi thành công** khi nhận
`message:upsert` echo cùng `id` **trong ≤ `DELIVER_WINDOW_MS` (mặc định 15s)**;
quá hạn → **FAILED** (đúng như `autoFailIfUnsent(roomId, id, 15000)` của FE).
Vì vậy "số tin gửi thành công" đo bằng **upsert echo ≤15s**, KHÔNG phải ack.

> ⚠️ Event thật là `message:send`. Bản cũ dùng `send_ask` — event này **không
> tồn tại** ở BE socket gateway, nên không phản ánh luồng thực tế.

Two profiles:

- **rate** (mặc định) — `constant-arrival-rate` at `RATE` msg/s for `DURATION` →
  đo **kết quả thực tế**: % tin gửi thành công + độ trễ giao tin ở tải thật.
- **burst** — `USER_COUNT` sockets all join one room and **send a message at the
  same instant** → đánh giá sức chịu tải đỉnh khi N người gửi cùng lúc.

```
                  ┌───────────────┐
                  │   Nginx :8080 │   (single test entry point, local)
                  └───────┬───────┘
                          │  /api/*        → api-gateway Cloud Run
                          │  /socket.io/*  → socket Cloud Run (WS upgrade)
                          ▼
              ┌────────────────────────────┐
              │ Cloud Run (asia-southeast1)│
              └────────────────────────────┘

bootstrap (1×)   →  register N users, cache creds in mongo test.loadtest_users
prepare (mỗi run) →  refresh tokens, create/reuse room, write k6/users.csv + k6/room.json
k6 (loadtest.js) →  N VU: connect → 40/chat,{token} → join → (fireAt) → send_ask
build-report     →  k6/reports/run-*.json → self-contained k6/reports/index.html
```

The k6 VU path is **Redis-free** — `roomId` and credentials arrive via the two
files `prepare` writes into `k6/`. There's no barrier/GO coordinator: burst
simultaneity comes from a single `fireAt` timestamp shared by `setup()`.

---

## Quick start (Docker — không cần cài k6)

```powershell
cd D:\CODE\appchat\test
docker compose up -d nginx redis

# 1. One-time: register USER_COUNT users (idempotent)
.\scripts\bootstrap.ps1

# 2. Run a test (prepare → k6 → build report → mở HTML)
.\scripts\run-test.ps1                                   # rate (mặc định), từ .env
$env:MODE='rate'; $env:RATE=50; $env:DURATION='60s'; .\scripts\run-test.ps1
$env:MODE='burst'; $env:USER_COUNT=500; .\scripts\run-test.ps1  # burst đỉnh

# 3. Cleanup (drop loadtest users + rooms)
.\scripts\reset.ps1 -DryRun   # preview
.\scripts\reset.ps1           # delete
```

The report opens automatically; re-open later with `npm run report:open` (mở
HTML tĩnh bằng browser, **không cần FE/server**).

---

## npm scripts

| Lệnh | Việc |
|---|---|
| `npm run bootstrap` | Đăng ký user → mongo |
| `npm run prepare` | Refresh token, tạo room, ghi `k6/users.csv` + `k6/room.json` |
| `npm run k6:run` | `k6 run k6/loadtest.js` (cần k6 cài local) |
| `npm run k6:docker` | Chạy k6 qua container `grafana/k6` |
| `npm run probe` | Smoke 1 socket với backend thật |
| `npm run probe:gateway` | Smoke `POST /api/auth/login` (1 req) |
| `npm run k6:gateway` | HTTP login load — 10k @ 50/s (~200s); giảm rate nếu fail cao |
| `npm run test:ai` | AI eval: latency p95/p99, hallucination (golden), token/cost mỗi request |
| `npm run test:ai:unit` | Unit test heuristic `ai-eval-lib` |
| `npm run report` | Build `index.html` từ history rồi mở browser |
| `npm run report:open` | Chỉ mở `k6/reports/index.html` (không cần server) |
| `npm run test:unit` | Unit-test framing `k6/socketio.js` (Node thuần) |
| `npm run test:report` | Unit-test `scripts/build-report.js` |
| `npm run reset` | Dọn user/room/redis |

---

## Modes & tuning (env vars / `.env`)

| Var | Default | Meaning |
|---|---|---|
| `MODE` | `rate` | `rate` (RATE msg/s — đo thực tế) hoặc `burst` (N cùng lúc) |
| `SEND_EVENT` | `message:send` | Event gửi tin **thật** của FE (socketEvent.MSGSEND) |
| `DELIVER_WINDOW_MS` | 15000 | Hạn nhận `message:upsert` echo để tính **gửi thành công** (= `autoFailIfUnsent` của FE) |
| `REQUEST_ACK` | 0 | `1` = đo thêm độ trễ ack gateway (chẩn đoán); `0` = giống FE (không ack) |
| `RATE` | 20 | Tin/giây (mode `rate`) |
| `DURATION` | `60s` | Thời lượng (mode `rate`) — 20/s × 60s = 1200 tin |
| `PRE_VUS` / `MAX_VUS` | 150 / 500 | VU pool cho `constant-arrival-rate` (peak ≈ RATE × 15s) |
| `USER_COUNT` | 500 | Pool user (rate dùng lại); = số VU/socket khi `burst` |
| `RAMP_DURATION` | 30 | Giây rải VU connect (burst) — cho Cloud Run autoscale |
| `CONNECT_MARGIN_MS` | 15000 | Đệm trước `fireAt` để mọi socket kịp join (burst) |
| `THINK_AFTER_GO` | 2 | Giây giữ socket sau khi gửi rồi đóng |
| `MSGS_PER_VU` | 1 | Số tin mỗi VU gửi (burst). 0 = chỉ giữ kết nối, không gửi |
| `SOCKET_BASE` | `ws://nginx:8080` | WS entry |
| `SOCKET_NAMESPACE` | `/chat` | Socket.IO namespace |

---

## File layout

```
test/
├── docker-compose.yml      # nginx + redis + node (bootstrap/prepare/reset) + k6
├── Dockerfile              # node image for bootstrap/prepare/reset
├── .env                    # user count, targets, mongo/redis URIs, prefixes
├── nginx/nginx.conf        # /api/ + /socket.io/ → Cloud Run, WS upgrade
├── lib/                    # shared: config, api (axios), mongo
├── bootstrap/index.js      # register OR login N users, save to mongo
├── coordinator/prepare.js  # refresh tokens, create room, write k6/users.csv + room.json
├── k6/
│   ├── socketio.js         # Engine.IO/Socket.IO framing (pure, unit-tested)
│   ├── socketio.test.js    # node --test
│   ├── loadtest.js         # main script (burst + rate), handleSummary → run JSON
│   ├── probe.js            # single-socket smoke
│   ├── users.csv           # (generated by prepare)
│   ├── room.json           # (generated by prepare)
│   └── reports/            # run-*.json + history.json + index.html
└── scripts/
    ├── build-report.js     # run-*.json → self-contained index.html
    ├── build-report.test.js
    ├── open-report.js      # open the HTML report (no server)
    ├── probe-room.js       # inspect a room's membership in mongo
    └── reset.js            # cleanup
```

---

## Metrics (k6 native + checks)

**Số kết nối thật** = `ws_connected` (socket hoàn tất EIO handshake + CONNECT
`/chat`) và `ws_join_ack_ok` (join room OK).

**Số tin gửi thành công (FE-accurate)** = `ws_msg_delivered` — tin nhận được
`message:upsert` echo cùng `id` trong ≤ `DELIVER_WINDOW_MS`. Ngược lại
`ws_msg_failed` (quá hạn hoặc socket đóng trước khi có echo). Luôn đúng:
`ws_message_sent = ws_msg_delivered + ws_msg_failed` (tin emit hụt vì socket đã
đóng đếm riêng ở `ws_send_skipped_disconnected`, không tính vào `ws_message_sent`).
(`ws_send_ask_ok`/`ws_upsert_timeout` giữ làm alias cho HTML report cũ.)

**Độ trễ đầy đủ** (`avg / min / med / p95 / p99 / max`) cho mọi chặng —
`Trend`: `ws_connect_time`, `ws_join_time`, `ws_msg_deliver_time` (= send →
`message:upsert` echo, **độ trễ giao tin UX thật**), `ws_message_round_trip`
(alias của deliver), và `ws_send_ack_time` (chỉ khi `REQUEST_ACK=1`).

`Counter` khác: `ws_connect_error`, `ws_connect_attempt_fail`, `ws_exception`,
`ws_fired`, `ws_close_unexpected`, `ws_server_disconnect`,
`ws_reconnect_attempt|success|exhausted`.
`check()` + `thresholds` (`checks: ['rate>0.90']`) gate connect/join/upgrade.

Each run → `k6/reports/run-<RUN_ID>.json`; `build-report.js` aggregates all runs
into `index.html` (latest-run cards + history table + SVG trend charts).

### AI eval (`npm run test:ai`)

Độ trễ báo cáo theo **p95 / p99** (cùng convention với k6 load test), gồm tổng
và từng `service`. Báo cáo JSON: `k6/reports/ai-eval-<timestamp>.json`.

| Env | Ý nghĩa |
|---|---|
| `AI_EVAL_BASE` | Gateway URL (mặc định `GATEWAY_PROBE_BASE`) |
| `AI_EVAL_USE_STREAM=1` | Dùng route SSE `/api/ai/stream/*` (thêm metric TTFB p95/p99) |
| `AI_EVAL_MAX_P95_MS` | Ngưỡng fail nếu p95 tổng vượt (tùy chọn) |
| `AI_EVAL_MAX_P99_MS` | Ngưỡng fail nếu p99 tổng vượt (tùy chọn) |

---

## Troubleshooting

**`connect_error` cao (~50%)** — trần kết nối socket service (Cloud Run
max-instances × concurrency). Đây là giới hạn THẬT, không phải bug test — tăng
`max-instances`/`concurrency` hoặc chấp nhận đây là capacity.

**`send_ack_timeout` cao / `send_ack_ok` = 0** — message path timeout ở gRPC
(`createMessage` trên room lớn vượt timeout 20s). Giảm room size hoặc tối ưu BE.

**Nginx 502 trên `/api/...`** — Host header Cloud Run. `nginx/nginx.conf` set
`Host: <service>.run.app` rõ ràng; đổi tên service phải sửa theo.

**Sockets stuck connect_error** — Cloud Run cần WS upgrade qua HTTPS; nginx
forward `Upgrade`/`Connection` + `proxy_ssl_server_name on`.
```
docker compose exec nginx wget -qO- http://127.0.0.1:8080/health
```

**Validate framing trước khi chạy full** — `npm run test:unit` (offline) rồi
`npm run probe` (1 socket thật) để tách lỗi protocol khỏi lỗi tải.
```
docker compose run --rm coordinator-prepare   # tạo room.json + users.csv
docker compose run --rm k6 run /scripts/probe.js
```

// appchat load test — raw k6/ws speaking Engine.IO v4 + Socket.IO (/chat).
//
// Two load profiles, selected via __ENV.MODE:
//
//   MODE=burst  (default) — USER_COUNT VUs each open a socket, join the room,
//     then ALL send their message at the SAME instant (a single `fireAt`
//     timestamp shared from setup()). Answers: "what happens when 1000 people
//     send at once?" (sức chịu tải đỉnh).
//
//   MODE=rate — constant-arrival-rate at RATE requests/sec for DURATION. Each
//     iteration = connect → join → send → close. Answers: "can the system
//     sustain 100 msg/s, and where does it break?" (cực hệ thống / throughput).
//
// Per-run metrics are written by handleSummary() to reports/run-<RUN_ID>.json;
// scripts/build-report.js turns those into the HTML report.

import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';
import exec from 'k6/execution';
import { SharedArray } from 'k6/data';

import {
  parsePacket,
  encodeConnect,
  encodeEvent,
  EIO_PONG,
} from './socketio.js';

// ---------------------------------------------------------------------------
// Config (from __ENV, with the same defaults as the old .env)
// ---------------------------------------------------------------------------
const MODE = (__ENV.MODE || 'burst').toLowerCase();
const USER_COUNT = parseInt(__ENV.USER_COUNT, 10) || 1000;
const RAMP_S = parseInt(__ENV.RAMP_DURATION, 10) || 30;
const CONNECT_MARGIN_MS = parseInt(__ENV.CONNECT_MARGIN_MS, 10) || 5000;
const THINK_MS = (parseInt(__ENV.THINK_AFTER_GO, 10) || 2) * 1000;

// Each VU sends MSGS_PER_VU messages, paced MSG_INTERVAL_MS apart. Default 1
// keeps the old single-send burst; set MSGS_PER_VU=100 for the flood test.
const MSGS_PER_VU = parseInt(__ENV.MSGS_PER_VU, 10) || 1;
const MSG_INTERVAL_MS = parseInt(__ENV.MSG_INTERVAL_MS, 10) || 100;
const FLOOD_MS = MSGS_PER_VU * MSG_INTERVAL_MS;

// rate-mode knobs
const RATE = parseInt(__ENV.RATE, 10) || 100; // requests/sec
const DURATION = __ENV.DURATION || '10s'; // 100/s × 10s ≈ 1000 requests
const PRE_VUS = parseInt(__ENV.PRE_VUS, 10) || 200;
const MAX_VUS = parseInt(__ENV.MAX_VUS, 10) || 600;

const SOCKET_BASE = __ENV.SOCKET_BASE || 'ws://nginx:8080';
const NAMESPACE = __ENV.SOCKET_NAMESPACE || '/chat';
const WS_URL = `${SOCKET_BASE}/socket.io/?EIO=4&transport=websocket`;

const RUN_ID = __ENV.RUN_ID || `${Date.now()}`;

const JOIN_ACK_TIMEOUT_MS = 5000;
const SEND_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------------
// Init-context data: users.csv + room.json (resolved relative to THIS script)
// ---------------------------------------------------------------------------
const USERS = new SharedArray('users', () => parseCsv(open('./users.csv')));
// Fallback room (first room) if a user row has no roomId — each user normally
// carries its OWN room (users are sharded into many small rooms).
const FALLBACK_ROOM = JSON.parse(open('./room.json')).roomId;

function parseCsv(raw) {
  const lines = raw.trim().split(/\r?\n/);
  lines.shift(); // header: username,password,accessToken,userId,fullname,roomId
  return lines.map((line) => {
    const [username, password, accessToken, userId, fullname, roomId] = parseCsvLine(line);
    return { username, password, accessToken, userId, fullname, roomId };
  });
}

// Minimal CSV parser matching prepare.js's csvEscape (quote-escaping).
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// 24-hex ObjectId-shaped client message id (FE generates one per message; BE
// uses it as the message _id). Lets us match a message:upsert echo back to the
// exact send for an accurate round-trip even when 100 msgs are in flight.
function oid() {
  const ts = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0');
  let rest = '';
  for (let i = 0; i < 16; i++) rest += Math.floor(Math.random() * 16).toString(16);
  return ts + rest;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------
const mConnectTime = new Trend('ws_connect_time', true);
const mJoinTime = new Trend('ws_join_time', true);
const mSendAckTime = new Trend('ws_send_ack_time', true);
const mRoundTrip = new Trend('ws_message_round_trip', true);

const cConnected = new Counter('ws_connected');
const cConnectError = new Counter('ws_connect_error');
const cException = new Counter('ws_exception');
const cJoinAckOk = new Counter('ws_join_ack_ok');
const cJoinAckFail = new Counter('ws_join_ack_fail');
const cJoinNoAck = new Counter('ws_join_no_ack');
const cFired = new Counter('ws_fired');
const cMsgSent = new Counter('ws_message_sent');
const cSendAckOk = new Counter('ws_send_ack_ok');
const cSendAckFail = new Counter('ws_send_ack_fail');
const cSendAckTimeout = new Counter('ws_send_ack_timeout');
const cUpsertTimeout = new Counter('ws_upsert_timeout');
const cDisconnected = new Counter('ws_disconnected');

// ---------------------------------------------------------------------------
// Scenario / options — chosen by MODE
// ---------------------------------------------------------------------------
const burstMaxDuration =
  RAMP_S +
  Math.ceil(CONNECT_MARGIN_MS / 1000) +
  Math.ceil(FLOOD_MS / 1000) +
  Math.ceil(SEND_TIMEOUT_MS / 1000) +
  Math.ceil(THINK_MS / 1000) +
  30;

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(95)', 'p(99)'],
  thresholds: {
    checks: ['rate>0.90'],
  },
  scenarios:
    MODE === 'rate'
      ? {
          rate: {
            executor: 'constant-arrival-rate',
            rate: RATE,
            timeUnit: '1s',
            duration: DURATION,
            preAllocatedVUs: PRE_VUS,
            maxVUs: MAX_VUS,
          },
        }
      : {
          burst: {
            executor: 'per-vu-iterations',
            vus: USER_COUNT,
            iterations: 1,
            maxDuration: `${burstMaxDuration}s`,
          },
        },
};

// ---------------------------------------------------------------------------
// setup() — the k6-native "barrier": one fireAt shared to every VU.
//   burst → all sockets fire at now + ramp + margin (after everyone joined)
//   rate  → fireAt = 0, every iteration sends immediately (executor paces it)
// ---------------------------------------------------------------------------
export function setup() {
  const fireAt = MODE === 'rate' ? 0 : Date.now() + RAMP_S * 1000 + CONNECT_MARGIN_MS;
  return { fireAt };
}

// ---------------------------------------------------------------------------
// VU iteration
// ---------------------------------------------------------------------------
export default function (data) {
  const user = USERS[(exec.vu.idInTest - 1) % USERS.length];
  const token = String(user.accessToken || '').replace(/^"|"$/g, '').trim();
  const roomId = String(user.roomId || FALLBACK_ROOM || '').replace(/^"|"$/g, '').trim();
  if (!token || !roomId) {
    cConnectError.add(1);
    return;
  }

  // burst: jitter connects across the ramp window so they don't all land at
  // once. rate: the executor already paces arrivals — no jitter.
  if (MODE !== 'rate' && RAMP_S > 0) {
    sleep(Math.random() * RAMP_S);
  }

  const t0 = Date.now();
  let ackId = 0;
  const pending = {};
  let connected = false;
  let joined = false;
  let sawException = false;
  let closing = false;

  const res = ws.connect(WS_URL, { tags: { mode: MODE } }, function (socket) {
    let fireStarted = false;
    let sent = 0; // messages queued by this VU
    let ackedCount = 0; // message:send acks received
    let upsertCount = 0; // own message:upsert echoes matched
    const rtPending = {}; // clientMsgId -> sentAt (round-trip matching)

    function emit(event, arg, onAck) {
      const id = onAck ? ++ackId : null;
      if (onAck) pending[id] = onAck;
      socket.send(encodeEvent(NAMESPACE, id, event, [arg]));
    }

    // k6's socket.setTimeout REQUIRES a strictly-positive delay (0 throws a
    // GoError). A VU that connects at/after fireAt — or any iteration in
    // rate mode where fireAt=0 — would compute delay 0, so clamp to ≥1ms.
    function later(fn, ms) {
      socket.setTimeout(fn, ms > 0 ? ms : 1);
    }

    function doClose() {
      if (closing) return;
      closing = true;
      // Account for whatever never came back before we close (over the whole
      // flood, not per-message): sent-but-unacked, and sent-without-echo.
      if (fireStarted) {
        cSendAckTimeout.add(Math.max(0, sent - ackedCount));
        cUpsertTimeout.add(Math.max(0, sent - upsertCount));
      }
      socket.close();
    }

    // Send the next message in the flood, then schedule the one after it.
    function sendOne() {
      if (sent >= MSGS_PER_VU) {
        // All queued — wait a grace window for outstanding acks/echoes, close.
        later(doClose, SEND_TIMEOUT_MS + THINK_MS);
        return;
      }
      sent += 1;
      const msgId = oid();
      const at = Date.now();
      rtPending[msgId] = at;
      cMsgSent.add(1);
      emit(
        'message:send',
        {
          roomId: roomId,
          type: 'text',
          content: user.fullname || 'k6',
          replyTo: '',
          id: msgId,
        },
        function (ackArgs) {
          ackedCount += 1;
          const ok = ackArgs && ackArgs[0] ? ackArgs[0].ok !== false : true;
          if (ok) cSendAckOk.add(1);
          else cSendAckFail.add(1);
          mSendAckTime.add(Date.now() - at);
        },
      );
      later(sendOne, MSG_INTERVAL_MS);
    }

    function fire() {
      if (!connected) return; // never got connected — nothing to send
      fireStarted = true;
      cFired.add(1);
      sendOne();
    }

    socket.on('message', function (raw) {
      const p = parsePacket(raw);
      switch (p.type) {
        case 'open':
          // Engine.IO handshake done → connect to /chat with the auth token.
          socket.send(encodeConnect(NAMESPACE, { token }));
          break;
        case 'ping':
          socket.send(EIO_PONG); // keep the socket alive for the whole session
          break;
        case 'connect': {
          connected = true;
          cConnected.add(1);
          mConnectTime.add(Date.now() - t0);
          const joinAt = Date.now();
          emit('join', { roomId: roomId }, function (ackArgs) {
            joined = true;
            const ok = ackArgs && ackArgs[0] ? ackArgs[0].ok !== false : true;
            if (ok) cJoinAckOk.add(1);
            else cJoinAckFail.add(1);
            mJoinTime.add(Date.now() - joinAt);
          });
          later(function () {
            if (!joined) cJoinNoAck.add(1);
          }, JOIN_ACK_TIMEOUT_MS);
          // Schedule the send. burst → at fireAt; rate → immediately (delay clamped ≥1ms).
          later(fire, data.fireAt - Date.now());
          break;
        }
        case 'ack': {
          const h = p.ackId != null ? pending[p.ackId] : null;
          if (h) {
            delete pending[p.ackId];
            h(p.args);
          }
          break;
        }
        case 'event':
          if (p.event === 'message:upsert') {
            // Broadcast to every room member — only match echoes of OUR sends
            // (by the client id we generated) to measure true round-trip.
            const m = p.args && p.args[0] ? p.args[0] : null;
            const mid = m ? String(m._id || m.id || '') : '';
            if (mid && rtPending[mid] != null) {
              mRoundTrip.add(Date.now() - rtPending[mid]);
              delete rtPending[mid];
              upsertCount += 1;
            }
          }
          break;
        case 'connect_error':
          sawException = true;
          cException.add(1);
          doClose();
          break;
        case 'disconnect':
        case 'engine_close':
          doClose();
          break;
      }
    });

    socket.on('close', function () {
      cDisconnected.add(1);
    });

    socket.on('error', function (e) {
      // "websocket: close sent" is the normal close path — ignore it.
      if (e && typeof e.error === 'function' && e.error() === 'websocket: close sent') return;
    });

    // Absolute safety net so a stuck socket never holds the VU open forever.
    // Time remaining to fireAt (clamped ≥0) + the whole flood + post-send budget.
    later(
      doClose,
      Math.max(0, data.fireAt - Date.now()) + FLOOD_MS + SEND_TIMEOUT_MS + THINK_MS + 10000,
    );
  });

  check(res, { 'ws upgrade 101': (r) => r && r.status === 101 });
  if (!connected && !sawException) cConnectError.add(1);
  check(connected, { 'socket connected': (c) => c === true });
  check(joined, { 'room joined': (j) => j === true });
}

// ---------------------------------------------------------------------------
// handleSummary — write the machine-readable run file + a concise console
// summary. build-report.js aggregates reports/run-*.json into the HTML report.
// ---------------------------------------------------------------------------
export function handleSummary(data) {
  const run = extractRun(data);
  const out = {};
  out[`reports/run-${RUN_ID}.json`] = JSON.stringify(run, null, 2);
  out.stdout = consoleSummary(run);
  return out;
}

function extractRun(data) {
  const M = data.metrics || {};
  const counter = (name) => (M[name] && M[name].values ? M[name].values.count || 0 : 0);
  const trend = (name) => {
    const v = M[name] && M[name].values ? M[name].values : {};
    return {
      avg: round(v.avg),
      med: round(v.med),
      p95: round(v['p(95)']),
      p99: round(v['p(99)']),
      max: round(v.max),
    };
  };

  const checks = [];
  walkChecks(data.root_group, '', checks);

  return {
    runId: RUN_ID,
    timestamp: new Date().toISOString(),
    mode: MODE,
    config: {
      mode: MODE,
      userCount: USER_COUNT,
      msgsPerVu: MSGS_PER_VU,
      msgIntervalMs: MSG_INTERVAL_MS,
      rampDuration: RAMP_S,
      connectMarginMs: CONNECT_MARGIN_MS,
      thinkAfterGo: THINK_MS / 1000,
      rate: MODE === 'rate' ? RATE : null,
      duration: MODE === 'rate' ? DURATION : null,
      socketBase: SOCKET_BASE,
      namespace: NAMESPACE,
    },
    durationMs: data.state ? Math.round(data.state.testRunDurationMs) : 0,
    checks: {
      overallRate: M.checks && M.checks.values ? M.checks.values.rate : 0,
      items: checks,
    },
    trends: {
      ws_connect_time: trend('ws_connect_time'),
      ws_join_time: trend('ws_join_time'),
      ws_send_ack_time: trend('ws_send_ack_time'),
      ws_message_round_trip: trend('ws_message_round_trip'),
    },
    counters: {
      ws_connected: counter('ws_connected'),
      ws_connect_error: counter('ws_connect_error'),
      ws_exception: counter('ws_exception'),
      ws_join_ack_ok: counter('ws_join_ack_ok'),
      ws_join_ack_fail: counter('ws_join_ack_fail'),
      ws_join_no_ack: counter('ws_join_no_ack'),
      ws_fired: counter('ws_fired'),
      ws_message_sent: counter('ws_message_sent'),
      ws_send_ack_ok: counter('ws_send_ack_ok'),
      ws_send_ack_fail: counter('ws_send_ack_fail'),
      ws_send_ack_timeout: counter('ws_send_ack_timeout'),
      ws_upsert_timeout: counter('ws_upsert_timeout'),
      ws_disconnected: counter('ws_disconnected'),
    },
  };
}

function walkChecks(group, prefix, out) {
  if (!group) return;
  for (const c of group.checks || []) {
    out.push({ name: c.name, passes: c.passes || 0, fails: c.fails || 0 });
  }
  for (const g of group.groups || []) walkChecks(g, prefix, out);
}

function round(n) {
  if (n == null || Number.isNaN(n)) return 0;
  return Math.round(n * 100) / 100;
}

function consoleSummary(run) {
  const c = run.counters;
  const rt = run.trends.ws_message_round_trip;
  const sa = run.trends.ws_send_ack_time;
  const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) : '0.0');
  const L = [];
  L.push('');
  L.push('================ k6 LOADTEST SUMMARY ================');
  L.push(`  mode=${run.mode}  run=${run.runId}  dur=${(run.durationMs / 1000).toFixed(1)}s`);
  L.push('  CONNECT');
  L.push(`    connected:        ${c.ws_connected}`);
  L.push(`    connect_error:    ${c.ws_connect_error}`);
  L.push(`    exception:        ${c.ws_exception}`);
  L.push('  JOIN');
  L.push(`    join_ack_ok:      ${c.ws_join_ack_ok}`);
  L.push(`    join_ack_fail:    ${c.ws_join_ack_fail}`);
  L.push(`    join_no_ack:      ${c.ws_join_no_ack}`);
  L.push('  SEND');
  L.push(`    fired:            ${c.ws_fired}`);
  L.push(`    message_sent:     ${c.ws_message_sent}`);
  L.push(`    send_ack_ok:      ${c.ws_send_ack_ok} (${pct(c.ws_send_ack_ok, c.ws_message_sent)}%)`);
  L.push(`    send_ack_fail:    ${c.ws_send_ack_fail}`);
  L.push(`    send_ack_timeout: ${c.ws_send_ack_timeout}`);
  L.push(`    upsert_timeout:   ${c.ws_upsert_timeout}`);
  L.push('  LATENCY (ms)');
  L.push(`    send_ack    p95=${sa.p95}  p99=${sa.p99}  max=${sa.max}`);
  L.push(`    round_trip  p95=${rt.p95}  p99=${rt.p99}  max=${rt.max}`);
  L.push(`  checks pass: ${(run.checks.overallRate * 100).toFixed(1)}%`);
  L.push(`  → reports/run-${run.runId}.json`);
  L.push('=====================================================');
  L.push('');
  return L.join('\n');
}

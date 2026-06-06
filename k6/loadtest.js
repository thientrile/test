// appchat load test — raw k6/ws speaking Engine.IO v4 + Socket.IO (/chat).
//
// This script mirrors the REAL frontend chat flow (app-chat-fe):
//   1. open socket, Engine.IO handshake → CONNECT /chat with the auth token
//   2. emit `join` { roomId }
//   3. emit `message:send` { roomId, type:'text', content, replyTo:'', id }
//        - `id` is a 24-hex ObjectId the client generates (FE:
//          `new ObjectId().toHexString()` in useMessageStore.sendMessage)
//        - the FE does NOT rely on the socket.io ack. It shows the message as
//          SENDING, then calls autoFailIfUnsent(roomId, id, 15000): if a
//          `message:upsert` echo carrying the same `id` arrives within 15s the
//          message flips to SENT (success); otherwise it is marked FAILED.
//
// THEREFORE the load test's definition of "tin nhắn gửi thành công" is
// FE-accurate: a message is DELIVERED iff its `message:upsert` echo is received
// within DELIVER_WINDOW_MS (default 15000ms). The gateway ack is captured only
// as a secondary diagnostic (REQUEST_ACK) — it does not decide success.
//
// Two load profiles, selected via __ENV.MODE:
//
//   MODE=rate  (default) — constant-arrival-rate at RATE messages/sec for
//     DURATION. Each iteration = connect → join → send 1 message → wait up to
//     DELIVER_WINDOW_MS for the upsert → close. Answers: "ở tải thật N msg/s,
//     bao nhiêu % tin được gửi thành công và độ trễ giao tin là bao nhiêu?"
//     (throughput bền vững / kết quả thực tế).
//
//   MODE=burst — USER_COUNT VUs each open a socket, join, then ALL send at the
//     SAME instant (a single `fireAt` shared from setup()). Answers: "what
//     happens when N people send at once?" (sức chịu tải đỉnh).
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
const MODE = (__ENV.MODE || 'rate').toLowerCase();
const USER_COUNT = parseInt(__ENV.USER_COUNT, 10) || 1000;
const RAMP_S = parseInt(__ENV.RAMP_DURATION, 10) || 30;
const CONNECT_MARGIN_MS = parseInt(__ENV.CONNECT_MARGIN_MS, 10) || 5000;
const THINK_MS = (parseInt(__ENV.THINK_AFTER_GO, 10) || 2) * 1000;

// Each VU sends MSGS_PER_VU messages, paced MSG_INTERVAL_MS apart. Default 1
// keeps the old single-send burst; set MSGS_PER_VU=100 for the flood test.
// Set MSGS_PER_VU=0 to hold connected sockets without sending messages.
const MSGS_PER_VU = Number.isFinite(parseInt(__ENV.MSGS_PER_VU, 10))
  ? parseInt(__ENV.MSGS_PER_VU, 10)
  : 1;
const MSG_INTERVAL_MS = parseInt(__ENV.MSG_INTERVAL_MS, 10) || 100;
const FLOOD_MS = MSGS_PER_VU * MSG_INTERVAL_MS;
const HOLD_MS = (parseInt(__ENV.HOLD_SECONDS, 10) || 0) * 1000;

// rate-mode knobs
const RATE = parseInt(__ENV.RATE, 10) || 100; // requests/sec
const DURATION = __ENV.DURATION || '10s'; // 100/s × 10s ≈ 1000 requests
const PRE_VUS = parseInt(__ENV.PRE_VUS, 10) || 200;
const MAX_VUS = parseInt(__ENV.MAX_VUS, 10) || 600;

const SOCKET_BASE = __ENV.SOCKET_BASE || 'ws://nginx:8080';
const NAMESPACE = __ENV.SOCKET_NAMESPACE || '/chat';
// The REAL chat-message event the FE emits (socketEvent.MSGSEND). The old
// default `send_ask` is NOT handled by the BE socket gateway at all.
const SEND_EVENT = __ENV.SEND_EVENT || 'message:send';
// FE success deadline: useMessageStore.autoFailIfUnsent(roomId, id, 15000).
// A message counts as DELIVERED only if its message:upsert echo arrives within
// this window — exactly how the real client decides SENT vs FAILED.
const DELIVER_WINDOW_MS = parseInt(__ENV.DELIVER_WINDOW_MS, 10) || 15000;
// The FE emits message:send WITHOUT an ack callback. We keep the ability to
// request the gateway ack purely as a server-side latency diagnostic; it does
// NOT change the message path and does NOT decide success. Default off to match
// the real client exactly; set REQUEST_ACK=1 to also measure gateway ack time.
const REQUEST_ACK = (__ENV.REQUEST_ACK || '0') === '1';
const WS_URL = `${SOCKET_BASE}/socket.io/?EIO=4&transport=websocket`;

const RUN_ID = __ENV.RUN_ID || `${Date.now()}`;

const JOIN_ACK_TIMEOUT_MS = 5000;
const SEND_TIMEOUT_MS = 15000;
const RECONNECT = (__ENV.RECONNECT || '1') !== '0';
const MAX_RECONNECTS = parseInt(__ENV.MAX_RECONNECTS, 10) || 20;
const RECONNECT_DELAY_MS = parseInt(__ENV.RECONNECT_DELAY_MS, 10) || 1000;
const RECONNECT_JITTER_MS = parseInt(__ENV.RECONNECT_JITTER_MS, 10) || 1000;

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
// ws_message_round_trip = send → own message:upsert echo (the FE "delivered"
// latency, i.e. the real time-to-SENT a user perceives).
const mRoundTrip = new Trend('ws_message_round_trip', true);
const mDeliverTime = new Trend('ws_msg_deliver_time', true);

const cConnected = new Counter('ws_connected');
const cConnectError = new Counter('ws_connect_error');
const cConnectAttemptFail = new Counter('ws_connect_attempt_fail');
const cException = new Counter('ws_exception');
const cJoinAckOk = new Counter('ws_join_ack_ok');
const cJoinAckFail = new Counter('ws_join_ack_fail');
const cJoinNoAck = new Counter('ws_join_no_ack');
const cFired = new Counter('ws_fired');
const cMsgSent = new Counter('ws_message_sent');
// FE-accurate success: a message is DELIVERED iff its message:upsert echo
// arrives within DELIVER_WINDOW_MS, else FAILED (mirrors autoFailIfUnsent).
const cMsgDelivered = new Counter('ws_msg_delivered');
const cMsgFailed = new Counter('ws_msg_failed');
// Legacy aliases kept so the existing HTML report keeps rendering. Incremented
// in lockstep with delivered/failed above. ws_send_ask_ok == delivered,
// ws_upsert_timeout == failed.
const cSendAskOk = new Counter('ws_send_ask_ok');
const cSendSkippedDisconnected = new Counter('ws_send_skipped_disconnected');
const cSendAckOk = new Counter('ws_send_ack_ok');
const cSendAckFail = new Counter('ws_send_ack_fail');
const cSendAckTimeout = new Counter('ws_send_ack_timeout');
const cUpsertTimeout = new Counter('ws_upsert_timeout');
const cDisconnected = new Counter('ws_disconnected');
const cCloseExpected = new Counter('ws_close_expected');
const cCloseUnexpected = new Counter('ws_close_unexpected');
const cServerDisconnect = new Counter('ws_server_disconnect');
const cReconnectAttempt = new Counter('ws_reconnect_attempt');
const cReconnectSuccess = new Counter('ws_reconnect_success');
const cReconnectExhausted = new Counter('ws_reconnect_exhausted');

// Record one delivered message (upsert echo received within DELIVER_WINDOW_MS).
function markDelivered(latencyMs) {
  // Clamp: a negative round-trip is physically impossible (rare cross-callback
  // clock skew in the k6 ws event loop) — don't let it poison min/avg.
  const lat = latencyMs > 0 ? latencyMs : 0;
  cMsgDelivered.add(1);
  cSendAskOk.add(1); // legacy alias for the HTML report
  mDeliverTime.add(lat);
  mRoundTrip.add(lat);
}

// Record one failed message (no upsert echo within DELIVER_WINDOW_MS, or the
// socket closed before the echo arrived — exactly the FE "FAILED" condition).
function markFailed(n) {
  const k = n || 1;
  cMsgFailed.add(k);
  cUpsertTimeout.add(k); // legacy alias for the HTML report
}

// ---------------------------------------------------------------------------
// Scenario / options — chosen by MODE
// ---------------------------------------------------------------------------
const burstMaxDuration =
  RAMP_S +
  Math.ceil(CONNECT_MARGIN_MS / 1000) +
  Math.ceil(FLOOD_MS / 1000) +
  Math.ceil(HOLD_MS / 1000) +
  Math.ceil(DELIVER_WINDOW_MS / 1000) + // wait out the last message's 15s deadline
  Math.ceil(THINK_MS / 1000) +
  30;

export const options = {
  // 'count' MUST be here: k6 only puts the listed stats into a Trend's summary
  // `values` object. Without 'count', handleSummary sees no count and every
  // latency reads as 0 samples even though the metric recorded data.
  summaryTrendStats: ['count', 'avg', 'min', 'med', 'max', 'p(95)', 'p(99)'],
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

  const holdDeadline = HOLD_MS > 0 ? data.fireAt + HOLD_MS : 0;
  let attempt = 0;
  let everConnected = false;
  let everJoined = false;
  let anyUpgrade = false;
  let finalConnectError = false;

  while (true) {
    if (attempt > 0) {
      cReconnectAttempt.add(1);
      sleep((RECONNECT_DELAY_MS + Math.random() * RECONNECT_JITTER_MS) / 1000);
      if (holdDeadline && Date.now() >= holdDeadline) break;
    }

    const result = runSocketAttempt(data, user, token, roomId, holdDeadline, attempt);
    anyUpgrade = anyUpgrade || result.upgraded;
    everConnected = everConnected || result.connected;
    everJoined = everJoined || result.joined;
    if (attempt > 0 && result.connected) cReconnectSuccess.add(1);

    if (result.finishedByDeadline) break;
    if (!result.shouldReconnect) break;
    if (!RECONNECT || attempt >= MAX_RECONNECTS) {
      cReconnectExhausted.add(1);
      finalConnectError = true;
      break;
    }
    if (holdDeadline && Date.now() >= holdDeadline) break;
    attempt += 1;
  }

  if (!everConnected) finalConnectError = true;
  if (finalConnectError) cConnectError.add(1);

  check(anyUpgrade, { 'ws upgrade 101': (ok) => ok === true });
  check(everConnected, { 'socket connected': (c) => c === true });
  check(everJoined, { 'room joined': (j) => j === true });
}

function runSocketAttempt(data, user, token, roomId, holdDeadline, attemptNo) {
  const t0 = Date.now();
  let ackId = 0;
  const pending = {};
  let connected = false;
  let joined = false;
  let sawException = false;
  let closing = false;
  let closeExpected = false;
  let serverDisconnected = false;
  let closeUnexpected = false;

  const res = ws.connect(WS_URL, { tags: { mode: MODE } }, function (socket) {
    let socketOpen = true;
    let fireStarted = false;
    let sent = 0; // messages queued by this VU
    let ackedCount = 0; // send event acks received
    let upsertCount = 0; // own message:upsert echoes matched
    const rtPending = {}; // clientMsgId -> sentAt (round-trip matching)

    function emit(event, arg, onAck) {
      if (!socketOpen || closing || serverDisconnected) return false;
      const id = onAck ? ++ackId : null;
      if (onAck) pending[id] = onAck;
      try {
        socket.send(encodeEvent(NAMESPACE, id, event, [arg]));
      } catch {
        if (onAck) delete pending[id];
        return false;
      }
      return true;
    }

    // k6's socket.setTimeout REQUIRES a strictly-positive delay (0 throws a
    // GoError). A VU that connects at/after fireAt — or any iteration in
    // rate mode where fireAt=0 — would compute delay 0, so clamp to ≥1ms.
    function later(fn, ms) {
      socket.setTimeout(fn, ms > 0 ? ms : 1);
    }

    function doClose(expected) {
      if (closing) return;
      closing = true;
      closeExpected = expected !== false && !serverDisconnected;
      // Any message still pending its upsert at close never delivered (the
      // socket dropped before the echo / before its 15s deadline fired) → FAILED,
      // matching the FE marking the optimistic message FAILED. Delivered and
      // already-timed-out messages were removed from rtPending, so no double count.
      const stillPending = Object.keys(rtPending);
      if (stillPending.length) {
        markFailed(stillPending.length);
        for (const k of stillPending) delete rtPending[k];
      }
      // Gateway-ack diagnostic (only meaningful when REQUEST_ACK=1).
      if (fireStarted && REQUEST_ACK) {
        cSendAckTimeout.add(Math.max(0, sent - ackedCount));
      }
      socket.close();
    }

    // Send the next message in the flood, then schedule the one after it.
    function sendOne() {
      if (!socketOpen || closing || serverDisconnected) {
        cSendSkippedDisconnected.add(1);
        return;
      }
      if (sent >= MSGS_PER_VU) {
        // All queued — hold the socket open long enough for the LAST message's
        // delivery deadline (15s) to resolve, then close. This is what lets us
        // observe upsert-within-15s exactly like the FE does.
        later(function () {
          doClose(true);
        }, DELIVER_WINDOW_MS + THINK_MS + HOLD_MS + 1000);
        return;
      }
      const msgId = oid();
      const at = Date.now();
      // Match the real FE payload (useMessageStore.sendMessage). The FE emits
      // WITHOUT an ack callback; we attach one only when REQUEST_ACK=1 for
      // server-side latency diagnostics — it does not affect success.
      const onAck = REQUEST_ACK
        ? function (ackArgs) {
            ackedCount += 1;
            const ok = ackArgs && ackArgs[0] ? ackArgs[0].ok !== false : true;
            if (ok) cSendAckOk.add(1);
            else cSendAckFail.add(1);
            mSendAckTime.add(Date.now() - at);
          }
        : null;
      const emitted = emit(
        SEND_EVENT,
        {
          roomId: roomId,
          type: 'text',
          content: 'loadtest message',
          replyTo: '',
          id: msgId,
        },
        onAck,
      );
      if (!emitted) {
        cSendSkippedDisconnected.add(1);
        return;
      }
      sent += 1;
      rtPending[msgId] = at;
      cMsgSent.add(1);
      // FE-accurate per-message deadline: if no message:upsert echo for this id
      // within DELIVER_WINDOW_MS, mark it FAILED (autoFailIfUnsent). If the
      // echo arrives first it deletes rtPending[msgId], so this is a no-op.
      later(function () {
        if (rtPending[msgId] != null) {
          delete rtPending[msgId];
          markFailed(1);
        }
      }, DELIVER_WINDOW_MS);
      later(sendOne, MSG_INTERVAL_MS);
    }

    function fire() {
      if (!connected || !socketOpen || closing || serverDisconnected) {
        cSendSkippedDisconnected.add(1);
        return;
      }
      fireStarted = true;
      cFired.add(1);
      if (MSGS_PER_VU <= 0) {
        const holdFor = holdDeadline ? Math.max(1, holdDeadline - Date.now()) : Math.max(HOLD_MS, THINK_MS);
        later(function () {
          doClose(true);
        }, holdFor);
        return;
      }
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
          mConnectTime.add(Math.max(0, Date.now() - t0));
          const joinAt = Date.now();
          emit('join', { roomId: roomId }, function (ackArgs) {
            joined = true;
            const ok = ackArgs && ackArgs[0] ? ackArgs[0].ok !== false : true;
            if (ok) cJoinAckOk.add(1);
            else cJoinAckFail.add(1);
            mJoinTime.add(Math.max(0, Date.now() - joinAt));
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
            // The BE broadcasts message:upsert to every room member. We only
            // match echoes of OUR OWN sends (by the client id we generated) and
            // only if they arrive before the 15s deadline already failed them —
            // exactly the condition under which the FE flips SENDING → SENT.
            const m = p.args && p.args[0] ? p.args[0] : null;
            const mid = messageIdOf(m);
            if (mid && rtPending[mid] != null) {
              markDelivered(Date.now() - rtPending[mid]);
              delete rtPending[mid];
              upsertCount += 1;
            }
          }
          break;
        case 'connect_error':
          sawException = true;
          cException.add(1);
          doClose(false);
          break;
        case 'disconnect':
        case 'engine_close':
          serverDisconnected = true;
          cServerDisconnect.add(1);
          doClose(false);
          break;
      }
    });

    socket.on('close', function () {
      socketOpen = false;
      cDisconnected.add(1);
      if (closeExpected) cCloseExpected.add(1);
      else {
        closeUnexpected = true;
        cCloseUnexpected.add(1);
      }
    });

    socket.on('error', function (e) {
      // "websocket: close sent" is the normal close path — ignore it.
      if (e && typeof e.error === 'function' && e.error() === 'websocket: close sent') return;
    });

    // Absolute safety net so a stuck socket never holds the VU open forever.
    // Time remaining to fireAt (clamped ≥0) + the whole flood + post-send budget.
    later(
      function () {
        doClose(false);
      },
      Math.max(0, data.fireAt - Date.now()) +
        FLOOD_MS +
        HOLD_MS +
        DELIVER_WINDOW_MS +
        THINK_MS +
        10000,
    );
  });

  if (!connected && !sawException) cConnectAttemptFail.add(1);

  const upgraded = !!(res && res.status === 101);
  const finishedByDeadline = !!(holdDeadline && Date.now() >= holdDeadline && closeExpected);
  const withinHold = holdDeadline && Date.now() < holdDeadline;
  const shouldReconnect = withinHold && (closeUnexpected || serverDisconnected || !connected || !joined);

  return {
    upgraded,
    connected,
    joined,
    finishedByDeadline,
    shouldReconnect,
    attemptNo,
  };
}

function messageIdOf(m) {
  if (!m || typeof m !== 'object') return '';
  const nested = m.message && typeof m.message === 'object' ? m.message : null;
  return String(
    m._id ||
      m.id ||
      m.messageId ||
      m.msgId ||
      m.clientMsgId ||
      m.clientMessageId ||
      (nested ? nested._id || nested.id || nested.messageId || nested.msgId || nested.clientMsgId || nested.clientMessageId : '') ||
      '',
  );
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
    // Has samples if k6 gave us a count, OR (older/looser builds) any stat is a
    // real number. Don't gate purely on count — some k6 versions omit it.
    const hasData =
      (v.count || 0) > 0 ||
      ['avg', 'med', 'max', 'min', 'p(95)', 'p(99)'].some((k) => typeof v[k] === 'number');
    return {
      count: v.count != null ? v.count : hasData ? null : 0,
      avg: hasData ? round(v.avg) : null,
      min: hasData ? round(v.min) : null,
      med: hasData ? round(v.med) : null,
      p95: hasData ? round(v['p(95)']) : null,
      p99: hasData ? round(v['p(99)']) : null,
      max: hasData ? round(v.max) : null,
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
      deliverWindowMs: DELIVER_WINDOW_MS,
      requestAck: REQUEST_ACK,
      holdSeconds: HOLD_MS / 1000,
      reconnect: RECONNECT,
      maxReconnects: MAX_RECONNECTS,
      reconnectDelayMs: RECONNECT_DELAY_MS,
      rampDuration: RAMP_S,
      connectMarginMs: CONNECT_MARGIN_MS,
      thinkAfterGo: THINK_MS / 1000,
      rate: MODE === 'rate' ? RATE : null,
      duration: MODE === 'rate' ? DURATION : null,
      socketBase: SOCKET_BASE,
      namespace: NAMESPACE,
      sendEvent: SEND_EVENT,
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
      ws_msg_deliver_time: trend('ws_msg_deliver_time'),
    },
    counters: {
      ws_connected: counter('ws_connected'),
      ws_connect_error: counter('ws_connect_error'),
      ws_connect_attempt_fail: counter('ws_connect_attempt_fail'),
      ws_exception: counter('ws_exception'),
      ws_join_ack_ok: counter('ws_join_ack_ok'),
      ws_join_ack_fail: counter('ws_join_ack_fail'),
      ws_join_no_ack: counter('ws_join_no_ack'),
      ws_fired: counter('ws_fired'),
      ws_message_sent: counter('ws_message_sent'),
      ws_msg_delivered: counter('ws_msg_delivered'),
      ws_msg_failed: counter('ws_msg_failed'),
      ws_send_ask_ok: counter('ws_send_ask_ok'),
      ws_send_skipped_disconnected: counter('ws_send_skipped_disconnected'),
      ws_send_ack_ok: counter('ws_send_ack_ok'),
      ws_send_ack_fail: counter('ws_send_ack_fail'),
      ws_send_ack_timeout: counter('ws_send_ack_timeout'),
      ws_upsert_timeout: counter('ws_upsert_timeout'),
      ws_disconnected: counter('ws_disconnected'),
      ws_close_expected: counter('ws_close_expected'),
      ws_close_unexpected: counter('ws_close_unexpected'),
      ws_server_disconnect: counter('ws_server_disconnect'),
      ws_reconnect_attempt: counter('ws_reconnect_attempt'),
      ws_reconnect_success: counter('ws_reconnect_success'),
      ws_reconnect_exhausted: counter('ws_reconnect_exhausted'),
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
  if (n == null || Number.isNaN(n)) return null;
  return Math.round(n * 100) / 100;
}

function consoleSummary(run) {
  const c = run.counters;
  const rt = run.trends.ws_message_round_trip;
  const dl = run.trends.ws_msg_deliver_time || rt;
  const sa = run.trends.ws_send_ack_time;
  const cfg = run.config || {};
  const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) : '0.0');
  const ms = (n) => (n == null ? 'n/a' : String(n));
  const delivered = c.ws_msg_delivered != null ? c.ws_msg_delivered : c.ws_send_ask_ok;
  const failed = c.ws_msg_failed != null ? c.ws_msg_failed : c.ws_upsert_timeout;
  const L = [];
  L.push('');
  L.push('============== appchat LOADTEST — KẾT QUẢ THỰC TẾ ==============');
  L.push(`  mode=${run.mode}  run=${run.runId}  dur=${(run.durationMs / 1000).toFixed(1)}s`);
  L.push(
    `  event=${cfg.sendEvent}  deliver_window=${(cfg.deliverWindowMs || 0) / 1000}s  ack_diagnostic=${cfg.requestAck ? 'on' : 'off'}`,
  );
  if (run.mode === 'rate') {
    L.push(`  rate=${cfg.rate || '?'} msg/s  duration=${cfg.duration || '?'}`);
  } else {
    L.push(`  target_vus=${cfg.userCount || 0}  msgs/vu=${cfg.msgsPerVu}`);
  }
  L.push('');
  L.push('  ── SỐ KẾT NỐI (WebSocket) ──');
  L.push(`    connected (socket OK): ${c.ws_connected}`);
  L.push(`    join room OK:          ${c.ws_join_ack_ok}`);
  L.push(`    connect errors:        ${c.ws_connect_error}`);
  L.push(`    attempt failures:      ${c.ws_connect_attempt_fail}`);
  L.push(`    exceptions:            ${c.ws_exception}`);
  L.push('');
  L.push('  ── SỐ TIN NHẮN GỬI THÀNH CÔNG (FE: upsert ≤ window) ──');
  L.push(`    đã gửi (attempted):    ${c.ws_message_sent}`);
  L.push(`    ✅ thành công (SENT):  ${delivered} (${pct(delivered, c.ws_message_sent)}%)`);
  L.push(`    ❌ thất bại (FAILED):  ${failed} (${pct(failed, c.ws_message_sent)}%)`);
  L.push(`    skipped (socket đóng): ${c.ws_send_skipped_disconnected}`);
  if (cfg.requestAck) {
    L.push(`    [chẩn đoán] ack ok:    ${c.ws_send_ack_ok} / fail ${c.ws_send_ack_fail}`);
  }
  L.push('');
  L.push('  ── ĐỘ TRỄ ĐẦY ĐỦ (ms) — avg / min / med / p95 / p99 / max ──');
  const ct = run.trends.ws_connect_time;
  const jt = run.trends.ws_join_time;
  const row = (label, t) =>
    `    ${label.padEnd(13)} n=${String(t.count || 0).padStart(6)}  avg=${ms(t.avg)}  min=${ms(t.min)}  med=${ms(t.med)}  p95=${ms(t.p95)}  p99=${ms(t.p99)}  max=${ms(t.max)}`;
  L.push(row('connect', ct));
  L.push(row('join', jt));
  L.push(row('delivered', dl)); // send → message:upsert echo (UX latency thật)
  if (cfg.requestAck) L.push(row('gateway_ack', sa));
  L.push('');
  L.push('  ── ỔN ĐỊNH KẾT NỐI ──');
  L.push(`    unexpected close:  ${c.ws_close_unexpected}   server disconnect: ${c.ws_server_disconnect}`);
  L.push(`    reconnect:         ${c.ws_reconnect_success}/${c.ws_reconnect_attempt} ok   exhausted ${c.ws_reconnect_exhausted}`);
  L.push(`  checks pass: ${(run.checks.overallRate * 100).toFixed(1)}%`);
  L.push(`  → reports/run-${run.runId}.json`);
  L.push('===============================================================');
  L.push('');
  return L.join('\n');
}

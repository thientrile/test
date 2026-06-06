// Single-socket smoke for the k6/ws socket.io framing — the k6 equivalent of
// the old artillery/probe-send.js. Connects ONE socket, joins the room, sends
// ONE message, logs the ack + the message:upsert echo. Validates the real
// handshake/auth/join/send path against the live backend before a full run.
//
//   k6 run k6/probe.js           (needs k6/users.csv + k6/room.json from prepare)
//
// Distinguishes a systematic protocol/message-path bug (fails for 1 msg) from a
// load problem (1 msg ok, only the burst fails).

import ws from 'k6/ws';
import { check } from 'k6';
import { SharedArray } from 'k6/data';

import { parsePacket, encodeConnect, encodeEvent, EIO_PONG } from './socketio.js';

const NAMESPACE = __ENV.SOCKET_NAMESPACE || '/chat';
const SOCKET_BASE = __ENV.SOCKET_BASE || 'ws://nginx:8080';
// Real FE chat event (socketEvent.MSGSEND) — NOT 'send_ask' (not handled by BE).
const SEND_EVENT = __ENV.SEND_EVENT || 'message:send';
const WS_URL = `${SOCKET_BASE}/socket.io/?EIO=4&transport=websocket`;

const USERS = new SharedArray('users', () => {
  const lines = open('./users.csv').trim().split(/\r?\n/);
  lines.shift();
  return lines.map((l) => {
    const [username, password, accessToken, userId, fullname] = l.split(',');
    return { username, password, accessToken, userId, fullname };
  });
});
const ROOM_ID = JSON.parse(open('./room.json')).roomId;

export const options = { vus: 1, iterations: 1 };

function oid() {
  const ts = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0');
  let rest = '';
  for (let i = 0; i < 16; i++) rest += Math.floor(Math.random() * 16).toString(16);
  return ts + rest;
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

export default function () {
  const user = USERS[0];
  const token = String(user.accessToken || '').replace(/^"|"$/g, '').trim();
  console.log(`[probe] roomId=${ROOM_ID} user=${user.username}`);

  let connected = false;
  let joinAcked = false;
  let upsertSeen = false;
  let sentMsgId = '';
  let ackId = 0;
  const pending = {};

  const res = ws.connect(WS_URL, {}, function (socket) {
    function emit(event, arg, onAck) {
      const id = onAck ? ++ackId : null;
      if (onAck) pending[id] = onAck;
      socket.send(encodeEvent(NAMESPACE, id, event, [arg]));
    }

    socket.on('message', function (raw) {
      const p = parsePacket(raw);
      switch (p.type) {
        case 'open':
          console.log('[probe] engine open → sending /chat connect');
          socket.send(encodeConnect(NAMESPACE, { token }));
          break;
        case 'ping':
          socket.send(EIO_PONG);
          break;
        case 'connect':
          connected = true;
          console.log('[probe] connected to /chat → join');
          emit('join', { roomId: ROOM_ID }, function (a) {
            joinAcked = true;
            console.log('[probe] JOIN ack: ' + JSON.stringify(a));
            const t0 = Date.now();
            sentMsgId = oid();
            emit(
              SEND_EVENT,
              {
                roomId: ROOM_ID,
                type: 'text',
                content: user.fullname || 'probe',
                replyTo: '',
                id: sentMsgId,
              },
              function (ack) {
                console.log(`[probe] SEND ack after ${Date.now() - t0}ms: ${JSON.stringify(ack)}`);
                socket.setTimeout(() => socket.close(), 5000);
              },
            );
          });
          break;
        case 'ack': {
          const h = p.ackId != null ? pending[p.ackId] : null;
          if (h) { delete pending[p.ackId]; h(p.args); }
          break;
        }
        case 'event':
          if (p.event === 'message:upsert') {
            const m = p.args && p.args[0] ? p.args[0] : null;
            const receivedMsgId = messageIdOf(m);
            if (receivedMsgId === sentMsgId) {
              upsertSeen = true;
              console.log('[probe] message:upsert matched sent id: ' + receivedMsgId);
              socket.close();
            } else {
              console.log(`[probe] message:upsert ignored: received=${receivedMsgId || '<missing>'} sent=${sentMsgId} payload=${JSON.stringify(p.args[0])}`);
            }
          }
          break;
        case 'connect_error':
          console.error('[probe] CONNECT_ERROR: ' + JSON.stringify(p.data));
          socket.close();
          break;
      }
    });

    socket.on('error', function (e) {
      if (e && typeof e.error === 'function' && e.error() !== 'websocket: close sent') {
        console.error('[probe] error: ' + e.error());
      }
    });

    socket.setTimeout(() => socket.close(), 30000);
  });

  check(res, { 'ws upgrade 101': (r) => r && r.status === 101 });
  check(null, {
    '[probe] connected': () => connected,
    '[probe] join acked': () => joinAcked,
    '[probe] upsert echo matched sent id': () => upsertSeen,
  });
}

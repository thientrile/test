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

export default function () {
  const user = USERS[0];
  const token = String(user.accessToken || '').replace(/^"|"$/g, '').trim();
  console.log(`[probe] roomId=${ROOM_ID} user=${user.username}`);

  let connected = false;
  let joinAcked = false;
  let sendAcked = false;
  let upsertSeen = false;
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
            emit(
              'message:send',
              { roomId: ROOM_ID, type: 'text', content: user.fullname || 'probe', replyTo: '' },
              function (ack) {
                sendAcked = true;
                console.log(`[probe] SEND ack after ${Date.now() - t0}ms: ${JSON.stringify(ack)}`);
                socket.setTimeout(() => socket.close(), 1500);
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
            upsertSeen = true;
            console.log('[probe] message:upsert echo: ' + JSON.stringify(p.args[0]));
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
    '[probe] send acked': () => sendAcked,
    '[probe] upsert echo seen': () => upsertSeen,
  });
}

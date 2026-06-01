// Engine.IO v4 + Socket.IO framing over a raw WebSocket.
//
// The backend is a NestJS socket.io gateway on the `/chat` namespace, but
// k6/ws is a RAW WebSocket client — so we hand-roll the protocol here. This
// module is PURE string logic (no k6 imports) so it can be unit-tested under
// plain Node (`node --test k6/socketio.test.js`).
//
// Wire reference (each WS text frame = one Engine.IO packet):
//   "0{json}"            Engine.IO OPEN (sid, pingInterval, pingTimeout)
//   "2" / "3"            Engine.IO PING / PONG  (app-level heartbeat)
//   "40[/ns,]{auth}"     Socket.IO CONNECT (+ optional namespace + auth)
//   "41[/ns]"            Socket.IO DISCONNECT
//   "42[/ns,][id][arr]"  Socket.IO EVENT  (optional ack id)
//   "43[/ns,][id][arr]"  Socket.IO ACK    (reply to an event with that id)
//   "44[/ns,]{err}"      Socket.IO CONNECT_ERROR (auth failure etc.)
//
// socket.io-parser always emits the namespace separator comma for a
// non-default namespace (e.g. "40/chat,"), regardless of whether a payload
// or ack id follows — encodeConnect/encodeEvent mirror that.

export const EIO_PING = '2';
export const EIO_PONG = '3';

const DEFAULT_NS = '/';

// Split a Socket.IO body (everything after the two leading type chars, e.g.
// the part after "42") into { namespace, ackId, rest }.
function splitNsAndAck(body) {
  let namespace = DEFAULT_NS;
  let rest = body;

  if (rest.startsWith('/')) {
    const comma = rest.indexOf(',');
    if (comma === -1) {
      // "41/chat" — namespace only, no payload (e.g. DISCONNECT)
      return { namespace: rest, ackId: null, rest: '' };
    }
    namespace = rest.slice(0, comma);
    rest = rest.slice(comma + 1);
  }

  // Leading digits (if any) are the ack id; payload JSON starts at '[' or '{'.
  let i = 0;
  while (i < rest.length && rest[i] >= '0' && rest[i] <= '9') i++;
  const ackId = i > 0 ? parseInt(rest.slice(0, i), 10) : null;
  rest = rest.slice(i);

  return { namespace, ackId, rest };
}

export function parsePacket(raw) {
  if (raw === EIO_PING) return { type: 'ping' };
  if (raw === EIO_PONG) return { type: 'pong' };

  const engineType = raw[0];

  if (engineType === '0') {
    return { type: 'open', data: JSON.parse(raw.slice(1)) };
  }
  if (engineType === '1') {
    return { type: 'engine_close' };
  }
  if (engineType !== '4') {
    return { type: 'unknown', raw };
  }

  // Engine.IO MESSAGE → the rest is a Socket.IO packet.
  const sioType = raw[1];
  const { namespace, ackId, rest } = splitNsAndAck(raw.slice(2));

  switch (sioType) {
    case '0':
      return { type: 'connect', namespace, data: rest ? JSON.parse(rest) : null };
    case '1':
      return { type: 'disconnect', namespace };
    case '2': {
      const arr = JSON.parse(rest);
      return { type: 'event', namespace, ackId, event: arr[0], args: arr.slice(1) };
    }
    case '3':
      return { type: 'ack', namespace, ackId, args: JSON.parse(rest) };
    case '4':
      return {
        type: 'connect_error',
        namespace,
        data: rest ? JSON.parse(rest) : null,
      };
    default:
      return { type: 'unknown', raw };
  }
}

function nsPrefix(namespace) {
  return namespace && namespace !== DEFAULT_NS ? `${namespace},` : '';
}

// "40[/ns,]{auth}" — connect to a namespace, optionally with an auth payload.
export function encodeConnect(namespace, auth) {
  return `40${nsPrefix(namespace)}${auth ? JSON.stringify(auth) : ''}`;
}

// "42[/ns,][ackId][event,...args]" — emit an event, optionally requesting an ack.
export function encodeEvent(namespace, ackId, event, args = []) {
  const id = ackId == null ? '' : String(ackId);
  return `42${nsPrefix(namespace)}${id}${JSON.stringify([event, ...args])}`;
}

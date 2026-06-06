import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parsePacket,
  encodeConnect,
  encodeEvent,
  EIO_PING,
  EIO_PONG,
} from './socketio.js';

// ---------------------------------------------------------------------------
// parsePacket — Engine.IO v4 framing
// ---------------------------------------------------------------------------

test('parsePacket: Engine.IO OPEN carries sid + ping config', () => {
  const p = parsePacket(
    '0{"sid":"abc","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}',
  );
  assert.equal(p.type, 'open');
  assert.equal(p.data.sid, 'abc');
  assert.equal(p.data.pingInterval, 25000);
  assert.equal(p.data.pingTimeout, 20000);
});

test('parsePacket: Engine.IO PING is "2"', () => {
  assert.deepEqual(parsePacket('2'), { type: 'ping' });
});

test('parsePacket: Engine.IO PONG is "3"', () => {
  assert.deepEqual(parsePacket('3'), { type: 'pong' });
});

// ---------------------------------------------------------------------------
// parsePacket — Socket.IO framing (namespaced /chat)
// ---------------------------------------------------------------------------

test('parsePacket: Socket.IO CONNECT ack with namespace + sid', () => {
  const p = parsePacket('40/chat,{"sid":"xyz789"}');
  assert.equal(p.type, 'connect');
  assert.equal(p.namespace, '/chat');
  assert.equal(p.data.sid, 'xyz789');
});

test('parsePacket: Socket.IO CONNECT on default namespace', () => {
  const p = parsePacket('40{"sid":"root"}');
  assert.equal(p.type, 'connect');
  assert.equal(p.namespace, '/');
  assert.equal(p.data.sid, 'root');
});

test('parsePacket: Socket.IO DISCONNECT', () => {
  const p = parsePacket('41/chat');
  assert.equal(p.type, 'disconnect');
  assert.equal(p.namespace, '/chat');
});

test('parsePacket: EVENT with ack id parses event name + args', () => {
  const p = parsePacket('42/chat,3["message:upsert",{"id":"m1","content":"hi"}]');
  assert.equal(p.type, 'event');
  assert.equal(p.namespace, '/chat');
  assert.equal(p.ackId, 3);
  assert.equal(p.event, 'message:upsert');
  assert.deepEqual(p.args, [{ id: 'm1', content: 'hi' }]);
});

test('parsePacket: EVENT without ack id has ackId null', () => {
  const p = parsePacket('42/chat,["message:upsert",{"id":"m2"}]');
  assert.equal(p.type, 'event');
  assert.equal(p.ackId, null);
  assert.equal(p.event, 'message:upsert');
  assert.deepEqual(p.args, [{ id: 'm2' }]);
});

test('parsePacket: EVENT on default namespace with multi-digit ack id', () => {
  const p = parsePacket('42123["hello",{"a":1}]');
  assert.equal(p.type, 'event');
  assert.equal(p.namespace, '/');
  assert.equal(p.ackId, 123);
  assert.equal(p.event, 'hello');
  assert.deepEqual(p.args, [{ a: 1 }]);
});

test('parsePacket: ACK reply resolves by ack id with payload args', () => {
  const p = parsePacket('43/chat,7[{"ok":true,"id":"m1"}]');
  assert.equal(p.type, 'ack');
  assert.equal(p.namespace, '/chat');
  assert.equal(p.ackId, 7);
  assert.deepEqual(p.args, [{ ok: true, id: 'm1' }]);
});

test('parsePacket: CONNECT_ERROR carries the error message', () => {
  const p = parsePacket('44/chat,{"message":"Unauthorized"}');
  assert.equal(p.type, 'connect_error');
  assert.equal(p.namespace, '/chat');
  assert.equal(p.data.message, 'Unauthorized');
});

test('parsePacket: unknown frame is reported, not thrown', () => {
  const p = parsePacket('6');
  assert.equal(p.type, 'unknown');
});

// ---------------------------------------------------------------------------
// encodeConnect / encodeEvent — and round-trip
// ---------------------------------------------------------------------------

test('encodeConnect: namespace + auth payload', () => {
  assert.equal(
    encodeConnect('/chat', { token: 'abc.def.ghi' }),
    '40/chat,{"token":"abc.def.ghi"}',
  );
});

test('encodeConnect: namespace without auth keeps the separator comma', () => {
  assert.equal(encodeConnect('/chat', null), '40/chat,');
});

test('encodeConnect: default namespace, no separator', () => {
  assert.equal(encodeConnect('/', { token: 't' }), '40{"token":"t"}');
});

test('encodeEvent: namespaced event with ack id', () => {
  assert.equal(
    encodeEvent('/chat', 5, 'join', [{ roomId: 'r1' }]),
    '42/chat,5["join",{"roomId":"r1"}]',
  );
});

test('encodeEvent: namespaced event without ack id (null)', () => {
  assert.equal(
    encodeEvent('/chat', null, 'join', [{ roomId: 'r1' }]),
    '42/chat,["join",{"roomId":"r1"}]',
  );
});

test('round-trip: encodeEvent → parsePacket preserves event, ackId, args', () => {
  const wire = encodeEvent('/chat', 9, 'send_ask', [
    { roomId: 'r1', type: 'text', content: 'Alice', replyTo: '' },
  ]);
  const p = parsePacket(wire);
  assert.equal(p.type, 'event');
  assert.equal(p.namespace, '/chat');
  assert.equal(p.ackId, 9);
  assert.equal(p.event, 'send_ask');
  assert.deepEqual(p.args, [
    { roomId: 'r1', type: 'text', content: 'Alice', replyTo: '' },
  ]);
});

test('constants: PING/PONG wire chars', () => {
  assert.equal(EIO_PING, '2');
  assert.equal(EIO_PONG, '3');
});

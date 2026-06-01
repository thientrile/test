'use strict';

const axios = require('axios');
const { config } = require('./config');

const http = axios.create({
  baseURL: config.targetBase,
  timeout: 30_000,
  validateStatus: () => true,
});

function unwrap(resp) {
  // api-gateway uses a ResponseInterceptor that wraps payloads as
  // { reasonStatusCode, statusCode, message, metadata }. The actual
  // data we care about lives in `metadata`.
  if (!resp || !resp.data) return resp;
  const body = resp.data;
  if (body && typeof body === 'object' && 'metadata' in body) {
    return body.metadata;
  }
  return body;
}

function describeError(resp) {
  if (!resp) return 'no response';
  const body = resp.data;
  if (body && body.message) {
    if (Array.isArray(body.message)) {
      return body.message
        .map((m) =>
          typeof m === 'string'
            ? m
            : `${m.field}: ${(m.errors || []).join(', ')}`,
        )
        .join('; ');
    }
    return String(body.message);
  }
  return `HTTP ${resp.status}`;
}

async function login({ username, password }) {
  const resp = await http.post('/api/auth/login', {
    username,
    password,
  });
  if (resp.status >= 400) {
    throw new Error(`login failed (${username}): ${describeError(resp)}`);
  }
  return unwrap(resp);
}

async function createGroupRoom({ accessToken, name, memberIds }) {
  const resp = await http.post(
    '/api/chat/rooms',
    {
      name,
      avatar: '',
      type: 'group',
      memberIds,
    },
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );
  if (resp.status >= 400) {
    throw new Error(`createRoom failed: ${describeError(resp)}`);
  }
  return unwrap(resp);
}

// Add members to an existing room (PATCH /api/chat/rooms/add). roomId is the
// BUSINESS room_id; memberIds are business usr_ids. The adder (from the token)
// must already be a member. Idempotent server-side (already-in members are
// filtered), so re-adding a batch is safe.
async function addMembers({ accessToken, roomId, memberIds }) {
  const resp = await http.patch(
    '/api/chat/rooms/add',
    { roomId, memberIds },
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (resp.status >= 400) {
    throw new Error(`addMembers failed: ${describeError(resp)}`);
  }
  return unwrap(resp);
}

module.exports = { http, login, createGroupRoom, addMembers };

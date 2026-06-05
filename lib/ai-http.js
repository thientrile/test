'use strict';

const axios = require('axios');

function unwrap(resp) {
  if (!resp?.data) return resp?.data;
  return unwrapGatewayPayload(resp.data);
}

/** HTTP interceptor hoặc SSE `data:` — có thể là { metadata } hoặc payload gRPC thẳng. */
function unwrapGatewayPayload(data) {
  if (data == null) return null;
  if (typeof data === 'string') return data.trim() ? data : null;
  if (typeof data !== 'object') return data;
  if (typeof data.raw === 'string') return { _streamParts: [data.raw] };
  if ('metadata' in data && data.metadata != null && data.metadata !== '') {
    return data.metadata;
  }
  return data;
}

function mergeMeta(prev, next) {
  if (next == null) return prev;
  if (next._streamParts) {
    const parts = [
      ...(prev?._streamParts || []),
      ...next._streamParts,
    ];
    return { ...(typeof prev === 'object' && prev ? prev : {}), _streamParts: parts };
  }
  if (typeof next === 'string') return next;
  if (typeof prev === 'string') return next;
  if (prev && typeof prev === 'object' && typeof next === 'object') {
    return { ...prev, ...next };
  }
  return next;
}

function finalizeStreamMeta(meta, chunks) {
  const parts = [
    ...(meta?._streamParts || []),
    ...chunks,
  ];
  let out = meta;
  if (out?._streamParts) {
    const { _streamParts, ...rest } = out;
    out = Object.keys(rest).length ? rest : null;
    parts.unshift(..._streamParts);
  }
  const joined = parts.join('').trim();
  if (!out && joined) {
    try {
      out = JSON.parse(joined);
    } catch {
      out = { _streamText: joined };
    }
  } else if (out && joined && !out._streamText) {
    out = mergeMeta(out, { _streamText: joined });
  }
  return out;
}

function createClient(baseURL, accessToken, timeoutMs = 120_000) {
  return axios.create({
    baseURL,
    timeout: timeoutMs,
    validateStatus: () => true,
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
  });
}

async function postJson(client, path, body) {
  const t0 = Date.now();
  const resp = await client.post(path, body, {
    headers: { 'Content-Type': 'application/json' },
  });
  const latencyMs = Date.now() - t0;
  return { resp, latencyMs, meta: unwrap(resp), httpStatus: resp.status };
}

async function getJson(client, path, params) {
  const t0 = Date.now();
  const resp = await client.get(path, { params });
  const latencyMs = Date.now() - t0;
  return { resp, latencyMs, meta: unwrap(resp), httpStatus: resp.status };
}

/**
 * Đọc SSE tối thiểu (start → chunk* → done | error).
 * @returns {{ latencyMs, ttfbMs, meta, chunks, error? }}
 */
async function postSse(client, path, body, timeoutMs = 120_000) {
  const t0 = Date.now();
  let ttfbMs = null;
  const chunks = [];
  let meta = null;
  let error = null;

  const resp = await client.post(path, body, {
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    responseType: 'stream',
    timeout: timeoutMs,
    validateStatus: () => true,
  });

  if (resp.status >= 400) {
    const latencyMs = Date.now() - t0;
    let errBody = '';
    await new Promise((resolve) => {
      resp.data.on('data', (c) => { errBody += c.toString(); });
      resp.data.on('end', resolve);
      resp.data.on('error', resolve);
    });
    return {
      latencyMs,
      ttfbMs: null,
      meta: null,
      chunks: [],
      error: `HTTP ${resp.status}: ${errBody.slice(0, 300)}`,
      httpStatus: resp.status,
    };
  }

  await new Promise((resolve, reject) => {
    let buffer = '';
    const stream = resp.data;

    const finish = (err) => {
      if (err) reject(err);
      else resolve();
    };

    stream.on('data', (chunk) => {
      if (ttfbMs == null) ttfbMs = Date.now() - t0;
      buffer += chunk.toString();
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';
      for (const block of parts) {
        parseSseBlock(block, chunks, (event, data) => {
          if (event === 'error') {
            error =
              data?.error || data?.message || JSON.stringify(data);
            return;
          }
          if (event === 'chunk' || !event) {
            const part = unwrapGatewayPayload(data);
            if (part?._streamParts) {
              chunks.push(...part._streamParts);
            } else {
              meta = mergeMeta(meta, part);
            }
            if (data?.chunk) chunks.push(String(data.chunk));
          }
        });
      }
    });
    stream.on('end', () => finish());
    stream.on('error', finish);
  });

  const latencyMs = Date.now() - t0;
  meta = finalizeStreamMeta(meta, chunks);
  return {
    latencyMs,
    ttfbMs,
    meta,
    chunks,
    error,
    httpStatus: resp.status,
  };
}

/** GET + Accept: text/event-stream (vd. /api/ai/stream/search-messages). */
async function getSse(client, path, params, timeoutMs = 120_000) {
  const t0 = Date.now();
  let ttfbMs = null;
  const chunks = [];
  let meta = null;
  let error = null;

  const resp = await client.get(path, {
    params,
    headers: { Accept: 'text/event-stream' },
    responseType: 'stream',
    timeout: timeoutMs,
    validateStatus: () => true,
  });

  if (resp.status >= 400) {
    const latencyMs = Date.now() - t0;
    let errBody = '';
    await new Promise((resolve) => {
      resp.data.on('data', (c) => { errBody += c.toString(); });
      resp.data.on('end', resolve);
      resp.data.on('error', resolve);
    });
    return {
      latencyMs,
      ttfbMs: null,
      meta: null,
      chunks: [],
      error: `HTTP ${resp.status}: ${errBody.slice(0, 300)}`,
      httpStatus: resp.status,
    };
  }

  await new Promise((resolve, reject) => {
    let buffer = '';
    const stream = resp.data;

    const finish = (err) => {
      if (err) reject(err);
      else resolve();
    };

    stream.on('data', (chunk) => {
      if (ttfbMs == null) ttfbMs = Date.now() - t0;
      buffer += chunk.toString();
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';
      for (const block of parts) {
        parseSseBlock(block, chunks, (event, data) => {
          if (event === 'error') {
            error =
              data?.error || data?.message || JSON.stringify(data);
            return;
          }
          if (event === 'chunk' || !event) {
            const part = unwrapGatewayPayload(data);
            if (part?._streamParts) {
              chunks.push(...part._streamParts);
            } else {
              meta = mergeMeta(meta, part);
            }
            if (data?.chunk) chunks.push(String(data.chunk));
          }
        });
      }
    });
    stream.on('end', () => finish());
    stream.on('error', finish);
  });

  const latencyMs = Date.now() - t0;
  meta = finalizeStreamMeta(meta, chunks);
  return {
    latencyMs,
    ttfbMs,
    meta,
    chunks,
    error,
    httpStatus: resp.status,
  };
}

function parseSseBlock(block, chunks, onEvent) {
  let event = null;
  let dataLines = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return;
  const raw = dataLines.join('\n');
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = { raw };
  }
  onEvent(event, data);
  if (data?.chunk) chunks.push(data.chunk);
}

async function getUsageReport(client, params = {}) {
  const resp = await client.get('/api/ai/usage/report', { params });
  if (resp.status >= 400) {
    throw new Error(`usage/report HTTP ${resp.status}`);
  }
  const body = resp.data;
  if (body?.metadata) return body.metadata;
  return body;
}

module.exports = {
  unwrap,
  unwrapGatewayPayload,
  createClient,
  postJson,
  getJson,
  postSse,
  getSse,
  getUsageReport,
};

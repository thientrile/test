'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildHistory, renderHtml } = require('./build-report');

function fakeRun(over = {}) {
  return {
    runId: '1000',
    timestamp: '2026-05-30T10:00:00.000Z',
    mode: 'burst',
    config: { userCount: 1000, rampDuration: 30 },
    durationMs: 42000,
    checks: { overallRate: 0.95, items: [{ name: 'socket connected', passes: 950, fails: 50 }] },
    trends: {
      ws_connect_time: { avg: 100, med: 90, p95: 200, p99: 300, max: 500 },
      ws_join_time: { avg: 50, med: 40, p95: 120, p99: 180, max: 250 },
      ws_send_ack_time: { avg: 800, med: 700, p95: 1500, p99: 3000, max: 8000 },
      ws_message_round_trip: { avg: 900, med: 800, p95: 1700, p99: 3200, max: 9000 },
    },
    counters: {
      ws_connected: 950,
      ws_connect_error: 50,
      ws_connect_attempt_fail: 120,
      ws_close_unexpected: 7,
      ws_server_disconnect: 3,
      ws_reconnect_attempt: 20,
      ws_reconnect_success: 15,
      ws_reconnect_exhausted: 2,
      ws_send_skipped_disconnected: 6,
      ws_message_sent: 940,
      ws_send_ask_ok: 910,
      ws_send_ack_ok: 900,
      ws_send_ack_fail: 10,
      ws_send_ack_timeout: 30,
    },
    ...over,
  };
}

test('buildHistory sorts runs newest-first by timestamp', () => {
  const older = fakeRun({ runId: 'a', timestamp: '2026-05-30T09:00:00.000Z' });
  const newer = fakeRun({ runId: 'b', timestamp: '2026-05-30T11:00:00.000Z' });
  const hist = buildHistory([older, newer]);
  assert.equal(hist[0].runId, 'b');
  assert.equal(hist[1].runId, 'a');
});

test('buildHistory extracts compact per-run summary fields', () => {
  const hist = buildHistory([fakeRun()]);
  const h = hist[0];
  assert.equal(h.runId, '1000');
  assert.equal(h.mode, 'burst');
  assert.equal(h.userCount, 1000);
  assert.equal(h.roundTripP95, 1700);
  assert.equal(h.sendAskOk, 910);
  assert.equal(h.sendAckOk, 900);
  assert.equal(h.connectError, 50);
  assert.equal(h.connectAttemptFail, 120);
  assert.equal(h.reconnectAttempt, 20);
  assert.equal(h.reconnectSuccess, 15);
  assert.equal(h.reconnectPct, 75);
  assert.equal(h.closeUnexpected, 7);
  assert.equal(h.sendSkippedDisconnected, 6);
  // checks pass percentage surfaced for the trend chart
  assert.equal(h.checksPct, 95);
});

test('renderHtml is self-contained and inlines the run data', () => {
  const html = renderHtml([fakeRun()]);
  assert.match(html, /<!DOCTYPE html>/i);
  // data embedded, not fetched
  assert.doesNotMatch(html, /fetch\(/);
  // the actual numbers are present so the page renders offline
  assert.ok(html.includes('1700')); // round-trip p95
  assert.ok(html.includes('burst'));
  assert.ok(html.includes('Reconnect rate'));
});

test('buildHistory keeps missing latency samples as null, not zero', () => {
  const run = fakeRun({
    trends: {
      ws_connect_time: {},
      ws_join_time: {},
      ws_send_ack_time: { count: 0, p95: null, p99: null },
      ws_message_round_trip: { count: 0, p95: null, p99: null },
    },
  });
  const hist = buildHistory([run]);
  assert.equal(hist[0].roundTripP95, null);
  assert.equal(hist[0].sendAckP95, null);
});

test('buildHistory treats legacy all-zero latency trends as missing samples', () => {
  const run = fakeRun({
    trends: {
      ws_connect_time: { avg: 100, p95: 200 },
      ws_join_time: { avg: 50, p95: 120 },
      ws_send_ack_time: { avg: 0, med: 0, p95: 0, p99: 0, max: 0 },
      ws_message_round_trip: { avg: 0, med: 0, p95: 0, p99: 0, max: 0 },
    },
  });
  const hist = buildHistory([run]);
  assert.equal(hist[0].roundTripP95, null);
  assert.equal(hist[0].sendAckP95, null);
});

test('buildHistory infers sendAskOk from legacy upsert timeout counters', () => {
  const run = fakeRun({
    counters: {
      ws_message_sent: 100,
      ws_upsert_timeout: 12,
      ws_send_ack_ok: 80,
    },
  });
  const hist = buildHistory([run]);
  assert.equal(hist[0].sendAskOk, 88);
});

test('renderHtml handles an empty history without throwing', () => {
  const html = renderHtml([]);
  assert.match(html, /<!DOCTYPE html>/i);
});

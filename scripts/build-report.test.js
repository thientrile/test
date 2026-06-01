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
      ws_message_sent: 940,
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
  assert.equal(h.sendAckOk, 900);
  assert.equal(h.connectError, 50);
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
});

test('renderHtml handles an empty history without throwing', () => {
  const html = renderHtml([]);
  assert.match(html, /<!DOCTYPE html>/i);
});

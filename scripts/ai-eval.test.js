'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  scoreHallucination,
  scoreTokenBudget,
  summarizeLatencies,
  summarizeLatenciesByGroup,
  scoreLatencyBudget,
} = require('../lib/ai-eval-lib');

describe('scoreHallucination', () => {
  it('passes when mustContainAny matches', () => {
    const r = scoreHallucination(
      { hallucination: { mustContainAny: ['hello'] } },
      'Hello world',
    );
    assert.equal(r.pass, true);
  });

  it('fails on forbidden hallucination phrase', () => {
    const r = scoreHallucination(
      { hallucination: { mustNotContain: ['bitcoin'] } },
      'Buy bitcoin now for profit',
    );
    assert.equal(r.pass, false);
    assert.ok(r.reasons.some((x) => x.includes('bitcoin')));
  });

  it('checks context overlap for suggest-replies', () => {
    const r = scoreHallucination(
      {
        hallucination: {
          contextKeywords: ['họp', 'meet'],
          minContextOverlap: 1,
        },
      },
      { suggestions: ['Ok mình join meet lúc 3h'] },
    );
    assert.equal(r.pass, true);
  });
});

describe('scoreTokenBudget', () => {
  it('flags over budget tokens', () => {
    const r = scoreTokenBudget(
      { tokenInput: 400, tokenOutput: 500, costUsd: 0.01 },
      { maxTotalTokens: 800, maxCostUsd: 0.005 },
    );
    assert.equal(r.pass, false);
  });
});

describe('summarizeLatencies', () => {
  it('computes p95 and p99', () => {
    const s = summarizeLatencies([10, 20, 30, 40, 100]);
    assert.equal(s.p95, 100);
    assert.equal(s.p99, 100);
    assert.equal(s.count, 5);
  });

  it('computes distinct p99 on larger sample', () => {
    const s = summarizeLatencies(Array.from({ length: 100 }, (_, i) => i + 1));
    assert.equal(s.p95, 95);
    assert.equal(s.p99, 99);
  });
});

describe('summarizeLatenciesByGroup', () => {
  it('groups by service', () => {
    const g = summarizeLatenciesByGroup([
      { httpOk: true, service: 'translation', latencyMs: 100 },
      { httpOk: true, service: 'translation', latencyMs: 200 },
      { httpOk: true, service: 'quizz', latencyMs: 3000 },
    ]);
    assert.equal(g.translation.count, 2);
    assert.equal(g.translation.p95, 200);
    assert.equal(g.quizz.p99, 3000);
  });
});

describe('scoreLatencyBudget', () => {
  it('flags over p95/p99 thresholds', () => {
    const r = scoreLatencyBudget({ p95: 3200, p99: 4000 }, {
      maxP95Ms: 3000,
      maxP99Ms: 3500,
    });
    assert.equal(r.pass, false);
    assert.equal(r.reasons.length, 2);
  });
});

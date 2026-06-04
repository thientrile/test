'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  scoreHallucination,
  scoreTokenBudget,
  summarizeLatencies,
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
  it('computes p95', () => {
    const s = summarizeLatencies([10, 20, 30, 40, 100]);
    assert.equal(s.p95, 100);
    assert.equal(s.count, 5);
  });
});

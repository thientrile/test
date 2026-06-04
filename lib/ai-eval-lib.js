'use strict';

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
}

function collectStrings(value, out = []) {
  if (value == null) return out;
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
    return out;
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value)) collectStrings(v, out);
  }
  return out;
}

/** Gộp mọi chuỗi trong metadata thành text để kiểm hallucination. */
function flattenResponse(meta) {
  return collectStrings(meta).join(' ');
}

function containsAny(haystack, needles) {
  const h = norm(haystack);
  return needles.some((n) => h.includes(norm(n)));
}

function containsNone(haystack, forbidden) {
  const h = norm(haystack);
  return !forbidden.some((n) => h.includes(norm(n)));
}

function contextOverlap(text, keywords, minHits) {
  const h = norm(text);
  const hits = keywords.filter((k) => h.includes(norm(k))).length;
  return hits >= minHits;
}

/**
 * @returns {{ pass: boolean, reasons: string[] }}
 */
function scoreHallucination(caseDef, metaOrText) {
  const text =
    typeof metaOrText === 'string' ? metaOrText : flattenResponse(metaOrText);
  const rules = caseDef.hallucination || {};
  const reasons = [];

  if (rules.mustContainAny?.length && !containsAny(text, rules.mustContainAny)) {
    reasons.push(`thiếu từ khóa kỳ vọng: ${rules.mustContainAny.join(', ')}`);
  }
  if (rules.mustNotContain?.length && !containsNone(text, rules.mustNotContain)) {
    const hit = rules.mustNotContain.filter((w) => norm(text).includes(norm(w)));
    reasons.push(`chứa nội dung cấm (hallucination): ${hit.join(', ')}`);
  }
  if (rules.contextKeywords?.length) {
    const min = rules.minContextOverlap ?? 1;
    if (!contextOverlap(text, rules.contextKeywords, min)) {
      reasons.push(
        `không bám ngữ cảnh (overlap < ${min}): ${rules.contextKeywords.join(', ')}`,
      );
    }
  }

  return { pass: reasons.length === 0, reasons, textSample: text.slice(0, 200) };
}

function scoreTokenBudget(log, budget) {
  if (!budget || !log) return { pass: true, reasons: [] };
  const reasons = [];
  const total = (log.tokenInput || 0) + (log.tokenOutput || 0);
  if (budget.maxTotalTokens != null && total > budget.maxTotalTokens) {
    reasons.push(`token ${total} > max ${budget.maxTotalTokens}`);
  }
  if (budget.maxCostUsd != null && (log.costUsd || 0) > budget.maxCostUsd) {
    reasons.push(`cost $${log.costUsd} > max $${budget.maxCostUsd}`);
  }
  return { pass: reasons.length === 0, reasons, totalTokens: total, costUsd: log.costUsd };
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function summarizeLatencies(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted[0] ?? null,
    max: sorted[sorted.length - 1] ?? null,
    avg: sorted.length
      ? sorted.reduce((a, b) => a + b, 0) / sorted.length
      : null,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
  };
}

module.exports = {
  flattenResponse,
  scoreHallucination,
  scoreTokenBudget,
  summarizeLatencies,
};

'use strict';

// Đánh giá AI: độ trễ p95/p99 (HTTP + SSE TTFB), hallucination (golden), token/request.
//
//   npm run test:ai
//   AI_EVAL_USE_STREAM=1 npm run test:ai
//
// Cần: GATEWAY_PROBE_BASE (hoặc TARGET_BASE), user login, Gemini/AI service hoạt động.
// Token thật: GET /api/ai/usage/report + Mongo AIUsageLogs (nếu MONGO_URI).

const fs = require('fs');
const path = require('path');

const { config } = require('../lib/config');
const api = require('../lib/api');
const mongo = require('../lib/mongo');
const {
  scoreHallucination,
  scoreTokenBudget,
  summarizeLatencies,
  summarizeLatenciesByGroup,
  scoreLatencyBudget,
} = require('../lib/ai-eval-lib');
const {
  createClient,
  postJson,
  getJson,
  postSse,
  getSse,
  getUsageReport,
} = require('../lib/ai-http');

const GOLDEN_PATH = path.join(__dirname, '..', 'fixtures', 'ai-golden.json');
const REPORT_DIR = path.join(__dirname, '..', 'k6', 'reports');
const USE_STREAM = process.env.AI_EVAL_USE_STREAM === '1';
const AI_BASE =
  process.env.AI_EVAL_BASE ||
  process.env.GATEWAY_PROBE_BASE ||
  config.gatewayProbeBase;
const LATENCY_BUDGET = {
  maxP95Ms: process.env.AI_EVAL_MAX_P95_MS
    ? Number(process.env.AI_EVAL_MAX_P95_MS)
    : null,
  maxP99Ms: process.env.AI_EVAL_MAX_P99_MS
    ? Number(process.env.AI_EVAL_MAX_P99_MS)
    : null,
};

async function resolveCredentials() {
  const u = process.env.GATEWAY_PROBE_USERNAME;
  const p = process.env.GATEWAY_PROBE_PASSWORD || config.userPassword;
  if (u) return { username: u, password: p };

  const csv = path.join(__dirname, '..', 'k6', 'users.csv');
  if (fs.existsSync(csv)) {
    const line = fs.readFileSync(csv, 'utf8').trim().split(/\r?\n/)[1];
    if (line) {
      const [username, password] = line.split(',');
      return { username, password };
    }
  }

  if (config.mongoUri) {
    await mongo.connect();
    const users = await mongo.getAllUsers();
    if (users.length) {
      return {
        username: users[0].username,
        password: users[0].password || config.userPassword,
      };
    }
  }
  throw new Error('Set GATEWAY_PROBE_USERNAME or run bootstrap/prepare');
}

function resolveRoomId() {
  if (process.env.AI_EVAL_ROOM_ID) return process.env.AI_EVAL_ROOM_ID;
  const roomJson = path.join(__dirname, '..', 'k6', 'room.json');
  if (!fs.existsSync(roomJson)) return null;
  try {
    return JSON.parse(fs.readFileSync(roomJson, 'utf8')).roomId || null;
  } catch {
    return null;
  }
}

/** Thay placeholder $ROOM_ID trong body/query (search-messages). */
function resolveCaseBody(body) {
  const roomId = resolveRoomId();
  const json = JSON.stringify(body || {});
  const resolved = json.replace(/"\$ROOM_ID"/g, roomId ? JSON.stringify(roomId) : 'null');
  return JSON.parse(resolved);
}

async function fetchLatestUsageLog(userId, service, since) {
  if (!config.mongoUri) return null;
  await mongo.connect();
  const doc = await mongo
    .appAiUsageLogsColl()
    .find({
      userId,
      service,
      createdAt: { $gte: since },
      status: 'success',
    })
    .sort({ createdAt: -1 })
    .limit(1)
    .toArray();
  return doc[0] || null;
}

async function runCase(client, caseDef, userId, since) {
  const route = USE_STREAM && caseDef.streamRoute ? caseDef.streamRoute : caseDef.route;
  const isStream = route.includes('/stream/');
  const method = (caseDef.method || 'POST').toUpperCase();
  const body = resolveCaseBody(caseDef.body);

  let result;
  if (isStream) {
    result =
      method === 'GET'
        ? await getSse(client, route, body)
        : await postSse(client, route, body);
  } else if (method === 'GET') {
    result = await getJson(client, route, body);
    result.ttfbMs = null;
  } else {
    result = await postJson(client, route, body);
    result.ttfbMs = null;
  }

  const httpOk = result.httpStatus >= 200 && result.httpStatus < 300 && !result.error;
  const hall = scoreHallucination(caseDef, result.meta);
  const log = await fetchLatestUsageLog(userId, caseDef.service, since);
  const tokenScore = scoreTokenBudget(log, caseDef.tokenBudget);

  return {
    id: caseDef.id,
    service: caseDef.service,
    route,
    stream: isStream,
    httpOk,
    latencyMs: result.latencyMs,
    ttfbMs: result.ttfbMs,
    error: result.error || (httpOk ? null : `HTTP ${result.httpStatus}`),
    hallucination: hall,
    tokens: log
      ? {
          input: log.tokenInput,
          output: log.tokenOutput,
          total: (log.tokenInput || 0) + (log.tokenOutput || 0),
          costUsd: log.costUsd,
          latencyServerMs: log.latencyMs,
          model: log.model,
        }
      : null,
    tokenBudget: tokenScore,
  };
}

function printReport(summary) {
  console.log('\n========== AI EVAL REPORT ==========');
  console.log(`base:     ${summary.base}`);
  console.log(`stream:   ${summary.useStream}`);
  console.log(`cases:    ${summary.passed}/${summary.total} passed`);
  console.log(
    `latency:  p95=${summary.latency.p95}ms  p99=${summary.latency.p99}ms  avg=${summary.latency.avg?.toFixed(0)}ms`,
  );
  if (summary.ttfb.count) {
    console.log(
      `ttfb:     p95=${summary.ttfb.p95}ms  p99=${summary.ttfb.p99}ms (SSE only)`,
    );
  }
  if (summary.latencyBudget && !summary.latencyBudget.pass) {
    console.log(
      `latency budget FAIL: ${summary.latencyBudget.reasons.join('; ')}`,
    );
  }
  if (summary.latencyByService && Object.keys(summary.latencyByService).length) {
    console.log('\n--- latency by service (p95 / p99) ---');
    for (const [svc, s] of Object.entries(summary.latencyByService)) {
      console.log(`  ${svc}: p95=${s.p95}ms  p99=${s.p99}ms  n=${s.count}`);
    }
  }
  console.log(
    `hallucination fail rate: ${(summary.hallucinationFailRate * 100).toFixed(1)}% (${summary.hallucinationFails}/${summary.total})`,
  );
  console.log(
    `token budget fail:       ${summary.tokenBudgetFails}/${summary.total}`,
  );
  if (summary.usageAfter?.items?.length) {
    console.log('\n--- usage/report (by service) ---');
    for (const item of summary.usageAfter.items) {
      console.log(
        `  ${item.group}: calls=${item.totalCalls} tokens in/out=${item.totalTokenInput}/${item.totalTokenOutput} cost=$${item.totalCostUsd} avgLat=${item.avgLatencyMs}ms`,
      );
    }
  }
  console.log('\n--- per case ---');
  for (const r of summary.results) {
    const flags = [
      r.httpOk ? 'HTTP ok' : 'HTTP FAIL',
      r.hallucination.pass ? 'hall ok' : `hall FAIL: ${r.hallucination.reasons.join('; ')}`,
      r.tokenBudget.pass ? 'token ok' : `token FAIL: ${r.tokenBudget.reasons.join('; ')}`,
    ];
    const tok = r.tokens
      ? ` tokens=${r.tokens.total} cost=$${r.tokens.costUsd ?? 0}`
      : ' tokens=n/a';
    console.log(
      `  [${r.id}] ${r.latencyMs}ms${r.ttfbMs != null ? ` ttfb=${r.ttfbMs}ms` : ''}${tok} — ${flags.join(' | ')}`,
    );
  }
  console.log('====================================\n');
}

async function main() {
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
  const creds = await resolveCredentials();
  console.log(`[ai-eval] base=${AI_BASE} user=${creds.username} stream=${USE_STREAM}`);

  const login = await api.login({
    username: creds.username,
    password: creds.password,
    baseURL: AI_BASE,
  });
  if (!login?.accessToken) throw new Error('login failed');
  const userId = login.user?.id || login.userId || login.usr_id;
  const client = createClient(AI_BASE, login.accessToken);

  const startedAt = new Date();
  let usageBefore = null;
  try {
    usageBefore = await getUsageReport(client, {
      from: startedAt.toISOString(),
      groupBy: 'service',
    });
  } catch {
    console.log('[ai-eval] usage/report before skipped (empty or lag)');
  }

  const results = [];
  for (const caseDef of golden.cases) {
    const caseStart = new Date();
    console.log(`[ai-eval] running ${caseDef.id}...`);
    const r = await runCase(client, caseDef, userId, caseStart);
    results.push(r);
    await new Promise((res) => setTimeout(res, 800));
  }

  let usageAfter = null;
  try {
    usageAfter = await getUsageReport(client, {
      from: startedAt.toISOString(),
      groupBy: 'service',
    });
  } catch (e) {
    console.log('[ai-eval] usage/report after failed:', e.message);
  }

  const latencies = results.filter((r) => r.httpOk).map((r) => r.latencyMs);
  const ttfbs = results.filter((r) => r.ttfbMs != null).map((r) => r.ttfbMs);
  const hallucinationFails = results.filter((r) => r.httpOk && !r.hallucination.pass).length;
  const tokenBudgetFails = results.filter((r) => !r.tokenBudget.pass).length;
  const httpFails = results.filter((r) => !r.httpOk).length;
  const passed = results.filter(
    (r) => r.httpOk && r.hallucination.pass && r.tokenBudget.pass,
  ).length;

  const latency = summarizeLatencies(latencies);
  const ttfb = summarizeLatencies(ttfbs);
  const latencyBudget = scoreLatencyBudget(latency, LATENCY_BUDGET);

  const summary = {
    runAt: new Date().toISOString(),
    base: AI_BASE,
    useStream: USE_STREAM,
    total: results.length,
    passed,
    httpFails,
    hallucinationFails,
    hallucinationFailRate: results.length ? hallucinationFails / results.length : 0,
    tokenBudgetFails,
    latency,
    latencyByService: summarizeLatenciesByGroup(results),
    latencyBudget,
    ttfb,
    usageBefore,
    usageAfter,
    results,
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const outPath = path.join(
    REPORT_DIR,
    `ai-eval-${Date.now()}.json`,
  );
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`[ai-eval] wrote ${outPath}`);

  printReport(summary);

  if (config.mongoUri) await mongo.close().catch(() => {});

  const exitFail =
    httpFails > 0 ||
    hallucinationFails > 0 ||
    tokenBudgetFails > 0 ||
    !latencyBudget.pass;
  process.exit(exitFail ? 1 : 0);
}

main().catch((err) => {
  console.error('[ai-eval] fatal:', err.message);
  process.exit(1);
});

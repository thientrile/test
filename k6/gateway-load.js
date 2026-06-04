// HTTP load test: POST /api/auth/login qua api-gateway.
//
//   npm run k6:gateway
//
// Mode (GATEWAY_MODE):
//   rate (default) — GATEWAY_RATE req/s; duration = GATEWAY_REQUESTS/RATE (mặc định 10k @ 70/s)
//   iterations     — shared-iterations (tăng GATEWAY_VUS nếu vẫn chậm)
//
// Cần k6/users.csv (npm run prepare). GATEWAY_PROBE_USERNAME chỉ dùng khi không có csv.

import http from 'k6/http';
import { check } from 'k6';
import { Trend, Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';

const BASE = (
  __ENV.GATEWAY_PROBE_BASE ||
  __ENV.TARGET_BASE ||
  'https://api-gateway-service-475254343480.asia-southeast1.run.app'
).replace(/\/$/, '');

const MODE = (__ENV.GATEWAY_MODE || 'rate').toLowerCase();
const REQUESTS = parseInt(__ENV.GATEWAY_REQUESTS, 10) || 10_000;
const VUS = parseInt(__ENV.GATEWAY_VUS, 10) || 1000;
const RATE = parseInt(__ENV.GATEWAY_RATE, 10) || 50;
const DURATION =
  __ENV.GATEWAY_DURATION || `${Math.ceil(REQUESTS / RATE)}s`;
const MAX_DURATION = __ENV.GATEWAY_MAX_DURATION || '5m';
const PRE_VUS = parseInt(__ENV.GATEWAY_PRE_VUS, 10) || 200;
const MAX_VUS = parseInt(__ENV.GATEWAY_MAX_VUS, 10) || 2000;
const RUN_ID = __ENV.RUN_ID || `${Date.now()}`;

const HTTP_TIMEOUT = __ENV.GATEWAY_TIMEOUT || '30s';

const loginDuration = new Trend('gateway_login_duration', true);
const loginOk = new Counter('gateway_login_ok');
const loginFail = new Counter('gateway_login_fail');
const status2xx = new Counter('gateway_status_2xx');
const status4xx = new Counter('gateway_status_4xx');
const status5xx = new Counter('gateway_status_5xx');
const status429 = new Counter('gateway_status_429');
const status503 = new Counter('gateway_status_503');
const statusTimeout = new Counter('gateway_status_timeout');

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function loadUsers() {
  try {
    const raw = open('./users.csv');
    const lines = raw.trim().split(/\r?\n/);
    lines.shift();
    const users = lines
      .map((line) => {
        const [username, password] = parseCsvLine(line);
        return { username, password };
      })
      .filter((u) => u.username && u.password);
    if (users.length) return users;
  } catch {
    // users.csv missing
  }

  const envUser = __ENV.GATEWAY_PROBE_USERNAME;
  const envPass = __ENV.GATEWAY_PROBE_PASSWORD || __ENV.USER_PASSWORD || 'Loadtest@123';
  if (envUser) {
    return [{ username: envUser, password: envPass }];
  }

  throw new Error(
    'No users: run prepare (users.csv) or set GATEWAY_PROBE_USERNAME',
  );
}

const USERS = new SharedArray('gateway_users', loadUsers);

const scenarios =
  MODE === 'iterations'
    ? {
        gateway_login: {
          executor: 'shared-iterations',
          vus: VUS,
          iterations: REQUESTS,
          maxDuration: MAX_DURATION,
        },
      }
    : {
        gateway_login: {
          executor: 'constant-arrival-rate',
          rate: RATE,
          timeUnit: '1s',
          duration: DURATION,
          preAllocatedVUs: PRE_VUS,
          maxVUs: MAX_VUS,
        },
      };

export const options = {
  scenarios,
  // Ngưỡng mềm — load test capacity discovery, không fail cứng sớm.
  thresholds: {
    gateway_login_ok: ['count>0'],
  },
};

export default function () {
  const i = exec.scenario.iterationInTest;
  const user = USERS[i % USERS.length];
  const url = `${BASE}/api/auth/login`;
  const res = http.post(
    url,
    JSON.stringify({ username: user.username, password: user.password }),
    {
      headers: { 'Content-Type': 'application/json' },
      tags: { name: 'login' },
      timeout: HTTP_TIMEOUT,
    },
  );

  if (res.status === 0) statusTimeout.add(1);
  else if (res.status === 429) status429.add(1);
  else if (res.status === 503) status503.add(1);
  else if (res.status >= 500) status5xx.add(1);
  else if (res.status >= 400) status4xx.add(1);
  else if (res.status >= 200 && res.status < 300) status2xx.add(1);

  const ok = check(res, {
    'status 2xx': (r) => r.status >= 200 && r.status < 300,
    'accessToken in metadata': (r) => {
      try {
        const body = JSON.parse(r.body);
        const meta = body.metadata != null ? body.metadata : body;
        return Boolean(meta?.accessToken);
      } catch {
        return false;
      }
    },
  });

  loginDuration.add(res.timings.duration);
  if (ok) loginOk.add(1);
  else loginFail.add(1);
}

export function handleSummary(data) {
  const out = {
    runId: RUN_ID,
    type: 'gateway-http',
    mode: MODE,
    base: BASE,
    requests: MODE === 'iterations' ? REQUESTS : null,
    rate: MODE === 'rate' ? RATE : null,
    duration: MODE === 'rate' ? DURATION : null,
    vus: MODE === 'iterations' ? VUS : MAX_VUS,
    metrics: data.metrics,
    root_group: data.root_group,
  };
  const path = `./reports/gateway-run-${RUN_ID}.json`;
  return {
    stdout: textSummary(data),
    [path]: JSON.stringify(out, null, 2),
  };
}

function countMetric(m, name) {
  return m[name]?.values?.count ?? 0;
}

function textSummary(data) {
  const m = data.metrics;
  const failed = m.http_req_failed?.values?.rate ?? 0;
  const p95 =
    m.gateway_login_duration?.values?.['p(95)'] ??
    m.http_req_duration?.values?.['p(95)'];
  const ok = countMetric(m, 'gateway_login_ok');
  const durSec = parseDurationSec(DURATION);
  const actualRps = durSec > 0 ? (ok / durSec).toFixed(1) : 'n/a';
  return (
    `\n[gateway-load] ${BASE}  mode=${MODE}  users=${USERS.length}\n` +
    (MODE === 'rate'
      ? `  target:     ${REQUESTS} req @ ${RATE}/s × ${DURATION}\n`
      : `  target:     ${REQUESTS} iterations, ${VUS} VUs, max ${MAX_DURATION}\n`) +
    `  login ok:   ${ok}  (~${actualRps} ok/s thực tế)\n` +
    `  http fail:  ${(failed * 100).toFixed(2)}%\n` +
    `  p95:        ${p95 != null ? `${p95.toFixed(0)}ms` : 'n/a'}\n` +
    `  status:     2xx=${countMetric(m, 'gateway_status_2xx')} ` +
    `4xx=${countMetric(m, 'gateway_status_4xx')} ` +
    `5xx=${countMetric(m, 'gateway_status_5xx')} ` +
    `503=${countMetric(m, 'gateway_status_503')} ` +
    `429=${countMetric(m, 'gateway_status_429')} ` +
    `timeout=${countMetric(m, 'gateway_status_timeout')}\n` +
    (failed > 0.3
      ? `  hint:       BE không chịu nổi ${RATE}/s — giảm GATEWAY_RATE (vd 20–30) hoặc scale Cloud Run\n`
      : '')
  );
}

function parseDurationSec(d) {
  const m = String(d).match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!m) return 100;
  const n = parseFloat(m[1]);
  const u = m[2] || 's';
  if (u === 'ms') return n / 1000;
  if (u === 'm') return n * 60;
  if (u === 'h') return n * 3600;
  return n;
}

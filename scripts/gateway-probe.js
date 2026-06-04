'use strict';

// Smoke: POST /api/auth/login qua api-gateway (TARGET_BASE).
//
//   npm run probe:gateway
//   GATEWAY_PROBE_USERNAME=loadtest_00001@loadtest.local npm run probe:gateway

const fs = require('fs');
const path = require('path');

const { config } = require('../lib/config');
const api = require('../lib/api');
const mongo = require('../lib/mongo');

const USERS_CSV = path.join(__dirname, '..', 'k6', 'users.csv');

async function resolveCredentials() {
  const fromEnv = process.env.GATEWAY_PROBE_USERNAME;
  if (fromEnv) {
    return {
      username: fromEnv,
      password: process.env.GATEWAY_PROBE_PASSWORD || config.userPassword,
      source: 'env',
    };
  }

  if (fs.existsSync(USERS_CSV)) {
    const lines = fs.readFileSync(USERS_CSV, 'utf8').trim().split(/\r?\n/);
    if (lines.length > 1) {
      const [username, password] = lines[1].split(',');
      if (username && password) {
        return { username, password, source: 'k6/users.csv' };
      }
    }
  }

  if (!config.mongoUri) {
    throw new Error(
      'Set GATEWAY_PROBE_USERNAME, or run prepare (users.csv), or bootstrap + MONGO_URI',
    );
  }

  await mongo.connect();
  const users = await mongo.getAllUsers();
  if (!users.length) {
    throw new Error('loadtest_users empty — run npm run bootstrap first');
  }
  const u = users[0];
  return {
    username: u.username,
    password: u.password || config.userPassword,
    source: `mongo:${config.testUsersColl}`,
  };
}

async function main() {
  console.log('[gateway-probe] target:', config.gatewayProbeBase);

  const creds = await resolveCredentials();
  console.log(`[gateway-probe] login as ${creds.username} (${creds.source})`);

  const t0 = Date.now();
  try {
    const data = await api.login({
      username: creds.username,
      password: creds.password,
      baseURL: config.gatewayProbeBase,
    });
    if (!data?.accessToken) {
      throw new Error('no accessToken in response metadata');
    }
    const ms = Date.now() - t0;
    console.log(`  OK   POST /api/auth/login (${ms}ms) — token ${data.accessToken.slice(0, 12)}…`);
    process.exit(0);
  } catch (err) {
    const ms = Date.now() - t0;
    console.log(`  FAIL POST /api/auth/login (${ms}ms) — ${err.message}`);
    process.exit(1);
  } finally {
    if (config.mongoUri) {
      await mongo.close().catch(() => {});
    }
  }
}

main().catch((err) => {
  console.error('[gateway-probe] fatal:', err.message);
  process.exit(1);
});

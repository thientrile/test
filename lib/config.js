'use strict';

const path = require('path');

// Load `.env.local` trước (override), sau đó `.env` (fallback). dotenv
// không ghi đè biến đã set, nên thứ tự này = `.env.local` thắng. Cho phép
// chạy test trỏ vào BE local (`.env.local`) hoặc Docker/Cloud Run
// (`.env`) mà không cần đổi file gốc.
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env.local') });
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

function int(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

const config = {
  userCount: int(process.env.USER_COUNT, 1000),
  userPrefix: process.env.USER_PREFIX || 'loadtest_',
  userPassword: process.env.USER_PASSWORD || 'Loadtest@123',
  roomName: process.env.ROOM_NAME || 'loadtest-group',

  targetBase: process.env.TARGET_BASE || 'http://nginx:8080',
  socketBase: process.env.SOCKET_BASE || 'ws://nginx:8080',
  socketNamespace: process.env.SOCKET_NAMESPACE || '/chat',

  mongoUri: process.env.MONGO_URI,
  mongoDb: process.env.MONGO_DB || 'appchat',
  testUsersColl: process.env.TEST_USERS_COLL || 'loadtest_users',
  testRoomsColl: process.env.TEST_ROOMS_COLL || 'loadtest_rooms',

  redisUrl: process.env.REDIS_URL,
  barrierKey: process.env.BARRIER_KEY || 'loadtest:barrier:joined',
  roomIdKey: process.env.ROOMID_KEY || 'loadtest:active:roomId',
  goChannel: process.env.GO_CHANNEL || 'loadtest:ready:go',
  readyFlagKey: process.env.READY_FLAG_KEY || 'loadtest:prep:ready',
  userPickKey: process.env.USERPICK_KEY || 'loadtest:userpick',
  metricPrefix: process.env.METRIC_PREFIX || 'loadtest:metric:',

  rampDuration: int(process.env.RAMP_DURATION, 30),
  thinkAfterGo: int(process.env.THINK_AFTER_GO, 2),
  joinDelayMs: int(process.env.JOIN_DELAY_MS, 100),
};

function assertRequired() {
  const required = ['mongoUri', 'redisUrl'];
  const missing = required.filter((k) => !config[k]);
  if (missing.length) {
    throw new Error(`Missing required env: ${missing.join(', ')}`);
  }
}

module.exports = { config, assertRequired };

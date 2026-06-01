'use strict';

const fs = require('fs');
const path = require('path');
const { ObjectId } = require('mongodb');

const { config, assertRequired } = require('../lib/config');
const api = require('../lib/api');
const mongo = require('../lib/mongo');

// k6 reads these two files at init (open()) — the VU path is Redis-free.
const USERS_CSV = path.join(__dirname, '..', 'k6', 'users.csv');
const ROOM_JSON = path.join(__dirname, '..', 'k6', 'room.json');

function writeRoomJson(roomId) {
  fs.mkdirSync(path.dirname(ROOM_JSON), { recursive: true });
  fs.writeFileSync(ROOM_JSON, JSON.stringify({ roomId }, null, 2) + '\n', 'utf8');
}

function csvEscape(v) {
  const s = String(v == null ? '' : v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function writeUsersCsv(users) {
  const headers = ['username', 'password', 'accessToken', 'userId', 'fullname', 'roomId'];
  const lines = [headers.join(',')];
  for (const u of users) {
    lines.push(
      [u.username, u.password, u.accessToken, u.userId, u.fullname, u.roomId || '']
        .map(csvEscape)
        .join(','),
    );
  }
  fs.mkdirSync(path.dirname(USERS_CSV), { recursive: true });
  fs.writeFileSync(USERS_CSV, lines.join('\n') + '\n', 'utf8');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Create ONE group room (admin = group[0], the rest are memberIds) and return
// its BUSINESS room_id. A 100-member room is created in a single createRoom
// (small payload, fast) — unlike a 10k-member room, which the BE can't build:
// addMember on a >~4000-member room exceeds the gRPC 20s deadline ("Service
// unavailable: Timeout"). So we shard users into many small rooms instead.
// Retries a few times for transient 502/timeout from the gateway.
async function createRoomWithRetry(admin, memberIds, idx) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const room = await api.createGroupRoom({
        accessToken: admin.accessToken,
        name: `${config.roomName}-${idx}-${Date.now()}`,
        memberIds,
      });
      const roomMongoId = room?._id || room?.id || room?.roomId;
      if (!roomMongoId) throw new Error('createRoom returned no id');
      // createRoom returns the Mongo `_id`; the message path matches by the
      // BUSINESS `room_id`. Resolve and hand THAT to the VUs.
      const roomDoc = await mongo
        .appRoomsColl()
        .findOne(
          { _id: new ObjectId(String(roomMongoId)) },
          { projection: { room_id: 1 } },
        );
      if (roomDoc?.room_id) return roomDoc.room_id;
      throw new Error('could not resolve business room_id');
    } catch (err) {
      if (attempt === 3) {
        console.warn(`[prepare] room ${idx} create failed (gave up): ${err.message}`);
        return null;
      }
      await sleep(1000 * attempt);
    }
  }
  return null;
}

async function main() {
  assertRequired();
  console.log(`[prepare] starting — target=${config.targetBase}`);

  await mongo.connect();
  const users = await mongo.getAllUsers();
  // Đăng ký hàng loạt luôn rớt vài user (timeout/502 transient). Đừng chặn cả
  // test vì thiếu vài user — chạy với số thực có. k6 wrap VU bằng modulo nên
  // USER_COUNT VU vẫn đủ (vài VU cuối dùng lại user đầu, vẫn là member room).
  if (users.length === 0) {
    throw new Error('no loadtest_users found — run bootstrap first');
  }
  if (users.length < config.userCount) {
    console.warn(
      `[prepare] chỉ có ${users.length}/${config.userCount} loadtest_users (vài user rớt khi bootstrap) — chạy test với ${users.length}. Chạy lại bootstrap nếu muốn đủ.`,
    );
  }
  const slice = users.slice(0, config.userCount); // = users.length nếu thiếu
  console.log(`[prepare] using ${slice.length} users from mongo`);

  // Token handling. Re-logging in all N users HAMMERS the auth service (the
  // 502 wall you saw — 9997 logins is itself a DoS) AND is slow. The tokens
  // stored by bootstrap (1 day TTL) are normally still valid, so by DEFAULT we
  // REUSE them and do NOT re-login. Opt in with REFRESH_TOKENS=1 only if a run
  // shows lots of connect 401s (expired tokens) — and prefer a low
  // REFRESH_CONCURRENCY so you don't knock auth over.
  if (!process.env.REFRESH_TOKENS) {
    console.log(
      `[prepare] reusing stored bootstrap tokens for ${slice.length} users (no re-login). Set REFRESH_TOKENS=1 to force refresh.`,
    );
  } else {
    console.log('[prepare] refreshing access tokens via /auth/login ...');
    const start = Date.now();
    let refreshed = 0;
    const concurrency = parseInt(process.env.REFRESH_CONCURRENCY, 10) || 25;
    let idx = 0;
    async function worker() {
      while (true) {
        const i = idx++;
        if (i >= slice.length) return;
        const u = slice[i];
        try {
          const r = await api.login({ username: u.username, password: u.password });
          u.accessToken = r.accessToken;
          // BE `createRoom` match thành viên bằng `usr_id` (business id 22-hex),
          // không phải Mongo `_id`. Login response trả `user.id = usr_id` sau
          // khi unprefix. Lưu sai field sẽ làm 0 match → throw "ít hơn 3" →
          // 503 ở gateway.
          u.userId = r.user?.id || u.userId;
          await mongo.upsertUser(u);
          refreshed++;
        } catch (err) {
          console.warn(`[prepare] login fail ${u.username}: ${err.message}`);
        }
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    console.log(
      `[prepare] refreshed ${refreshed}/${slice.length} tokens in ${((Date.now() - start) / 1000).toFixed(1)}s`,
    );
  }

  // ── Shard users into many small rooms ─────────────────────────────────────
  // One 10k-member room is BE-infeasible: addMember times out (gRPC 20s) once
  // the room passes ~4000 members. Instead create N rooms of ROOM_SIZE each and
  // give every user their own room. Each room is one fast createRoom (~100
  // members ≈ 2.5KB) — no 413, no addMember.
  const ROOM_SIZE = parseInt(process.env.ROOM_SIZE, 10) || 100;

  // Reuse if every user already has a roomId from a previous run AND a sample
  // room still exists. FRESH_ROOM=1 forces a rebuild.
  let reused = false;
  if (!process.env.FRESH_ROOM && slice.length > 0 && slice.every((u) => u.roomId)) {
    const sample = slice[0].roomId;
    const doc = await mongo
      .appRoomsColl()
      .findOne({ room_id: sample }, { projection: { room_members: 1 } });
    if (doc && (doc.room_members?.length || 0) > 0) {
      reused = true;
      const nRooms = new Set(slice.map((u) => u.roomId)).size;
      console.log(`[prepare] reusing ${nRooms} existing rooms — set FRESH_ROOM=1 to rebuild`);
    }
  }

  if (!reused) {
    const groups = [];
    for (let i = 0; i < slice.length; i += ROOM_SIZE) {
      groups.push(slice.slice(i, i + ROOM_SIZE));
    }
    console.log(`[prepare] creating ${groups.length} rooms × ~${ROOM_SIZE} members ...`);

    const concurrency = parseInt(process.env.ROOM_CONCURRENCY, 10) || 8;
    let gi = 0;
    let created = 0;
    async function roomWorker() {
      while (true) {
        const idx = gi++;
        if (idx >= groups.length) return;
        const group = groups[idx];
        const admin = group[0]; // creator must have a valid token (member)
        const memberIds = group.map((u) => u.userId).filter(Boolean);
        const roomId = await createRoomWithRetry(admin, memberIds, idx);
        if (roomId) {
          for (const u of group) u.roomId = roomId;
          created += 1;
          await mongo.saveRoom({
            roomId,
            name: `${config.roomName}-${idx}`,
            memberCount: memberIds.length,
            adminUserId: admin.userId,
          });
          if (created % 10 === 0) {
            console.log(`[prepare] rooms created: ${created}/${groups.length}`);
          }
        }
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => roomWorker()));
    console.log(`[prepare] created ${created}/${groups.length} rooms`);

    // Persist roomId per user so the next run reuses instead of rebuilding.
    const ops = slice
      .filter((u) => u.roomId)
      .map((u) => ({
        updateOne: {
          filter: { username: u.username },
          update: { $set: { roomId: u.roomId } },
        },
      }));
    if (ops.length) await mongo.usersColl().bulkWrite(ops, { ordered: false });
  }

  const assigned = slice.filter((u) => u.roomId).length;
  console.log(`[prepare] ${assigned}/${slice.length} users assigned to a room`);

  // Write the CSV (now WITH a per-user roomId column) for k6 to read.
  writeUsersCsv(slice);
  console.log(`[prepare] wrote ${USERS_CSV}`);

  // room.json keeps the first room as a fallback / for probe.js.
  const firstRoom = (slice.find((u) => u.roomId) || {}).roomId || '';
  writeRoomJson(firstRoom);
  console.log(`[prepare] wrote ${ROOM_JSON} (firstRoom=${firstRoom})`);

  await mongo.close();
  console.log('[prepare] done.');
}

main().catch(async (err) => {
  console.error('[prepare] fatal:', err);
  try {
    await mongo.close();
  } catch {}
  process.exit(1);
});

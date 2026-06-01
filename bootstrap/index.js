'use strict';

// Bootstrap — register N load-test users without going through the
// production OTP/register API (which is gated by a tempRegisterToken
// emitted only after a real email-OTP verify). We have direct Mongo
// access to the same instance the auth service uses, so we insert
// User documents into appchat.Users with a bcrypt-hashed password,
// then use the regular POST /api/auth/login to obtain accessTokens.
//
// Idempotent: re-running detects existing users by usr_email and
// skips inserts, only refreshing tokens.

const bcrypt = require('bcryptjs');
const { config, assertRequired } = require('../lib/config');
const api = require('../lib/api');
const mongo = require('../lib/mongo');

// ---- Mirror of libs/helpers Utils.randomId ------------------------------
// 22-hex-char ULID-like id: 12 (ms time) + 6 (seq) + 4 (rand). The User
// schema has @Prop defaults for usr_id and usr_slug that call this on
// insert — but those defaults only fire when going through Mongoose, not
// raw MongoClient inserts. So we generate them ourselves.
let _lastMs = 0;
let _seq = 0;
function randomId() {
  let now = Date.now();
  if (now < _lastMs) now = _lastMs;
  if (now === _lastMs) {
    if (++_seq > 0xffffff) {
      _lastMs = _lastMs + 1;
      _seq = 0;
    }
  } else {
    _lastMs = now;
    _seq = 0;
  }
  const t = _lastMs.toString(16).padStart(12, '0');
  const s = _seq.toString(16).padStart(6, '0');
  const r = ((Math.random() * 0x10000) | 0).toString(16).padStart(4, '0');
  return `${t}${s}${r}`;
}

function pad(n, w = 5) {
  return String(n).padStart(w, '0');
}
function usernameFor(i) {
  return `${config.userPrefix}${pad(i)}@loadtest.local`;
}
function fullnameFor(i) {
  return `LoadTest ${pad(i)}`;
}

function buildUserDoc(i, passwordHash) {
  const now = new Date();
  return {
    usr_id: randomId(),
    usr_slug: `usr_${randomId()}`,
    usr_fullname: fullnameFor(i),
    usr_email: usernameFor(i),
    usr_phone: '',
    usr_salt: passwordHash,
    usr_avatar: 'https://example.com/default-avatar.png',
    usr_dateOfBirth: new Date('2000-01-01T00:00:00Z'),
    usr_gender: 'other',
    usr_address: '',
    usr_status: 'active',
    createdAt: now,
    updatedAt: now,
    __v: 0,
  };
}

async function processWithConcurrency(items, worker, { concurrency, onProgress }) {
  let index = 0;
  let completed = 0;
  const results = new Array(items.length);
  const errors = [];

  async function runner() {
    while (true) {
      const myIdx = index++;
      if (myIdx >= items.length) return;
      try {
        results[myIdx] = await worker(items[myIdx], myIdx);
      } catch (err) {
        errors.push({ idx: myIdx, item: items[myIdx], error: err.message });
      }
      completed++;
      if (onProgress) onProgress(completed, items.length);
    }
  }

  const runners = Array.from({ length: concurrency }, () => runner());
  await Promise.all(runners);
  return { results, errors };
}

async function main() {
  assertRequired();
  const start = Date.now();
  console.log(
    `[bootstrap] target=${config.targetBase}  users=${config.userCount}  prefix=${config.userPrefix}`,
  );

  await mongo.connect();

  // 1) Insert missing users directly into appchat.Users.
  const allEmails = Array.from({ length: config.userCount }, (_, i) =>
    usernameFor(i),
  );
  const existing = await mongo
    .appUsersColl()
    .find({ usr_email: { $in: allEmails } }, { projection: { usr_email: 1 } })
    .toArray();
  const existingSet = new Set(existing.map((d) => d.usr_email));
  console.log(
    `[bootstrap] appchat.Users: ${existingSet.size}/${config.userCount} already present`,
  );

  if (existingSet.size < config.userCount) {
    console.log('[bootstrap] hashing password (bcrypt)...');
    // All users share the same password, so we only hash once. The
    // bcrypt format embeds the salt in the output, so every user has
    // the same usr_salt value — login still works because compare()
    // re-hashes the input plaintext using the embedded salt.
    const passwordHash = await bcrypt.hash(config.userPassword, 10);

    const toInsert = [];
    for (let i = 0; i < config.userCount; i++) {
      if (existingSet.has(usernameFor(i))) continue;
      toInsert.push(buildUserDoc(i, passwordHash));
    }

    const BATCH = 500;
    for (let i = 0; i < toInsert.length; i += BATCH) {
      const batch = toInsert.slice(i, i + BATCH);
      try {
        await mongo.appUsersColl().insertMany(batch, { ordered: false });
      } catch (err) {
        // ordered:false continues past dup-key errors — just log them
        const inserted = err?.result?.insertedCount;
        console.warn(
          `[bootstrap] batch ${i}-${i + batch.length} partial: ` +
            `inserted=${inserted ?? 'unknown'}, err=${err.message}`,
        );
      }
      console.log(
        `[bootstrap] inserted ${Math.min(i + BATCH, toInsert.length)}/${toInsert.length} into appchat.Users`,
      );
    }
  } else {
    console.log('[bootstrap] all users already in appchat.Users — skip insert');
  }

  // 2) Login each user to obtain a fresh accessToken, save to
  //    test.loadtest_users for the test runner to consume.
  console.log('[bootstrap] logging in users to fetch accessTokens...');
  const indexes = Array.from({ length: config.userCount }, (_, i) => i);

  const onProgress = (done, total) => {
    if (done % 50 === 0 || done === total) {
      const pct = ((done / total) * 100).toFixed(1);
      const rate = (done / ((Date.now() - start) / 1000)).toFixed(1);
      console.log(`[bootstrap] login ${done}/${total} (${pct}%, ${rate}/s)`);
    }
  };

  const { results, errors } = await processWithConcurrency(
    indexes,
    async (i) => {
      const username = usernameFor(i);
      const password = config.userPassword;
      const r = await api.login({ username, password });
      // BE `createRoom` query thành viên bằng `usr_id` (business id, 22-hex)
      // chứ KHÔNG phải Mongo `_id`. auth.service trả `user.id = usr_id`
      // (đã unprefix 'usr_'), còn `user._id` là ObjectId. Lưu nhầm `_id` →
      // sau này createRoom không match, throw "thành viên ít hơn 3" và
      // bị wrap thành 503 ở gateway.
      const doc = {
        username,
        fullname: fullnameFor(i),
        password,
        userId: r.user?.id,
        accessToken: r.accessToken,
        refreshToken: r.refreshToken,
        via: 'login',
      };
      await mongo.upsertUser(doc);
      return doc;
    },
    { concurrency: 25, onProgress },
  );

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const ok = results.filter(Boolean).length;
  console.log(
    `[bootstrap] done in ${elapsed}s — ok=${ok}, errors=${errors.length}`,
  );

  if (errors.length) {
    console.log('[bootstrap] first 10 errors:');
    errors.slice(0, 10).forEach((e) => {
      console.log(`  idx=${e.idx}: ${e.error}`);
    });
  }

  await mongo.close();
  process.exit(errors.length > 0 && ok < config.userCount * 0.95 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('[bootstrap] fatal:', err);
  try {
    await mongo.close();
  } catch {}
  process.exit(1);
});

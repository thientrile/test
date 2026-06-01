'use strict';

// Cleanup script — removes:
//   - test.loadtest_users   (our credential cache)
//   - test.loadtest_rooms   (our room metadata)
//   - appchat.users where usr_email starts with USER_PREFIX
//   - appchat.rooms whose _id is in loadtest_rooms (best-effort)
//   - Redis keys with our loadtest:* prefix
//
// Run with --dry to preview without deleting.

const { MongoClient } = require('mongodb');
const Redis = require('ioredis');
const { config, assertRequired } = require('../lib/config');

const DRY = process.argv.includes('--dry');

async function main() {
  assertRequired();
  console.log(`[reset] mode=${DRY ? 'DRY-RUN' : 'DELETE'}  prefix="${config.userPrefix}"`);

  // --- Mongo: drop test bookkeeping + appchat user/room rows we created ---
  const client = new MongoClient(config.mongoUri);
  await client.connect();
  try {
    const testDb = client.db(config.mongoDb);
    const appDb = client.db('appchat');

    const usersInCache = await testDb
      .collection(config.testUsersColl)
      .countDocuments();
    const roomsInCache = await testDb
      .collection(config.testRoomsColl)
      .find({}, { projection: { roomId: 1 } })
      .toArray();
    console.log(
      `[reset] test.${config.testUsersColl}: ${usersInCache} docs`,
    );
    console.log(
      `[reset] test.${config.testRoomsColl}: ${roomsInCache.length} docs`,
    );

    // Match users created by bootstrap — usr_email starts with prefix and
    // ends with @loadtest.local. Conservative: prefix + suffix both required.
    const emailRegex = new RegExp(
      `^${config.userPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d+@loadtest\\.local$`,
    );
    const appUserCount = await appDb
      .collection('Users')
      .countDocuments({ usr_email: emailRegex });
    console.log(
      `[reset] appchat.Users matching ${emailRegex}: ${appUserCount}`,
    );

    if (DRY) {
      console.log('[reset] DRY-RUN — no deletes performed.');
    } else {
      const r1 = await testDb.collection(config.testUsersColl).deleteMany({});
      console.log(`[reset] deleted ${r1.deletedCount} from test.${config.testUsersColl}`);

      const r2 = await testDb.collection(config.testRoomsColl).deleteMany({});
      console.log(`[reset] deleted ${r2.deletedCount} from test.${config.testRoomsColl}`);

      // appchat.Users — note: capital "U" per the User model @Schema:
      //   @Schema({ timestamps: true, collection: 'Users' })
      const r3 = await appDb
        .collection('Users')
        .deleteMany({ usr_email: emailRegex });
      console.log(`[reset] deleted ${r3.deletedCount} from appchat.Users`);

      // appchat.Rooms — name from room.model.ts collectionNames = 'Rooms'
      const roomIds = roomsInCache
        .map((r) => r.roomId)
        .filter(Boolean);
      if (roomIds.length) {
        const { ObjectId } = require('mongodb');
        const objIds = roomIds
          .map((id) => {
            try {
              return new ObjectId(id);
            } catch {
              return null;
            }
          })
          .filter(Boolean);

        if (objIds.length) {
          const r = await appDb
            .collection('Rooms')
            .deleteMany({ _id: { $in: objIds } });
          console.log(`[reset] deleted ${r.deletedCount} from appchat.Rooms`);
        }
      }

      // Best-effort: also nuke per-room state docs (mute / pinned /
      // read markers) that may reference the deleted rooms. Skipping
      // these isn't dangerous — just leaves orphans — so swallow any
      // missing-collection or schema mismatch.
      for (const coll of ['RoomsUsersState', 'RoomsState', 'RoomEvents']) {
        try {
          const r = await appDb.collection(coll).deleteMany({
            $or: [
              { room_id: { $in: roomIds } },
              { roomId: { $in: roomIds } },
            ],
          });
          if (r.deletedCount) {
            console.log(`[reset] deleted ${r.deletedCount} from appchat.${coll}`);
          }
        } catch {
          // ignore
        }
      }
    }
  } finally {
    await client.close();
  }

  // --- Redis: nuke our keys ---
  const redis = new Redis(config.redisUrl);
  const pattern = 'loadtest:*';
  const keys = await redis.keys(pattern);
  console.log(`[reset] redis keys matching ${pattern}: ${keys.length}`);
  if (keys.length && !DRY) {
    const r = await redis.del(...keys);
    console.log(`[reset] redis deleted ${r} keys`);
  }
  await redis.quit();

  console.log('[reset] done.');
}

main().catch((err) => {
  console.error('[reset] fatal:', err);
  process.exit(1);
});

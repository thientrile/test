'use strict';

const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
const Redis = require('ioredis');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function main() {
  const r = new Redis(process.env.REDIS_URL);
  const roomId = await r.get(process.env.ROOMID_KEY || 'loadtest:active:roomId');
  await r.quit();
  console.log('[probe-room] roomId =', roomId, '(len', roomId && roomId.length, ')');

  const client = new MongoClient(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  await client.connect();

  let oid = null;
  try { oid = new ObjectId(roomId); } catch {}

  for (const dbName of ['appchat']) {
    const db = client.db(dbName);
    const colls = await db.listCollections().toArray();
    console.log(`\n=== DB ${dbName}: ${colls.length} collections ===`);
    for (const c of colls) {
      const coll = db.collection(c.name);
      let hit = null;
      if (oid) hit = await coll.findOne({ _id: oid });
      if (!hit) hit = await coll.findOne({ room_id: roomId });
      if (hit) {
        console.log(`\n>>> FOUND in collection "${c.name}"`);
        console.log('  _id      =', String(hit._id));
        console.log('  room_id  =', hit.room_id);
        console.log('  room_type=', hit.room_type);
        console.log('  members  =', Array.isArray(hit.room_members) ? hit.room_members.length : 'n/a');
        if (Array.isArray(hit.room_members)) {
          console.log('  sample   =', JSON.stringify(hit.room_members.slice(0, 2)
            .map((m) => ({ user_id: String(m.user_id), id: m.id, role: m.role }))));
          const uid = '6a15d08216ab73e0523c5c62';
          console.log(`  user ${uid} is member (by user_id)?`,
            hit.room_members.some((m) => String(m.user_id) === uid));
          console.log(`  user usr_id 019e65367f41000000f3aa is member (by id)?`,
            hit.room_members.some((m) => String(m.id) === '019e65367f41000000f3aa'));
        }
      }
    }
  }

  await client.close();
}

main().catch((e) => { console.error('[probe-room] fatal:', e); process.exit(1); });

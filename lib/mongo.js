'use strict';

const { MongoClient } = require('mongodb');
const { config } = require('./config');

let client = null;
let db = null;

async function connect() {
  if (db) return db;
  client = new MongoClient(config.mongoUri, {
    serverSelectionTimeoutMS: 10_000,
  });
  await client.connect();
  db = client.db(config.mongoDb);

  // Index for fast lookup by username
  const users = db.collection(config.testUsersColl);
  await users.createIndex({ username: 1 }, { unique: true });

  return db;
}

async function close() {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

function usersColl() {
  if (!db) throw new Error('mongo not connected — call connect() first');
  return db.collection(config.testUsersColl);
}

function roomsColl() {
  if (!db) throw new Error('mongo not connected — call connect() first');
  return db.collection(config.testRoomsColl);
}

// The real `appchat` database — where auth service reads/writes the
// canonical User documents. We insert load-test users directly here
// (bypassing the OTP-gated /auth/register endpoint) and then use the
// regular /auth/login API to obtain accessTokens.
//
// Collection name comes from the User model's @Schema decorator in
// app-nest-be/libs/db/src/mongo/model/user.model.ts:
//   @Schema({ timestamps: true, collection: 'Users' })
function appUsersColl() {
  if (!client) throw new Error('mongo not connected — call connect() first');
  return client.db('appchat').collection('Users');
}

// The chat room documents (room_id business id, room_members, room_type).
// The message path matches rooms by the BUSINESS `room_id` field, not Mongo
// `_id` — see prepare.js where we resolve it.
function appRoomsColl() {
  if (!client) throw new Error('mongo not connected — call connect() first');
  return client.db('appchat').collection('Rooms');
}

async function getAllUsers() {
  return usersColl()
    .find({}, { projection: { _id: 0 } })
    .sort({ username: 1 })
    .toArray();
}

async function getUserCount() {
  return usersColl().countDocuments();
}

async function findUser(username) {
  return usersColl().findOne({ username });
}

async function upsertUser(doc) {
  return usersColl().updateOne(
    { username: doc.username },
    { $set: { ...doc, updatedAt: new Date() } },
    { upsert: true },
  );
}

async function saveRoom(doc) {
  return roomsColl().insertOne({ ...doc, createdAt: new Date() });
}

async function getLatestRoom() {
  return roomsColl().findOne({}, { sort: { createdAt: -1 } });
}

module.exports = {
  connect,
  close,
  usersColl,
  roomsColl,
  appUsersColl,
  appRoomsColl,
  getAllUsers,
  getUserCount,
  findUser,
  upsertUser,
  saveRoom,
  getLatestRoom,
};

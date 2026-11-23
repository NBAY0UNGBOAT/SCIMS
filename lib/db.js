const { MongoClient } = require('mongodb');

const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
let connection;

async function database() {
  if (!connection) connection = client.connect();
  await connection;
  return client.db();
}

async function closeDatabase() {
  if (connection) await client.close();
}

async function withTransaction(work) {
  const db = await database();
  return client.withSession((session) => session.withTransaction(() => work(db, session), {
    readPreference: 'primary',
    writeConcern: { w: 'majority' },
  }));
}

module.exports = { database, closeDatabase, withTransaction };

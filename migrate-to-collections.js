require('dotenv').config();

const { database, closeDatabase } = require('./lib/db');
const { collectionDocuments, collectionKeys } = require('./lib/collections');

const migrationId = 'app-state-to-collections-v1';

async function replaceDocuments(db, collectionName, documents) {
  const key = collectionKeys[collectionName];
  await db.collection(collectionName).bulkWrite(documents.map((document) => ({
    replaceOne: { filter: { [key]: document[key] }, replacement: document, upsert: true },
  })));
}

async function migrate() {
  const db = await database();
  if (await db.collection('migrations').findOne({ _id: migrationId })) {
    console.log('Migration already completed. The app_state backup remains untouched.');
    return;
  }
  const source = await db.collection('app_state').findOne({ _id: 'current' });
  if (!source) throw new Error('No app_state document found to migrate.');

  const documents = collectionDocuments(source);
  for (const [collectionName, entries] of Object.entries(documents)) await replaceDocuments(db, collectionName, entries);
  await Promise.all([
    db.collection('users').createIndex({ email: 1 }, { unique: true }),
    db.collection('customers').createIndex({ id: 1 }, { unique: true }),
    db.collection('quotations').createIndex({ id: 1 }, { unique: true }),
    db.collection('bookings').createIndex({ id: 1 }, { unique: true }),
    db.collection('bookings').createIndex({ eventDate: 1 }),
    db.collection('auditLogs').createIndex({ auditId: 1 }, { unique: true }),
  ]);
  await db.collection('migrations').insertOne({ _id: migrationId, migratedAt: new Date(), source: 'app_state/current' });
  console.log(`Migrated ${Object.values(documents).reduce((total, entries) => total + entries.length, 0)} records into separate collections. app_state was retained as a backup.`);
}

migrate().catch((error) => {
  console.error('Migration failed:', error.message);
  process.exitCode = 1;
}).finally(closeDatabase);

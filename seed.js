require('dotenv').config();

const bcrypt = require('bcryptjs');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { database, closeDatabase } = require('./lib/db');
const { collectionDocuments } = require('./lib/collections');

function readDemoState() {
  const html = fs.readFileSync(path.join(__dirname, 'SCIMS_Project_Prototype-4.html'), 'utf8');
  const start = html.indexOf('const roleColors =');
  const end = html.indexOf('// ---------------- HELPERS ----------------');
  if (start < 0 || end < 0) throw new Error('Could not find the prototype demo data');
  const source = html.slice(start, end);
  return JSON.parse(vm.runInNewContext(`${source}\nJSON.stringify({ users, customers, inquiries, quotations, bookings, staff, checklistState, auditLog })`));
}

async function seed() {
  const db = await database();
  const exists = await db.collection('users').findOne({});
  if (exists && process.argv[2] !== '--force') {
    console.log('Seed skipped: users already exist. Use "node seed.js --force" to replace collection data.');
    return;
  }

  const state = readDemoState();
  state.users = await Promise.all(state.users.map(async (user) => ({
    ...user,
    passwordHash: await bcrypt.hash('demo1234', 12),
  })));
  const documents = collectionDocuments(state);
  for (const [collectionName, entries] of Object.entries(documents)) {
    if (process.argv[2] === '--force') await db.collection(collectionName).deleteMany({});
    if (entries.length) await db.collection(collectionName).insertMany(entries);
  }
  console.log(`Seeded ${state.users.length} users and ${state.bookings.length} bookings.`);
}

seed().catch((error) => {
  console.error('Seeding failed:', error.message);
  process.exitCode = 1;
}).finally(closeDatabase);

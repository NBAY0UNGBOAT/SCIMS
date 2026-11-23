require('dotenv').config();

const bcrypt = require('bcryptjs');
const express = require('express');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const path = require('node:path');
const { database, closeDatabase } = require('./lib/db');
const { collectionDocuments, collectionKeys, stateFromCollections } = require('./lib/collections');
const { createLoginRateLimiter } = require('./lib/login-rate-limit');
const { sanitizeState, validateState } = require('./lib/state');
const { accessFor, canWrite, isAdmin } = require('./lib/access');
const { introducedConflicts, newlyConfirmed } = require('./lib/bookings');
const { randomUUID } = require('node:crypto');

if (!process.env.MONGODB_URI || !process.env.JWT_SECRET) throw new Error('MONGODB_URI and JWT_SECRET are required');

const app = express();
const loginLimiter = createLoginRateLimiter({ limit: 10, windowMs: 15 * 60 * 1000 });
const COOKIE_NAME = 'scims_session';

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
    },
  },
}));
app.use(express.json({ limit: '2mb' }));
app.get('/', (_request, response) => response.sendFile(path.join(__dirname, 'SCIMS_Project_Prototype-4.html')));
app.use(express.static(__dirname));

function cookieValue(request, name) {
  return request.headers.cookie?.split(';').map((value) => value.trim()).find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

function auth(request, response, next) {
  try {
    request.user = jwt.verify(cookieValue(request, COOKIE_NAME), process.env.JWT_SECRET);
    next();
  } catch {
    response.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Please sign in.' } });
  }
}

function ownerOnly(request, response, next) {
  if (request.user.role !== 'Owner') return response.status(403).json({ error: { code: 'FORBIDDEN', message: 'Owner access is required.' } });
  next();
}

async function currentState() {
  const db = await database();
  const [users, customers, inquiries, quotations, bookings, staff, checklists, auditLogs] = await Promise.all([
    db.collection('users').find().toArray(),
    db.collection('customers').find().toArray(),
    db.collection('inquiries').find().toArray(),
    db.collection('quotations').find().toArray(),
    db.collection('bookings').find().toArray(),
    db.collection('staff').find().toArray(),
    db.collection('checklists').find().toArray(),
    db.collection('auditLogs').find().toArray(),
  ]);
  return stateFromCollections({ users, customers, inquiries, quotations, bookings, staff, checklists, auditLogs });
}

async function syncCollection(db, collectionName, documents) {
  const key = collectionKeys[collectionName];
  const collection = db.collection(collectionName);
  if (!documents.length) return collection.deleteMany({});
  await collection.deleteMany({ [key]: { $nin: documents.map((document) => document[key]) } });
  await collection.bulkWrite(documents.map((document) => ({
    replaceOne: { filter: { [key]: document[key] }, replacement: document, upsert: true },
  })));
}

}

const STATE_KEYS = { users: 'users', customers: 'customers', inquiries: 'inquiries', quotations: 'quotations', bookings: 'bookings', staff: 'staff', checklists: 'checklistState' };

async function saveState(state, collections) {
  const db = await database();
  const documents = collectionDocuments(state);
  await Promise.all(collections.map((name) => syncCollection(db, name, documents[name])));
}

// Audit entries are append-only and stamped by the server (actor + time come from the session, not the client).
async function appendAudit(existing, incoming, user) {
  const known = new Set(existing.map((entry) => entry.auditId));
  const added = incoming.filter((entry) => !known.has(entry.auditId)).map((entry) => ({
    auditId: entry.auditId || randomUUID(),
    actor: user.name,
    action: String(entry.action || '').slice(0, 300),
    meta: String(entry.meta || '').slice(0, 300),
    time: new Date().toISOString(),
  }));
  if (added.length) await (await database()).collection('auditLogs').insertMany(added);
  return added;
}

function visibleState(state, role) {
  const admin = isAdmin(accessFor(role));
  return sanitizeState({ ...state, users: admin ? state.users : [], auditLog: admin ? state.auditLog : [] });
}

app.get('/api/health', async (_request, response, next) => {
  try {
    await (await database()).command({ ping: 1 });
    response.json({ ok: true });
  } catch (error) { next(error); }
});

app.post('/api/auth/login', async (request, response, next) => {
  try {
    if (loginLimiter.isBlocked(request.ip)) return response.status(429).json({ error: { code: 'TOO_MANY_ATTEMPTS', message: 'Try again later.' } });
    const { email, password } = request.body || {};
    if (typeof email !== 'string' || typeof password !== 'string') return response.status(422).json({ error: { code: 'VALIDATION_ERROR', message: 'Email and password are required.' } });
    const user = await (await database()).collection('users').findOne({ email: email.trim().toLowerCase() });
    if (!user || user.status !== 'Active' || !await bcrypt.compare(password, user.passwordHash)) {
      loginLimiter.recordFailure(request.ip);
      return response.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' } });
    }
    loginLimiter.reset(request.ip);
    const token = jwt.sign({ id: user.id, name: user.name, role: user.role }, process.env.JWT_SECRET, { expiresIn: '8h' });
    response.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 8 * 60 * 60 * 1000 });
    response.json({ user: { id: user.id, name: user.name, role: user.role, access: accessFor(user.role) } });
  } catch (error) { next(error); }
});

app.post('/api/auth/logout', (_request, response) => {
  response.clearCookie(COOKIE_NAME).status(204).end();
});

app.get('/api/state', auth, async (_request, response, next) => {
  try {
        const state = await currentState();
    if (!state.users.length) return response.status(503).json({ error: { code: 'NOT_SEEDED', message: 'Run npm run migrate first.' } });
    response.json({ state: visibleState(state, _request.user.role) });
  } catch (error) { next(error); }
});

app.put('/api/state', auth, async (request, response, next) => {
  try {
    const { role } = request.user;
    const access = accessFor(role);
    const incoming = validateState(request.body?.state);
    const current = await currentState();
    const merged = { ...current };
    const writable = [];
    for (const [collection, key] of Object.entries(STATE_KEYS)) {
      if (!canWrite(access, collection)) continue;
      merged[key] = incoming[key];
      writable.push(collection);
    }
    if (writable.includes('users')) {
      const hashes = new Map(current.users.map((user) => [user.id, user.passwordHash]));
      merged.users = await Promise.all(incoming.users.map(async ({ password, passwordHash, ...user }) => ({
        ...user,
        passwordHash: password ? await bcrypt.hash(password, 12) : hashes.get(user.id),
      })));
      if (merged.users.some((user) => !user.passwordHash)) return response.status(422).json({ error: { code: 'PASSWORD_REQUIRED', message: 'New accounts require a password.' } });
    }
    if (writable.includes('bookings')) {
      if (!access.approve && newlyConfirmed(current.bookings, merged.bookings).length) {
        return response.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only the Owner, General Manager or Operations Manager can confirm bookings.' } });
      }
      const clashes = introducedConflicts(current.bookings, merged.bookings);
      if (clashes.length) return response.status(409).json({ error: { code: 'SCHEDULE_CONFLICT', message: `Schedule conflict: ${clashes.join(', ')} overlap another active booking.` } });
    }
    await saveState(merged, writable);
    await appendAudit(current.auditLog, incoming.auditLog, request.user);
    response.json({ state: visibleState(await currentState(), role) });
  } catch (error) { next(error); }
});

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } });
});

const server = app.listen(process.env.PORT || 3000, () => console.log(`SCIMS is running at http://localhost:${process.env.PORT || 3000}`));
process.on('SIGINT', async () => { server.close(); await closeDatabase(); });

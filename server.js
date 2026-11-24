process.env.TZ = 'Asia/Manila';

require('dotenv').config();

const bcrypt = require('bcryptjs');
const express = require('express');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const path = require('node:path');
const { database, closeDatabase, withTransaction } = require('./lib/db');
const { collectionKeys, stateFromCollections } = require('./lib/collections');
const { createLoginRateLimiter } = require('./lib/login-rate-limit');
const { sanitizeState } = require('./lib/state');
const { accessFor, isAdmin } = require('./lib/access');
const { listReports, createExport, ExportError } = require('./lib/csv-exports');
const { mutableCollections, StateChangeError, prepareStateChanges, saveStateChanges } = require('./lib/state-changes');

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

async function currentState(role) {
  const admin = isAdmin(accessFor(role));
  const db = await database();
  const names = Object.keys(collectionKeys);
  const entries = await Promise.all(names.map(async (name) => {
    if (!admin && (name === 'users' || name === 'auditLogs')) return [name, []];
    return [name, await db.collection(name).find().toArray()];
  }));
  const documents = Object.fromEntries(entries);
  const versions = Object.fromEntries(mutableCollections.map((name) => [
    name, Object.fromEntries(documents[name].map((record) => [record[collectionKeys[name]], record._version ?? 0])),
  ]));
  return { state: sanitizeState(stateFromCollections(documents)), versions };
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

// Check the current account so a deactivated user cannot export data.
async function exportAccount(request, response, next) {
  try {
    const db = await database();

    const user = await db.collection('users').findOne(
      { id: request.user.id, status: 'Active' },
      { projection: { _id: 0, id: 1, name: 1, role: 1 } }
    );

    if (!user) {
      return response.status(403).json({ error: { code: 'FORBIDDEN', message: 'Your account cannot export records.' } });
    }

    request.exportDb = db;
    request.exportUser = user;

    next();
  } catch (error) { next(error); }
}

app.get('/api/exports', auth, exportAccount, (request, response) => {
  const reports = listReports(request.exportUser.role);

  response.set('Cache-Control', 'no-store').json({ reports });
});

app.post('/api/exports/:type', auth, exportAccount, async (request, response, next) => {
  try {
    const result = await createExport(
      request.exportDb, request.exportUser, request.params.type, request.body
    );

    // Send the generated CSV as a downloadable file.
    response.set({
      'Cache-Control': 'no-store',
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${result.filename}"`,
      'X-Export-Count': String(result.count),
    }).send(result.csv);

  } catch (error) {
    if (error instanceof ExportError) {
      return response.status(error.status).json({ error: { code: 'EXPORT_ERROR', message: error.message } });
    }

    next(error);
  }
});

app.get('/api/state', auth, async (request, response, next) => {
  try {
    const result = await currentState(request.user.role);
    if (isAdmin(accessFor(request.user.role)) && !result.state.users.length) {
      return response.status(503).json({ error: { code: 'NOT_SEEDED', message: 'Run npm run migrate first.' } });
    }
    response.json(result);
  } catch (error) { next(error); }
});

app.put('/api/state', auth, async (request, response, next) => {
  try {
    const access = accessFor(request.user.role);
    const prepared = await prepareStateChanges(request.body, access);
    if (!prepared.changes.length && !prepared.audit.length) return response.json({ version: null });
    const result = await withTransaction((db, session) => saveStateChanges(db, session, prepared, access, request.user.name));
    response.json(result);
  } catch (error) {
    if (error instanceof StateChangeError) return response.status(error.status).json({ error: { code: error.code, message: error.message } });
    if (error.code === 11000) return response.status(409).json({ error: { code: 'RECORD_CONFLICT', message: 'A record already uses those details. Review the latest data and try again.' } });
    next(error);
  }
});

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } });
});

const server = app.listen(process.env.PORT || 3000, () => console.log(`SCIMS is running at http://localhost:${process.env.PORT || 3000}`));
process.on('SIGINT', async () => { server.close(); await closeDatabase(); });

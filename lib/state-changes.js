const { z } = require('zod');
const bcrypt = require('bcryptjs');
const { canWrite } = require('./access');
const { collectionKeys } = require('./collections');
const { introducedConflicts, newlyConfirmed } = require('./bookings');
const { userSchema } = require('./state');

const mutableCollections = ['users', 'customers', 'inquiries', 'quotations', 'bookings', 'staff', 'checklists'];
const changesSchema = z.strictObject({
  changes: z.array(z.strictObject({
    collection: z.enum(mutableCollections),
    id: z.union([z.int().positive(), z.string().min(1).max(120)]),
    version: z.int().nonnegative().nullable(),
    record: z.record(z.string(), z.unknown()).nullable(),
  })).max(1000),
  audit: z.array(z.strictObject({
    auditId: z.string().min(1).max(120),
    action: z.string().max(300),
    meta: z.string().max(300),
  })).max(1000),
});
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const bookingSchema = z.object({
  eventDate: z.iso.date(),
  eventTime: time.or(z.literal('')).nullish(),
  eventEndTime: time.or(z.literal('')).nullish(),
  status: z.string().min(1),
});
const checklistSchema = z.object({ items: z.array(z.boolean()).max(50) });

class StateChangeError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function prepareStateChanges(body, access) {
  const parsed = changesSchema.safeParse(body);
  if (!parsed.success) throw new StateChangeError(422, 'VALIDATION_ERROR', 'Invalid record changes.');
  const seen = new Set();
  const changes = [];
  for (const change of parsed.data.changes) {
    const { collection, id, version, record } = change;
    if (!canWrite(access, collection)) {
      throw new StateChangeError(403, 'FORBIDDEN', 'Your role cannot edit ' + collection + '.');
    }
    const key = collectionKeys[collection];
    const numericId = ['users', 'customers', 'inquiries', 'staff'].includes(collection);
    const identity = JSON.stringify([collection, id]);
    if (seen.has(identity) || numericId !== (typeof id === 'number') ||
        (record ? record[key] !== id : version === null)) {
      throw new StateChangeError(422, 'VALIDATION_ERROR', 'Invalid or duplicate record identity.');
    }
    seen.add(identity);
    let document = null;
    if (record) {
      const { _id, _version, ...fields } = record;
      document = fields;
      if (collection === 'bookings' && !bookingSchema.safeParse(fields).success ||
          collection === 'checklists' && !checklistSchema.safeParse(fields).success) {
        throw new StateChangeError(422, 'VALIDATION_ERROR', 'Invalid ' + collection + ' record.');
      }
      if (collection === 'users') {
        const { passwordHash, ...account } = fields;
        const validated = userSchema.safeParse(account);
        if (!validated.success) throw new StateChangeError(422, 'VALIDATION_ERROR', 'Invalid user account.');
        const { password, ...user } = validated.data;
        if (version === null && !password) {
          throw new StateChangeError(422, 'PASSWORD_REQUIRED', 'New accounts require a password.');
        }
        document = password ? { ...user, passwordHash: await bcrypt.hash(password, 12) } : user;
      }
    }
    changes.push({ collection, id, version, document });
  }
  return { changes, audit: parsed.data.audit };
}

function staleRecord({ collection, id }) {
  return new StateChangeError(409, 'STALE_RECORD', 'Record ' + id + ' (' + collection + ') changed since you opened it. Review the latest data and try again.');
}

async function checkBookingChanges(db, session, changes, access) {
  if (!changes.length) return;
  const existing = await db.collection('bookings').find({}, { session }).toArray();
  const updated = new Map(existing.map((booking) => [booking.id, booking]));
  for (const { id, document } of changes) {
    if (document) updated.set(id, document);
    else updated.delete(id);
  }
  const incoming = [...updated.values()];
  if (!access.approve && newlyConfirmed(existing, incoming).length) {
    throw new StateChangeError(403, 'FORBIDDEN', 'Only the Owner, General Manager or Operations Manager can confirm bookings.');
  }
  const clashes = introducedConflicts(existing, incoming);
  if (clashes.length) {
    throw new StateChangeError(409, 'SCHEDULE_CONFLICT', 'Schedule conflict: ' + clashes.join(', ') + ' overlap another active booking.');
  }
}

async function saveStateChanges(db, session, { changes, audit }, access, actor) {
  // Taking the same write lock before reading bookings prevents concurrent
  // updates to different bookings from both approving the same time slot.
  const { version } = await db.collection('stateWrites').findOneAndUpdate(
    { _id: 'revision' }, { $inc: { version: 1 } }, { upsert: true, returnDocument: 'after', session }
  );
  const records = [];
  for (const change of changes) {
    const collection = db.collection(change.collection);
    const key = { [collectionKeys[change.collection]]: change.id };
    const existing = await collection.findOne(key, { session });
    const currentVersion = existing ? (existing._version ?? 0) : null;
    if (currentVersion !== change.version) throw staleRecord(change);
    records.push({ ...change, collectionHandle: collection, existing });
  }
  await checkBookingChanges(db, session, changes.filter(({ collection }) => collection === 'bookings'), access);
  for (const { collection, collectionHandle, existing, document } of records) {
    const options = { session };
    if (!document) {
      await collectionHandle.deleteOne({ _id: existing._id }, options);
      continue;
    }
    const replacement = { ...document, _version: version };
    if (collection === 'users') {
      replacement.passwordHash ??= existing?.passwordHash;
      if (!replacement.passwordHash) {
        throw new StateChangeError(422, 'PASSWORD_REQUIRED', 'This account requires a password.');
      }
    }
    if (existing) await collectionHandle.replaceOne({ _id: existing._id }, replacement, options);
    else await collectionHandle.insertOne(replacement, options);
  }
  if (audit.length) {
    const time = new Date().toISOString();
    await db.collection('auditLogs').bulkWrite(audit.map(({ auditId, action, meta }) => ({
      updateOne: { filter: { auditId }, update: { $setOnInsert: { actor, action, meta, time } }, upsert: true },
    })), { session });
  }
  return { version };
}

module.exports = { mutableCollections, StateChangeError, prepareStateChanges, saveStateChanges };

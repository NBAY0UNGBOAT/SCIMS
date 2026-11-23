const test = require('node:test');
const assert = require('node:assert/strict');
const { accessFor } = require('../lib/access');
const { prepareStateChanges, saveStateChanges } = require('../lib/state-changes');

const operations = accessFor('Operations Manager');
const sales = accessFor('Sales Executive');
const booking = (id, eventDate) => ({ id, eventDate, eventTime: '10:00', eventEndTime: '14:00', status: 'Reserved' });
const change = (record, version = 0) => ({ collection: 'bookings', id: record.id, record, version });

function database(bookings) {
  const documents = new Map(bookings.map((record) => [record.id, { ...record, _id: record.id }]));
  let version = 0;
  return {
    documents,
    collection(name) {
      if (name === 'stateWrites') return { findOneAndUpdate: async () => ({ version: ++version }) };
      assert.equal(name, 'bookings');
      return {
        find: () => ({ toArray: async () => [...documents.values()] }),
        findOne: async ({ id }) => documents.get(id) ?? null,
        insertOne: async (record) => documents.set(record.id, { ...record, _id: record.id }),
        replaceOne: async ({ _id }, record) => documents.set(_id, { ...record, _id }),
      };
    },
  };
}

async function save(db, changes, access = operations) {
  const body = await prepareStateChanges({ changes, audit: [] }, access);
  return saveStateChanges(db, {}, body, access, 'Test user');
}

test('saves different bookings from the same old snapshot without replacing either edit', async () => {
  const a = booking('BK-1006', '2026-09-01');
  const b = booking('BK-1007', '2026-09-02');
  const db = database([a, b]);
  await save(db, [change({ ...a, eventTime: '11:00' })]);
  await save(db, [change({ ...b, eventTime: '12:00' })]);
  assert.equal(db.documents.get(a.id).eventTime, '11:00');
  assert.equal(db.documents.get(b.id).eventTime, '12:00');
});

test('rejects a stale edit before attempting any writes to the records in its batch', async () => {
  const a = booking('BK-1006', '2026-09-01');
  const b = booking('BK-1007', '2026-09-02');
  const db = database([a, b]);
  const { version } = await save(db, [change({ ...a, eventTime: '11:00' })]);
  await assert.rejects(
    save(db, [change({ ...b, eventTime: '12:00' }), change({ ...a, eventTime: '13:00' })]),
    { status: 409, code: 'STALE_RECORD' }
  );
  assert.equal(db.documents.get(b.id).eventTime, '10:00');
  assert.equal(db.documents.get(a.id).eventTime, '11:00');
  await save(db, [change({ ...a, eventTime: '13:00' }, version)]);
  assert.equal(db.documents.get(a.id).eventTime, '13:00');
});

test('rejects a second creation with the same record ID', async () => {
  const a = booking('BK-1006', '2026-09-01');
  const db = database([]);
  await save(db, [change(a, null)]);
  await assert.rejects(save(db, [change({ ...a, eventTime: '13:00' }, null)]), { status: 409, code: 'STALE_RECORD' });
  assert.equal(db.documents.get(a.id).eventTime, '10:00');
});

test('validates new booking approvals against current records and the acting role', async () => {
  const a = booking('BK-1006', '2026-09-01');
  const b = booking('BK-1007', '2026-09-02');
  const db = database([a, b]);
  await assert.rejects(save(db, [change({ ...a, status: 'Confirmed' })], sales), { status: 403, code: 'FORBIDDEN' });
  await save(db, [change({ ...a, status: 'Confirmed' })]);
  await assert.rejects(save(db, [change({ ...b, status: 'Confirmed', eventDate: a.eventDate })]), { status: 409, code: 'SCHEDULE_CONFLICT' });
  assert.equal(db.documents.get(b.id).eventDate, b.eventDate);
});

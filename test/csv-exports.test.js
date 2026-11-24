// Match the timezone configured in server.js.
process.env.TZ = 'Asia/Manila';

const test = require('node:test');
const assert = require('node:assert/strict');
const { allowedReport, listReports, validateFilters, toCSV, createExport } = require('../lib/csv-exports');

// Simulate MongoDB reads and audit inserts without connecting to the actual database.
function fakeDb(data, failAudit = false) {
  const inserted = [];
  const reads = [];
  return {
    inserted,
    reads,
    collection(name) {
      return {
        find(_query, { projection }) {
          reads.push(name);
          return {
            async toArray() {
              return (data[name] || []).map((row) => {
                const result = {};
                for (const key of Object.keys(projection)) {
                  if (projection[key] && Object.hasOwn(row, key)) result[key] = row[key];
                }
                return result;
              });
            },
          };
        },
        async insertOne(row) {
          assert.equal(name, 'auditLogs');
          if (failAudit) throw new Error('Audit unavailable');
          inserted.push(row);
        },
      };
    },
  };
}

const data = {
  bookings: [
    { id: 'BK-1', customer: 'José', eventDate: '2026-11-24', eventTime: '14:00', venue: 'Hall, "A"', guests: 50, status: 'Confirmed', quoteRef: 'Q-1' },
    { id: 'BK-2', customer: 'Another', eventDate: '2026-12-01', status: 'Cancelled' },
  ],
  quotations: [{ id: 'Q-1', package: 'Gold', total: 65500 }],
  staff: [{ id: 1, name: 'Crew', assignedTo: 'BK-1', availability: 'Assigned' }],
  checklists: [{ bookingId: 'BK-1', items: [true, true, true, false, false, false] }],
  users: [{ id: 1, name: 'Owner', passwordHash: 'SECRET', password: 'SECRET2', status: 'Active' }],
};
const owner = { id: 1, name: 'Owner', role: 'Owner' };
const now = new Date('2026-11-24T16:30:00Z');

test('CSV escapes quotes, commas, newlines and nulls, protects formula text, includes BOM and CRLF', () => {
  const columns = [
    { label: 'Text', key: 'text' },
    { label: 'Blank', key: 'blank' },
    { label: 'Amount', key: 'amount', numeric: true },
  ];
  const csv = toCSV(columns, [
    { text: 'Hall, "A"\nJosé', amount: -10 },
    { text: '  =1+1', blank: null, amount: 5 },
    { text: '\t@SUM(1)', amount: 0 },
  ]);
  assert.equal(csv, '\ufeff"Text","Blank","Amount"\r\n"Hall, ""A""\nJosé","","-10"\r\n"\'  =1+1","","5"\r\n"\'\t@SUM(1)","","0"\r\n');
});

test('report access follows existing tabs and limits joined data', () => {
  assert.equal(allowedReport('Sales Executive', 'audit'), null);
  assert.equal(allowedReport('Purchasing Officer', 'bookings'), null);
  assert.equal(allowedReport('Operations Manager', 'quotations'), null);
  assert.ok(!allowedReport('Operations Manager', 'bookings').columns.some((c) => c.key === 'quoteTotal'));
  assert.ok(allowedReport('Owner', 'bookings').columns.some((c) => c.key === 'quoteTotal'));
  assert.deepEqual(listReports('Purchasing Officer').map((r) => r.type), ['schedule', 'checklists']);
  assert.equal(allowedReport('Owner', '__proto__'), null);
});

test('filters reject invalid dates, reversed ranges, unsupported statuses and forbidden columns', () => {
  const report = allowedReport('Operations Manager', 'bookings');
  const invalidFilters = [
    { from: '2026-02-30' },
    { from: '2026-12-01', to: '2026-11-01' },
    { status: 'Made Up' },
    { columns: ['Quotation Value (PHP)'] },
    { columns: [] },
    { actor: 'spoofed' },
  ];
  for (const filters of invalidFilters) {
    assert.throws(() => validateFilters(filters, report), { status: 422 });
  }
  assert.throws(() => validateFilters({ from: '2026-11-01' }, allowedReport('Owner', 'customers')), { status: 422 });
});

test('booking export filters persisted rows, joins authorized data and writes real server audit', async () => {
  const db = fakeDb(data);
  const result = await createExport(db, owner, 'bookings', {
    from: '2026-11-24', to: '2026-11-24', status: 'Confirmed', search: 'josé',
  }, now);
  assert.equal(result.count, 1);
  assert.match(result.csv, /"Gold","65500","1","50"/);
  assert.doesNotMatch(result.csv, /Another/);
  assert.match(result.filename, /2026-11-25-00-30-00\.csv$/);
  assert.equal(db.inserted.length, 1);

  const audit = db.inserted[0];
  assert.equal(audit.actorId, 1);
  assert.equal(audit.recordCount, 1);
  assert.equal(audit.eventType, 'csv_export');
  assert.equal(audit.time, now.toISOString());
  assert.equal(new Date(audit.time).getHours(), 0);
  assert.equal(audit.exportFilters.search, 'josé');
  assert.doesNotMatch(audit.meta, /josé/);
});

test('unauthorized requests and invalid filters never read report data or create audits', async () => {
  const db = fakeDb(data);
  await assert.rejects(createExport(db, { role: 'Sales Executive' }, 'users', {}), { status: 403 });
  await assert.rejects(createExport(db, owner, 'bookings', { status: 'Bad' }), { status: 422 });
  assert.deepEqual(db.reads, []);
  assert.deepEqual(db.inserted, []);
});

test('user export never includes passwords; no results produces header-only CSV', async () => {
  const db = fakeDb(data);
  const result = await createExport(db, owner, 'users', {}, now);
  assert.doesNotMatch(result.csv, /SECRET|password/i);

  const empty = await createExport(db, owner, 'bookings', { search: 'no results', columns: ['Booking No'] }, now);
  assert.equal(empty.count, 0);
  assert.equal(empty.csv, '\ufeff"Booking No"\r\n');
  assert.equal(db.inserted[1].recordCount, 0);
});

test('no invented end times, and unauthorized quote collection is not fetched', async () => {
  const db = fakeDb(data);
  const user = { id: 2, name: 'Operations', role: 'Operations Manager' };
  const result = await createExport(db, user, 'bookings', { columns: ['Booking No', 'End Time'] }, now);
  assert.match(result.csv, /"BK-1",""/);
  assert.ok(!db.reads.includes('quotations'));
});

test('checklist export uses existing six tasks and omits cancelled events', async () => {
  const db = fakeDb(data);
  const user = { id: 3, name: 'Purchasing', role: 'Purchasing Officer' };
  const result = await createExport(db, user, 'checklists', {
    status: 'In Progress', columns: ['Booking No', 'Tasks Completed', 'Progress (%)'],
  }, now);
  assert.equal(result.csv, '\ufeff"Booking No","Tasks Completed","Progress (%)"\r\n"BK-1","3","50"\r\n');
});

test('audit insert failure prevents a successful export response', async () => {
  await assert.rejects(createExport(fakeDb(data, true), owner, 'bookings', {}, now), /Audit unavailable/);
});

test('export filenames use local date and time across midnight', async () => {
  const cases = [
    ['2026-11-24T09:37:27Z', '2026-11-24-17-37-27'],
    ['2026-11-24T15:59:59Z', '2026-11-24-23-59-59'],
    ['2026-11-24T16:00:00Z', '2026-11-25-00-00-00'],
  ];
  for (const [timestamp, local] of cases) {
    const result = await createExport(fakeDb(data), owner, 'bookings', {}, new Date(timestamp));
    assert.equal(result.filename, `scims-bookings-all-to-all-${local}.csv`);
  }
});


test('audit export converts older timestamps to local time and filters by local date', async () => {
  const db = fakeDb({ auditLogs: [
    { auditId: 'old', time: '2026-11-24T16:00:00.123Z' },
    { auditId: 'new', time: '2026-11-24T17:00:00.000Z' },
    { auditId: 'before', time: '2026-11-24T15:59:59Z' },
    { auditId: 'legacy', time: 'Yesterday, 4:47 PM' },
    { auditId: 'missing' },
    { auditId: 'local', time: '2026-11-25T02:00:00' },
  ] });
  const result = await createExport(db, owner, 'audit', {
    from: '2026-11-25', to: '2026-11-25', columns: ['Audit ID', 'Date and Time'],
  }, now);
  assert.equal(result.count, 3);
  assert.match(result.csv, /"old","2026-11-25 00:00:00\.123"/);
  assert.match(result.csv, /"new","2026-11-25 01:00:00\.000"/);
  assert.match(result.csv, /"local","2026-11-25 02:00:00\.000"/);
  assert.doesNotMatch(result.csv, /before|legacy|missing/);

  const all = await createExport(db, owner, 'audit', { columns: ['Audit ID', 'Date and Time'] }, now);
  assert.match(all.csv, /"legacy","Yesterday, 4:47 PM"/);
  assert.match(all.csv, /"missing",""/);
});

test('user export converts absolute login timestamps and preserves legacy labels', async () => {
  const db = fakeDb({ users: [
    { id: 1, last: '2026-11-24T16:00:00Z' },
    { id: 2, last: 'Yesterday' },
    { id: 3 },
  ] });
  const result = await createExport(db, owner, 'users', {
    columns: ['User ID', 'Last Login'],
  }, now);
  assert.match(result.csv, /"1","2026-11-25 00:00:00\.000"/);
  assert.match(result.csv, /"2","Yesterday"/);
  assert.match(result.csv, /"3",""/);
});

test('renamed columns appear in report options and CSV headers', async () => {
  const cases = [
    ['users', 'Last Login'],
    ['audit', 'Date and Time'],
    ['quotations', 'Status'],
    ['customers', 'Quotation References'],
    ['bookings', 'Quotation No.'],
  ];
  const reports = listReports(owner.role);
  for (const [type, column] of cases) {
    const report = reports.find(r => r.type === type);
    assert.ok(report.columns.includes(column));
    const result = await createExport(fakeDb(data), owner, type, { columns: [column] }, now);
    assert.equal(result.csv.split('\r\n')[0], '\ufeff"' + column + '"');
  }
  const booking = await createExport(fakeDb(data), owner, 'bookings', { columns: ['Quotation No.'] }, now);
  assert.match(booking.csv, /"Q-1"/);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { introducedConflicts, newlyConfirmed } = require('../lib/bookings');

const b = (id, status, start, end, date = '2026-08-12') => ({ id, status, eventDate: date, eventTime: start, eventEndTime: end });

test('tolerates a pre-existing overlap that is not touched', () => {
  const rows = [b('A', 'Confirmed', '14:00', '18:00'), b('B', 'Reserved', '16:00', '20:00')];
  assert.deepEqual(introducedConflicts(rows, rows), []);
});

test('blocks confirming a booking that overlaps an active one', () => {
  const before = [b('A', 'Confirmed', '14:00', '18:00'), b('B', 'Reserved', '10:00', '12:00')];
  const after = [before[0], { ...before[1], eventTime: '16:00', eventEndTime: '20:00', status: 'Confirmed' }];
  assert.deepEqual(introducedConflicts(before, after), ['B']);
});

test('adjacent events and cancelled bookings do not conflict', () => {
  const before = [b('A', 'Confirmed', '10:00', '14:00'), b('C', 'Cancelled', '14:00', '18:00')];
  const after = [...before, b('B', 'Confirmed', '14:00', '18:00')];
  assert.deepEqual(introducedConflicts(before, after), []);
});

test('detects newly confirmed bookings', () => {
  assert.deepEqual(newlyConfirmed([b('A', 'Reserved', '10:00', '12:00')], [b('A', 'Confirmed', '10:00', '12:00')]), ['A']);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { accessFor, canWrite, isAdmin } = require('../lib/access');

test('only owner-level roles are admins; unknown roles are read-only', () => {
  assert.equal(isAdmin(accessFor('Owner')), true);
  assert.equal(isAdmin(accessFor('Sales Executive')), false);
  assert.equal(canWrite(accessFor('Mystery Role'), 'bookings'), false);
});

test('sales can write quotations but not staff or users', () => {
  const sales = accessFor('Sales Executive');
  assert.equal(canWrite(sales, 'quotations'), true);
  assert.equal(canWrite(sales, 'staff'), false);
  assert.equal(canWrite(sales, 'users'), false);
});

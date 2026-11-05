const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeState, validateState } = require('../lib/state');

test('sanitizeState never returns password hashes', () => {
  const state = {
    users: [{ id: 1, name: 'Owner', email: 'owner@example.com', passwordHash: 'secret' }],
    customers: [], inquiries: [], quotations: [], bookings: [], staff: [], checklistState: {}, auditLog: [],
  };

  assert.deepEqual(sanitizeState(state).users, [{ id: 1, name: 'Owner', email: 'owner@example.com' }]);
});

test('validateState rejects an unknown top-level field', () => {
  assert.throws(
    () => validateState({ users: [], customers: [], inquiries: [], quotations: [], bookings: [], staff: [], checklistState: {}, auditLog: [], injected: true }),
    /Invalid application state/
  );
});

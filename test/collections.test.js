const test = require('node:test');
const assert = require('node:assert/strict');
const { collectionDocuments, stateFromCollections } = require('../lib/collections');

test('converts checklist documents back to the UI state shape', () => {
  const state = stateFromCollections({
    users: [], customers: [], inquiries: [], quotations: [], bookings: [], staff: [], auditLogs: [],
    checklists: [{ bookingId: 'BK-1001', items: [true, false] }],
  });
  assert.deepEqual(state.checklistState, { 'BK-1001': [true, false] });
});

test('gives audit records a persistent identifier before storage', () => {
  const collections = collectionDocuments({
    users: [], customers: [], inquiries: [], quotations: [], bookings: [], staff: [], checklistState: {},
    auditLog: [{ actor: 'Owner', action: 'logged in', meta: '', time: 'Just now' }],
  });
  assert.match(collections.auditLogs[0].auditId, /^[0-9a-f-]{36}$/);
});

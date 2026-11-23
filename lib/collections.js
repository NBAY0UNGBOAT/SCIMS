const { randomUUID } = require('node:crypto');

const collectionKeys = {
  users: 'id',
  customers: 'id',
  inquiries: 'id',
  quotations: 'id',
  bookings: 'id',
  staff: 'id',
  checklists: 'bookingId',
  auditLogs: 'auditId',
};

function removeMongoId({ _id, _version, ...document }) {
  return document;
}

function collectionDocuments(state) {
  return {
    users: state.users.map(removeMongoId),
    customers: state.customers.map(removeMongoId),
    inquiries: state.inquiries.map(removeMongoId),
    quotations: state.quotations.map(removeMongoId),
    bookings: state.bookings.map(removeMongoId),
    staff: state.staff.map(removeMongoId),
    checklists: Object.entries(state.checklistState).map(([bookingId, items]) => ({ bookingId, items })),
    auditLogs: state.auditLog.map((entry) => ({ ...removeMongoId(entry), auditId: entry.auditId || randomUUID() })),
  };
}

function stateFromCollections(documents) {
  return {
    users: documents.users.map(removeMongoId),
    customers: documents.customers.map(removeMongoId),
    inquiries: documents.inquiries.map(removeMongoId),
    quotations: documents.quotations.map(removeMongoId),
    bookings: documents.bookings.map(removeMongoId),
    staff: documents.staff.map(removeMongoId),
    checklistState: Object.fromEntries(documents.checklists.map(({ bookingId, items }) => [bookingId, items])),
    auditLog: documents.auditLogs.map(removeMongoId),
  };
}

module.exports = { collectionDocuments, collectionKeys, stateFromCollections };

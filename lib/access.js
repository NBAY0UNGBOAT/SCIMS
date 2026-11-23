// Single source of truth for role permissions. The server enforces it;
// the client receives it at login and uses it to hide screens.
const ALL = '*';
const ADMIN = { tabs: ALL, write: ALL, approve: true };

const ACCESS = {
  Owner: ADMIN,
  'General Manager': ADMIN,
  'Sales Executive': {
    tabs: ['2-customers', '2-inquiries', '3-quotations', '4-bookings', '4-calendar'],
    write: ['customers', 'inquiries', 'quotations', 'bookings'],
    approve: false,
  },
  'Operations Manager': {
    tabs: ['4-bookings', '4-calendar', '5-staff', '5-checklist', '6-reports'],
    write: ['bookings', 'staff', 'checklists'],
    approve: true,
  },
  'Kitchen Manager': { tabs: ['4-calendar', '5-staff', '5-checklist'], write: ['checklists'], approve: false },
  'Accounting Staff': { tabs: ['3-quotations', '4-bookings', '4-calendar', '6-reports'], write: [], approve: false },
  'Purchasing Officer': { tabs: ['4-calendar', '5-checklist'], write: [], approve: false },
};
const DEFAULT_ACCESS = { tabs: ['4-calendar'], write: [], approve: false };

const accessFor = (role) => ACCESS[role] || DEFAULT_ACCESS;
const canWrite = (access, collection) => access.write === ALL || access.write.includes(collection);
const isAdmin = (access) => access.tabs === ALL;

module.exports = { accessFor, canWrite, isAdmin };

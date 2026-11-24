const { randomUUID } = require('node:crypto');
const { accessFor } = require('./access');

const bookingStatuses = ['Inquiry', 'Quotation Sent', 'Pending Confirmation', 'Reserved', 'Confirmed', 'Ongoing Preparation', 'Completed', 'Cancelled', 'Archived'];
const checklistItems = ['Menu finalized', 'Procurement list generated', 'Staff assigned', 'Equipment prepared', 'Supplier deliveries confirmed', 'Client walkthrough completed'];

function canView(role, tab) {
  const { tabs } = accessFor(role);
  return tabs === '*' || (Array.isArray(tabs) && tabs.includes(tab));
}

function col(label, key, numeric = false) {
  return { label, key, numeric };
}

const bookingColumns = [
  col('Booking No', 'id'),
  col('Customer', 'customer'),
  col('Event Date', 'eventDate'),
  col('Start Time', 'eventTime'),
  col('End Time', 'eventEndTime'),
  col('Venue', 'venue'),
  col('Guests', 'guests', true),
  col('Status', 'status'),
];

// Each report lists its allowed screen, data source, filters and export columns.
const reports = {
  users: {
    label: 'User accounts',
    tabs: ['1-accounts'],
    collection: 'users',
    status: 'status',
    statuses: ['Active', 'Deactivated'],
    columns: [
      col('User ID', 'id'),
      col('Name', 'name'),
      col('Email', 'email'),
      col('Role', 'role'),
      col('Department', 'dept'),
      col('Status', 'status'),
      col('Last Login', 'last'),
    ],
  },
  audit: {
    label: 'Audit logs',
    tabs: ['1-audit'],
    collection: 'auditLogs',
    date: 'auditDate',
    dateLabel: 'Audit date',
    columns: [
      col('Audit ID', 'auditId'),
      col('Actor', 'actor'),
      col('Action', 'action'),
      col('Details', 'meta'),
      col('Date and Time', 'time'),
      col('Export Type', 'reportType'),
      col('Export Filters', 'exportFilters'),
      col('Records Exported', 'recordCount', true),
    ],
  },
  customers: {
    label: 'Customers',
    tabs: ['2-customers'],
    collection: 'customers',
    columns: [
      col('Customer ID', 'id'),
      col('Customer', 'name'),
      col('Contact Person', 'contact'),
      col('Phone', 'phone'),
      col('Email', 'email'),
      col('Source', 'source'),
      col('Quotation References', 'history'),
    ],
  },
  inquiries: {
    label: 'Inquiries',
    tabs: ['2-inquiries'],
    collection: 'inquiries',
    date: 'date',
    dateLabel: 'Event date',
    status: 'status',
    statuses: ['New', 'Quoted', 'Converted'],
    columns: [
      col('Inquiry ID', 'id'),
      col('Inquiry', 'name'),
      col('Channel', 'channel'),
      col('Event Type', 'eventType'),
      col('Event Date', 'date'),
      col('Estimated Guests', 'guests', true),
      col('Status', 'status'),
    ],
  },
  quotations: {
    label: 'Quotations',
    tabs: ['3-quotations'],
    collection: 'quotations',
    date: 'eventDate',
    dateLabel: 'Event date',
    status: 'status',
    statuses: ['Draft', 'Sent', 'Accepted', 'Expired', 'Declined'],
    columns: [
      col('Quotation No', 'id'),
      col('Customer', 'customer'),
      col('Event Date', 'eventDate'),
      col('Guests', 'guests', true),
      col('Package', 'package'),
      col('Quotation Value (PHP)', 'total', true),
      col('Status', 'status'),
      col('Valid Until', 'validUntil'),
    ],
  },
  bookings: {
    label: 'Bookings',
    tabs: ['4-bookings'],
    collection: 'bookings',
    date: 'eventDate',
    dateLabel: 'Event date',
    status: 'status',
    statuses: bookingStatuses,
    columns: [
      ...bookingColumns,
      col('Quotation No.', 'quoteRef'),
    ],
  },
  schedule: {
    label: 'Event schedule',
    tabs: ['4-calendar'],
    collection: 'bookings',
    date: 'eventDate',
    dateLabel: 'Event date',
    status: 'status',
    statuses: bookingStatuses,
    columns: bookingColumns,
  },
  staff: {
    label: 'Staff and assignments',
    tabs: ['5-staff'],
    collection: 'staff',
    date: 'eventDate',
    dateLabel: 'Assigned event date (unassigned staff excluded when filtering by date)',
    status: 'availability',
    statuses: ['Available', 'Assigned', 'Off'],
    columns: [
      col('Staff ID', 'id'),
      col('Name', 'name'),
      col('Role', 'role'),
      col('Department', 'dept'),
      col('Availability', 'availability'),
      col('Assigned Booking', 'assignedTo'),
      col('Assigned Event Date', 'eventDate'),
      col('Start Time', 'eventTime'),
      col('End Time', 'eventEndTime'),
      col('Venue', 'venue'),
    ],
  },
  checklists: {
    label: 'Preparation checklists',
    tabs: ['5-checklist'],
    collection: 'checklists',
    date: 'eventDate',
    dateLabel: 'Event date',
    status: 'progressStatus',
    statuses: ['Not Started', 'In Progress', 'Completed'],
    columns: [
      col('Booking No', 'bookingId'),
      col('Customer', 'customer'),
      col('Event Date', 'eventDate'),
      col('Booking Status', 'bookingStatus'),
      ...checklistItems.map((name, i) => col(name, 'task' + i)),
      col('Tasks Completed', 'completed', true),
      col('Total Tasks', 'taskCount', true),
      col('Progress (%)', 'progress', true),
      col('Preparation Status', 'progressStatus'),
    ],
  },
};

function allowedReport(role, type) {
  if (!Object.hasOwn(reports, type)) return null;
  const report = reports[type];
  if (!report.tabs.some((tab) => canView(role, tab))) return null;

  const columns = [...report.columns];
  // Extra booking details are available only to roles that can view their source modules.
  if (type === 'bookings') {
    if (canView(role, '3-quotations')) {
      columns.push(col('Package', 'package'), col('Quotation Value (PHP)', 'quoteTotal', true));
    }
    if (canView(role, '5-staff')) columns.push(col('Assigned Staff Count', 'staffCount', true));
    if (canView(role, '5-checklist')) columns.push(col('Preparation Progress (%)', 'progress', true));
  }
  return { ...report, columns };
}

function listReports(role) {
  const availableReports = [];
  for (const type of Object.keys(reports)) {
    const report = allowedReport(role, type);
    if (!report) continue;
    availableReports.push({
      type,
      label: report.label,
      dateLabel: report.dateLabel || null,
      statuses: report.statuses || [],
      columns: report.columns.map((column) => column.label),
    });
  }
  return availableReports;
}

class ExportError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function dateValid(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = localDateTime(value + 'T00:00:00');
  return timestamp !== null && timestamp.date === value;
}

function validateFilters(input, report) {
  const filterNames = ['from', 'to', 'status', 'search', 'columns'];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ExportError(422, 'Invalid export filters.');
  }
  if (Object.keys(input).some((key) => !filterNames.includes(key))) {
    throw new ExportError(422, 'Unknown export filter.');
  }

  const { from = '', to = '', status = '', search = '', columns } = input;
  if ([from, to, status, search].some((value) => typeof value !== 'string')) {
    throw new ExportError(422, 'Invalid filter values.');
  }
  if (search.length > 150) throw new ExportError(422, 'Search term is too long.');
  if (from && !dateValid(from)) throw new ExportError(422, 'Invalid start date.');
  if (to && !dateValid(to)) throw new ExportError(422, 'Invalid end date.');
  if (from && to && from > to) throw new ExportError(422, 'Invalid date range.');
  if ((from || to) && !report.date) {
    throw new ExportError(422, 'This report does not support date filtering.');
  }
  if (status && !(report.statuses || []).includes(status)) {
    throw new ExportError(422, 'Invalid status for this report.');
  }

  const allowed = report.columns.map((column) => column.label);
  if (columns !== undefined) {
    if (!Array.isArray(columns) || !columns.length) {
      throw new ExportError(422, 'Select at least one authorized column.');
    }
    if (new Set(columns).size !== columns.length || columns.some((column) => !allowed.includes(column))) {
      throw new ExportError(422, 'Invalid or duplicate columns.');
    }
  }

  return { from, to, status, search: search.trim(), columns: columns || allowed };
}

function textValue(value) {
  if (Array.isArray(value)) return value.map(textValue).join('; ');
  if (value === null || value === undefined || typeof value === 'object') return '';
  return String(value);
}

function csvCell(value, numeric = false) {
  let text = textValue(value);
  const isNumber = numeric && typeof value === 'number' && Number.isFinite(value);
  // Prevent user-entered text from being treated as a spreadsheet formula.
  const formulaPrefix = /^[\s\u0000-\u001f\u007f\ufeff]*[=+\-@\uff1d\uff0b\uff0d\uff20]/u;
  if (!isNumber && (formulaPrefix.test(text) || /^[\t\r\n]/.test(text))) {
    text = "'" + text;
  }
  return '"' + text.replace(/"/g, '""') + '"';
}

function toCSV(columns, rows) {
  const header = columns.map((column) => csvCell(column.label)).join(',');
  const lines = [header];
  for (const row of rows) {
    const values = columns.map((column) => csvCell(row[column.key], column.numeric));
    lines.push(values.join(','));
  }
  // The UTF-8 BOM helps Excel display special characters correctly.
  return '\ufeff' + lines.join('\r\n') + '\r\n';
}

function localDateTime(value) {
  if (typeof value === 'string') {
    if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  } else if (!(value instanceof Date)) return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  // Local date methods use the timezone configured when the server starts.
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  const milliseconds = String(date.getMilliseconds()).padStart(3, '0');

  const localDate = `${year}-${month}-${day}`;
  const time = `${hours}:${minutes}:${seconds}`;

  return {
    date: localDate,
    time,
    timestamp: date.toISOString(),
    display: `${localDate} ${time}.${milliseconds}`,
  };
}

function completedTasks(items) {
  return checklistItems.filter((_, i) => items && items[i] === true).length;
}

function progress(items) {
  const completed = completedTasks(items);
  return Math.round(completed / checklistItems.length * 100);
}

function projection(keys) {
  const fields = { _id: 0 };
  for (const key of keys) fields[key] = 1;
  return fields;
}

function find(db, name, keys) {
  return db.collection(name).find({}, { projection: projection(keys) }).toArray();
}

async function loadRows(db, type, report) {
  const keys = report.columns.map((column) => column.key);

  if (type === 'bookings') {
    const rows = await find(db, 'bookings', bookingColumns.map((column) => column.key).concat('quoteRef'));
    const quoteAllowed = keys.includes('quoteTotal');
    const staffAllowed = keys.includes('staffCount');
    const checkAllowed = keys.includes('progress');

    // Load related collections only when the user's role permits those details.
    const [quotes, staff, checks] = await Promise.all([
      quoteAllowed ? find(db, 'quotations', ['id', 'package', 'total']) : [],
      staffAllowed ? find(db, 'staff', ['assignedTo']) : [],
      checkAllowed ? find(db, 'checklists', ['bookingId', 'items']) : [],
    ]);
    const quoteMap = new Map(quotes.map((quote) => [quote.id, quote]));
    const checkMap = new Map(checks.map((check) => [check.bookingId, check.items]));
    const counts = new Map();
    for (const member of staff) {
      counts.set(member.assignedTo, (counts.get(member.assignedTo) || 0) + 1);
    }

    return rows.map((booking) => {
      const row = { ...booking };
      if (quoteAllowed) {
        const quote = quoteMap.get(booking.quoteRef) || {};
        row.package = quote.package;
        row.quoteTotal = quote.total;
      }
      if (staffAllowed) row.staffCount = counts.get(booking.id) || 0;
      if (checkAllowed) row.progress = checkMap.has(booking.id) ? progress(checkMap.get(booking.id)) : '';
      return row;
    });
  }

  if (type === 'staff') {
    const [rows, bookings] = await Promise.all([
      find(db, 'staff', ['id', 'name', 'role', 'dept', 'availability', 'assignedTo']),
      find(db, 'bookings', ['id', 'eventDate', 'eventTime', 'eventEndTime', 'venue']),
    ]);
    const map = new Map(bookings.map((booking) => [booking.id, booking]));
    return rows.map((member) => {
      const booking = map.get(member.assignedTo) || {};
      return {
        ...member,
        eventDate: booking.eventDate,
        eventTime: booking.eventTime,
        eventEndTime: booking.eventEndTime,
        venue: booking.venue,
      };
    });
  }

  if (type === 'checklists') {
    const [checks, bookings] = await Promise.all([
      find(db, 'checklists', ['bookingId', 'items']),
      find(db, 'bookings', ['id', 'customer', 'eventDate', 'status']),
    ]);
    const map = new Map(checks.map((check) => [check.bookingId, check.items]));
    // Include untouched checklists for active bookings, just like the checklist screen.
    const activeBookings = bookings.filter((booking) => !['Cancelled', 'Archived'].includes(booking.status));
    return activeBookings.map((booking) => {
      const items = map.get(booking.id) || [];
      const completed = completedTasks(items);
      let progressStatus = 'In Progress';
      if (completed === 0) progressStatus = 'Not Started';
      else if (completed === checklistItems.length) progressStatus = 'Completed';

      const row = {
        bookingId: booking.id,
        customer: booking.customer,
        eventDate: booking.eventDate,
        bookingStatus: booking.status,
        completed,
        taskCount: checklistItems.length,
        progress: progress(items),
        progressStatus,
      };
      for (let i = 0; i < checklistItems.length; i++) {
        row['task' + i] = items[i] === true ? 'Completed' : 'Pending';
      }
      return row;
    });
  }

  const rows = await find(db, report.collection, keys);
  if (type === 'audit') {
    return rows.map((row) => {
      const timestamp = localDateTime(row.time);
      return {
        ...row,
        auditDate: timestamp ? timestamp.date : '',
        time: timestamp ? timestamp.display : row.time,
        exportFilters: row.exportFilters ? JSON.stringify(row.exportFilters) : '',
      };
    });
  }
  if (type === 'users') {
    return rows.map((row) => {
      const timestamp = localDateTime(row.last);
      return { ...row, last: timestamp ? timestamp.display : row.last };
    });
  }
  return rows;
}

function filterRows(rows, report, filters) {
  const needle = filters.search.toLowerCase();
  const filtered = rows.filter((row) => {
    const date = row[report.date];
    if (filters.from || filters.to) {
      if (!date || !dateValid(date)) return false;
      if (filters.from && date < filters.from) return false;
      if (filters.to && date > filters.to) return false;
    }
    if (filters.status && row[report.status] !== filters.status) return false;
    return !needle || report.columns.some((column) => textValue(row[column.key]).toLowerCase().includes(needle));
  });

  // Sort by date first, then by record ID for a consistent report order.
  return filtered.sort((a, b) => {
    const dateOrder = String(a[report.date] || '').localeCompare(String(b[report.date] || ''));
    if (dateOrder !== 0) return dateOrder;
    const firstId = a.id ?? a.bookingId ?? a.auditId ?? '';
    const secondId = b.id ?? b.bookingId ?? b.auditId ?? '';
    return String(firstId).localeCompare(String(secondId), undefined, { numeric: true });
  });
}

function exportFilename(type, filters, timestamp) {
  const from = filters.from || 'all';
  const to = filters.to || 'all';
  const time = timestamp.time.replace(/:/g, '-');
  return `scims-${type}-${from}-to-${to}-${timestamp.date}-${time}.csv`;
}

async function logExport(db, user, type, report, filters, count, timestamp) {
  const from = filters.from || 'Any date';
  const to = filters.to || 'Any date';
  const status = filters.status || 'All statuses';
  const searchNote = filters.search ? ' · Search applied' : '';
  const meta = `CSV · ${count} records · ${from} to ${to} · ${status}${searchNote} · ${filters.columns.length} columns`;

  // Record the authorized export before returning the file to the employee.
  await db.collection('auditLogs').insertOne({
    auditId: randomUUID(),
    actor: user.name,
    actorId: user.id,
    action: `generated ${report.label.toLowerCase()} CSV export`,
    meta,
    time: timestamp.timestamp,
    eventType: 'csv_export',
    reportType: type,
    format: 'CSV',
    exportFilters: filters,
    recordCount: count,
  });
}

async function createExport(db, user, type, input, now = new Date()) {
  const report = allowedReport(user.role, type);
  if (!report) throw new ExportError(403, 'Your role cannot export this report.');

  const filters = validateFilters(input, report);
  const savedRows = await loadRows(db, type, report);
  const rows = filterRows(savedRows, report, filters);
  const columns = report.columns.filter((column) => filters.columns.includes(column.label));
  const csv = toCSV(columns, rows);

  const timestamp = localDateTime(now);
  const filename = exportFilename(type, filters, timestamp);
  await logExport(db, user, type, report, filters, rows.length, timestamp);

  return { csv, filename, count: rows.length };
}

module.exports = { allowedReport, listReports, validateFilters, toCSV, filterRows, createExport, ExportError };

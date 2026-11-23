// Server-side mirror of the calendar's overlap rules, so conflicts cannot be
// bypassed by calling the API directly.
const HARD = ['Confirmed', 'Ongoing Preparation'];
const INACTIVE = ['Cancelled', 'Archived'];
const DEFAULT_MINUTES = 240;

const toMinutes = (t) => { if (!t) return 720; const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const endMinutes = (b) => (b.eventEndTime ? toMinutes(b.eventEndTime) : toMinutes(b.eventTime) + DEFAULT_MINUTES);
const overlaps = (a, b) => a.eventDate === b.eventDate && toMinutes(a.eventTime) < endMinutes(b) && toMinutes(b.eventTime) < endMinutes(a);
const signature = (b) => [b.status, b.eventDate, b.eventTime, b.eventEndTime].join('|');

// Ids of bookings that are newly (or newly re-scheduled to be) Confirmed/Ongoing
// while overlapping another active booking. Pre-existing conflicts are tolerated.
function introducedConflicts(existing, incoming) {
  const before = new Map(existing.map((b) => [b.id, b]));
  const active = incoming.filter((b) => !INACTIVE.includes(b.status));
  return active
    .filter((b) => HARD.includes(b.status) && (!before.has(b.id) || signature(before.get(b.id)) !== signature(b)))
    .filter((b) => active.some((o) => o.id !== b.id && overlaps(b, o)))
    .map((b) => b.id);
}

// Ids of bookings that became Confirmed in this save.
function newlyConfirmed(existing, incoming) {
  const before = new Map(existing.map((b) => [b.id, b.status]));
  return incoming.filter((b) => b.status === 'Confirmed' && before.get(b.id) !== 'Confirmed').map((b) => b.id);
}

module.exports = { introducedConflicts, newlyConfirmed, overlaps };

const { z } = require('zod');

const userSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254),
  role: z.string().trim().min(1).max(80),
  dept: z.string().trim().max(80),
  status: z.enum(['Active', 'Deactivated']),
  last: z.string().max(80),
  password: z.string().min(8).max(128).optional(),
  passwordHash: z.string().optional(),
}).passthrough();

const StateSchema = z.object({
  users: z.array(userSchema).max(1000),
  customers: z.array(z.record(z.string(), z.unknown())).max(10000),
  inquiries: z.array(z.record(z.string(), z.unknown())).max(10000),
  quotations: z.array(z.record(z.string(), z.unknown())).max(10000),
  bookings: z.array(z.record(z.string(), z.unknown())).max(10000),
  staff: z.array(z.record(z.string(), z.unknown())).max(10000),
  checklistState: z.record(z.string(), z.array(z.boolean()).max(50)),
  auditLog: z.array(z.record(z.string(), z.unknown())).max(50000),
}).strict();

function validateState(value) {
  const result = StateSchema.safeParse(value);
  if (!result.success) throw new Error('Invalid application state');
  return result.data;
}

function sanitizeState(state) {
  return {
    ...state,
    users: state.users.map(({ passwordHash, password, ...user }) => user),
  };
}

module.exports = { sanitizeState, validateState };

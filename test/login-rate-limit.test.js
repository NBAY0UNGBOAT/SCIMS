const test = require('node:test');
const assert = require('node:assert/strict');
const { createLoginRateLimiter } = require('../lib/login-rate-limit');

test('successful login clears prior failed attempts', () => {
  const limiter = createLoginRateLimiter({ limit: 2, windowMs: 60_000 });
  limiter.recordFailure('127.0.0.1');
  limiter.recordFailure('127.0.0.1');
  assert.equal(limiter.isBlocked('127.0.0.1'), true);
  limiter.reset('127.0.0.1');
  assert.equal(limiter.isBlocked('127.0.0.1'), false);
});

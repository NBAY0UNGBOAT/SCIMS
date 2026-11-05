function createLoginRateLimiter({ limit, windowMs }) {
  const attempts = new Map();

  function entry(key) {
    const now = Date.now();
    const current = attempts.get(key);
    if (!current || current.resetAt <= now) {
      const next = { count: 0, resetAt: now + windowMs };
      attempts.set(key, next);
      return next;
    }
    return current;
  }

  return {
    isBlocked(key) { return entry(key).count >= limit; },
    recordFailure(key) { entry(key).count += 1; },
    reset(key) { attempts.delete(key); },
  };
}

module.exports = { createLoginRateLimiter };

// Generic retry helper: attemptFn should resolve on success or throw on a
// retryable failure. onFailure is called after each failed attempt (useful
// for diagnostic logging).
async function withRetry(attemptFn, { attempts = 8, delayMs = 1200, onFailure = null } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await attemptFn(i, attempts);
    } catch (err) {
      lastError = err;
      if (onFailure) onFailure(err, i, attempts);
      if (i < attempts - 1) await new Promise(res => setTimeout(res, delayMs));
    }
  }
  throw lastError;
}

module.exports = { withRetry };

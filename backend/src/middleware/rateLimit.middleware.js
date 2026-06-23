/**
 * middleware/rateLimit.middleware.js — AtlasQuant AI
 * Simple in-memory rate limiter — no Redis needed.
 */
const _counts = new Map();

/**
 * rateLimiter(maxPerMin)
 * @param {number} maxPerMin requests allowed per IP per minute
 */
function rateLimiter(maxPerMin = 30) {
  return (req, res, next) => {
    const ip     = req.ip || req.connection.remoteAddress;
    const bucket = Math.floor(Date.now() / 60000);
    const key    = `${ip}_${bucket}`;
    const count  = (_counts.get(key) || 0) + 1;
    _counts.set(key, count);

    // Prune stale keys every 500 entries
    if (_counts.size > 500) {
      for (const [k] of _counts) {
        if (+k.split('_')[1] < bucket - 1) _counts.delete(k);
      }
    }

    if (count > maxPerMin) {
      return res.status(429).json({
        success: false,
        error:   `Rate limit exceeded — max ${maxPerMin} req/min per IP`,
      });
    }
    next();
  };
}

module.exports = { rateLimiter };
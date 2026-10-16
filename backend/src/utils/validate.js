/**
 * utils/validate.js — strict input validation helpers (never trust the frontend).
 */

/** Number from a number or a numeric string. Rejects NaN, Infinity, '', '12abc', null, booleans. */
function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/** true when the client did not send a value for the field. */
const isAbsent = (v) => v === undefined || v === null || v === '';

/** Positive integer id from a route param ("12" -> 12), else null. */
function toId(v) {
  const n = toNumber(v);
  return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null;
}

const LIMITS = {
  probationTradesRequired: { min: 1, max: 1000 },
  maxPositions:            { min: 1, max: 50 },
  maxDailyLossPct:         { min: 0, max: 100, minExclusive: true },
  maxPositionSize:         { min: 0, max: 1e12, minExclusive: true },
};

function checkRange(name, n, { min, max, minExclusive }, integer = false) {
  if (!Number.isFinite(n)) return `${name} must be a finite number`;
  if (integer && !Number.isInteger(n)) return `${name} must be an integer`;
  if (minExclusive ? n <= min : n < min) return `${name} must be ${minExclusive ? '>' : '>='} ${min}`;
  if (n > max) return `${name} must be <= ${max}`;
  return null;
}

/**
 * Auto-Trader config parameters. Absent fields are skipped (returned as undefined),
 * present-but-invalid fields produce an error. Returns { errors: string[], values }.
 */
function validateAutoTradeParams(body = {}) {
  const errors = [];
  const values = {};

  const fields = [
    ['probationTradesRequired', true],
    ['maxPositions', true],
    ['maxDailyLossPct', false],
    ['maxPositionSize', false],
  ];
  for (const [name, integer] of fields) {
    if (isAbsent(body[name])) continue;
    const n = toNumber(body[name]);
    const err = checkRange(name, n, LIMITS[name], integer);
    if (err) errors.push(err); else values[name] = n;
  }

  if (!isAbsent(body.positionSizeMode)) {
    if (!['fixed_pct', 'fixed_dollar', 'kelly'].includes(body.positionSizeMode)) {
      errors.push('positionSizeMode must be one of fixed_pct, fixed_dollar, kelly');
    } else values.positionSizeMode = body.positionSizeMode;
  }
  if (!isAbsent(body.positionSizeValue)) {
    const n = toNumber(body.positionSizeValue);
    const mode = body.positionSizeMode;
    const err = checkRange('positionSizeValue', n, mode === 'fixed_pct' || isAbsent(mode)
      ? { min: 0, max: 100, minExclusive: true }
      : { min: 0, max: 1e12, minExclusive: true });
    if (err) errors.push(err); else values.positionSizeValue = n;
  }
  return { errors, values };
}

module.exports = { toNumber, toId, isAbsent, validateAutoTradeParams, LIMITS };

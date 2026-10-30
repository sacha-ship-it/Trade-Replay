'use strict';

function validate(s) {
  if (!s || !/^[a-z0-9_-]{1,30}$/.test(s.id || '')) {
    throw Error('Invalid scenario id.');
  }

  for (const k of [
    'title',
    'asset',
    'timeframe',
    'context',
    'explanation',
    'source'
  ]) {
    const max = k === 'explanation' ? 1500 : 500;

    if (
      typeof s[k] !== 'string' ||
      !s[k].trim() ||
      s[k].length > max
    ) {
      throw Error(`Invalid ${k}.`);
    }
  }

  if (!['historical', 'demo'].includes(s.kind)) {
    throw Error('kind must be historical or demo.');
  }

  if (
    !Array.isArray(s.candles) ||
    s.candles.length < 15 ||
    s.candles.length > 150 ||
    !Number.isInteger(s.visible) ||
    s.visible < 10 ||
    s.visible >= s.candles.length
  ) {
    throw Error('Use 15-150 candles and a valid visible count.');
  }

  let previous = -Infinity;

  for (const c of s.candles) {
    const time = Date.parse(c.time);

    if (
      !Number.isFinite(time) ||
      time <= previous ||
      !['open', 'high', 'low', 'close'].every(
        k => Number.isFinite(c[k]) && c[k] > 0
      ) ||
      c.low > Math.min(c.open, c.close) ||
      c.high < Math.max(c.open, c.close)
    ) {
      throw Error('Invalid or unordered OHLC candles.');
    }

    previous = time;
  }

  return s;
}

function result(s, p) {
  if (p.side === 'skip') {
    return {
      r: 0,
      points: 100,
      reason: 'No trade',
      exit: null,
      index: null
    };
  }

  const entry = s.candles[s.visible - 1].close;
  const direction = p.side === 'long' ? 1 : -1;

  const risk = entry * p.stop / 100;
  const stop = entry - direction * risk;
  const target =
    entry + direction * entry * p.target / 100;

  let exit;
  let reason;
  let index;

  for (let j = s.visible; j < s.candles.length; j++) {
    const c = s.candles[j];

    if (direction * (c.open - stop) <= 0) {
      exit = c.open;
      reason = 'Stop gap';
      index = j;
      break;
    }

    if (direction * (c.open - target) >= 0) {
      exit = target;
      reason = 'Target gap';
      index = j;
      break;
    }

    const stopTouched =
      direction === 1 ? c.low <= stop : c.high >= stop;

    const targetTouched =
      direction === 1 ? c.high >= target : c.low <= target;

    if (stopTouched || targetTouched) {
      exit = stopTouched ? stop : target;

      reason = stopTouched
        ? targetTouched
          ? 'Stop first (both touched)'
          : 'Stop hit'
        : 'Target hit';

      index = j;
      break;
    }
  }

  if (exit === undefined) {
    index = s.candles.length - 1;
    exit = s.candles[index].close;
    reason = 'End of replay';
  }

  const r = direction * (exit - entry) / risk;

  return {
    r,
    points: Math.round(
      100 + 50 * Math.max(-1, Math.min(3, r))
    ),
    reason,
    exit,
    index
  };
}

module.exports = { validate, result };

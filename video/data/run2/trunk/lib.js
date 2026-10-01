'use strict';

// A tiny utility library. Each function is exported in the single exports object at the bottom.

function sum(xs) {
  return xs.reduce((a, b) => a + b, 0);
}

function last(xs) {
  return xs[xs.length - 1];
}

function truncate(str, n) {
  if (n < 1) throw new RangeError('n must be >= 1');
  return str.length > n ? str.slice(0, n - 1) + '\u2026' : str;
}

function partition(xs, pred) {
  const passing = [];
  const failing = [];
  for (const x of xs) (pred(x) ? passing : failing).push(x);
  return [passing, failing];
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

function median(xs) {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function average(xs) {
  return xs.length === 0 ? 0 : sum(xs) / xs.length;
}

function groupBy(xs, fn) {
  const out = {};
  for (const x of xs) {
    const k = fn(x);
    if (!Object.prototype.hasOwnProperty.call(out, k)) out[k] = [];
    out[k].push(x);
  }
  return out;
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  }
  return out;
}

function zip(a, b) {
  const n = Math.min(a.length, b.length);
  const out = [];
  for (let i = 0; i < n; i++) out.push([a[i], b[i]]);
  return out;
}

function range(start, end, step = 1) {
  if (step === 0) throw new Error('step must not be 0');
  const out = [];
  if (step > 0) for (let i = start; i < end; i += step) out.push(i);
  else for (let i = start; i > end; i += step) out.push(i);
  return out;
}

function unique(xs) {
  return Array.from(new Set(xs));
}

function clamp(x, lo, hi) {
  if (lo > hi) throw new Error('clamp: lo must be <= hi');
  return Math.min(Math.max(x, lo), hi);
}

function chunk(xs, size) {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error('size must be a positive integer');
  }
  const out = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

module.exports = { capitalize, sum, last, truncate, partition, median, average, groupBy, pick, zip, range, unique, clamp, chunk };

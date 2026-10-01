'use strict';

// A tiny utility library. Each function is exported in the single exports object at the bottom.

function sum(xs) {
  return xs.reduce((a, b) => a + b, 0);
}

function last(xs) {
  return xs[xs.length - 1];
}

function average(xs) {
  return xs.length === 0 ? 0 : sum(xs) / xs.length;
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
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

function countBy(xs, fn) {
  const out = {};
  for (const x of xs) {
    const k = fn(x);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

function median(xs) {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function zip(a, b) {
  const n = Math.min(a.length, b.length);
  const out = [];
  for (let i = 0; i < n; i++) out.push([a[i], b[i]]);
  return out;
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

function slugify(str) {
  return String(str).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  }
  return out;
}

function omit(obj, keys) {
  const out = {};
  for (const k of Object.keys(obj)) {
    if (!keys.includes(k)) out[k] = obj[k];
  }
  return out;
}

function chunk(xs, size) {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error('size must be a positive integer');
  }
  const out = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

module.exports = { slugify, median, sum, last, average, capitalize, truncate, partition, countBy, zip, groupBy, pick, omit, chunk };

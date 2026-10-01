const test = require('node:test');
const assert = require('node:assert');
const lib = require('./lib.js');

test('sum adds numbers', () => {
  assert.equal(lib.sum([1, 2, 3]), 6);
});

test('last returns the final element', () => {
  assert.equal(lib.last([1, 2, 3]), 3);
});

test('truncate shortens long strings with an ellipsis', () => {
  assert.equal(lib.truncate('hello world', 5), 'hell\u2026');
});

test('truncate leaves short strings and rejects n < 1', () => {
  assert.equal(lib.truncate('hi', 5), 'hi');
  assert.throws(() => lib.truncate('hi', 0));
});

test('partition splits by predicate preserving order', () => {
  assert.deepEqual(lib.partition([1, 2, 3, 4, 5], (x) => x % 2 === 1), [[1, 3, 5], [2, 4]]);
});

test('partition of empty array returns two empty arrays', () => {
  assert.deepEqual(lib.partition([], () => true), [[], []]);
});

test('capitalize fixes casing', () => {
  assert.equal(lib.capitalize('hELLO'), 'Hello');
});

test('capitalize of empty string is empty', () => {
  assert.equal(lib.capitalize(''), '');
});

test('median handles odd and even lengths without mutating', () => {
  const xs = [3, 1, 2, 4];
  assert.equal(lib.median(xs), 2.5);
  assert.deepEqual(xs, [3, 1, 2, 4]);
  assert.equal(lib.median([5, 1, 3]), 3);
});

test('median of empty array is NaN', () => {
  assert.ok(Number.isNaN(lib.median([])));
});

test('average returns the mean', () => {
  assert.equal(lib.average([1, 2, 3]), 2);
});

test('average of empty array is 0', () => {
  assert.equal(lib.average([]), 0);
});

test('groupBy groups elements by key preserving order', () => {
  assert.deepEqual(lib.groupBy([1, 2, 3, 4, 5], (x) => x % 2), { 1: [1, 3, 5], 0: [2, 4] });
});

test('groupBy handles empty input and string keys', () => {
  assert.deepEqual(lib.groupBy([], (x) => x), {});
  assert.deepEqual(lib.groupBy(['a', 'bb', 'c'], (s) => s.length), { 1: ['a', 'c'], 2: ['bb'] });
});

test('pick returns only listed keys that exist', () => {
  assert.deepEqual(lib.pick({ a: 1, b: 2, c: 3 }, ['a', 'c', 'z']), { a: 1, c: 3 });
});

test('pick does not mutate the input', () => {
  const o = { a: 1, b: 2 };
  const p = lib.pick(o, ['a']);
  assert.notEqual(p, o);
  assert.deepEqual(o, { a: 1, b: 2 });
});

test('zip pairs elements', () => {
  assert.deepEqual(lib.zip([1, 2], ['a', 'b']), [[1, 'a'], [2, 'b']]);
});

test('zip stops at the shorter array', () => {
  assert.deepEqual(lib.zip([1, 2, 3], ['a']), [[1, 'a']]);
});

test('range counts up and down', () => {
  assert.deepEqual(lib.range(0, 5, 2), [0, 2, 4]);
  assert.deepEqual(lib.range(3, 0, -1), [3, 2, 1]);
});

test('range throws on zero step', () => {
  assert.throws(() => lib.range(0, 5, 0), Error);
});

test('unique removes duplicates in order of first appearance', () => {
  assert.deepEqual(lib.unique([3, 1, 3, 2, 1]), [3, 1, 2]);
});

test('unique of empty array is empty', () => {
  assert.deepEqual(lib.unique([]), []);
});

test('clamp limits a value to the range', () => {
  assert.equal(lib.clamp(5, 0, 3), 3);
  assert.equal(lib.clamp(-1, 0, 3), 0);
  assert.equal(lib.clamp(2, 0, 3), 2);
});

test('clamp throws when lo > hi', () => {
  assert.throws(() => lib.clamp(1, 3, 0), Error);
});

test('chunk splits into groups', () => {
  assert.deepEqual(lib.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test('chunk rejects invalid size', () => {
  assert.throws(() => lib.chunk([1], 0), Error);
});

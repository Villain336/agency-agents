const test = require('node:test');
const assert = require('node:assert');
const lib = require('./lib.js');

test('sum adds numbers', () => {
  assert.equal(lib.sum([1, 2, 3]), 6);
});

test('last returns the final element', () => {
  assert.equal(lib.last([1, 2, 3]), 3);
});

test('average returns the mean', () => {
  assert.equal(lib.average([1, 2, 3]), 2);
});

test('average of empty array is 0', () => {
  assert.equal(lib.average([]), 0);
});

test('capitalize upper-cases first and lower-cases rest', () => {
  assert.equal(lib.capitalize('hELLO'), 'Hello');
});

test('capitalize of empty string is empty', () => {
  assert.equal(lib.capitalize(''), '');
});

test('truncate shortens long strings with an ellipsis', () => {
  assert.equal(lib.truncate('abcdef', 4), 'abc\u2026');
  assert.equal(lib.truncate('abc', 5), 'abc');
});

test('truncate throws when n < 1', () => {
  assert.throws(() => lib.truncate('abc', 0));
});

test('groupBy groups elements by key preserving order', () => {
  assert.deepEqual(lib.groupBy([1, 2, 3, 4, 5], (x) => x % 2), { 1: [1, 3, 5], 0: [2, 4] });
});

test('groupBy on empty array returns empty object', () => {
  assert.deepEqual(lib.groupBy([], (x) => x), {});
});

test('countBy counts by key', () => {
  assert.deepEqual(lib.countBy([1, 2, 3, 4, 5], (x) => (x % 2 ? 'odd' : 'even')), { odd: 3, even: 2 });
});

test('countBy on empty array is empty object', () => {
  assert.deepEqual(lib.countBy([], (x) => x), {});
});

test('median handles odd, even and empty', () => {
  assert.equal(lib.median([3, 1, 2]), 2);
  assert.equal(lib.median([4, 1, 3, 2]), 2.5);
  assert.ok(Number.isNaN(lib.median([])));
});

test('median does not mutate input', () => {
  const xs = [3, 1, 2];
  lib.median(xs);
  assert.deepEqual(xs, [3, 1, 2]);
});

test('zip pairs elements', () => {
  assert.deepEqual(lib.zip([1, 2], ['a', 'b']), [[1, 'a'], [2, 'b']]);
});

test('zip stops at the shorter array', () => {
  assert.deepEqual(lib.zip([1, 2, 3], ['a']), [[1, 'a']]);
});

test('slugify converts text to a slug', () => {
  assert.equal(lib.slugify('  Hello, World!  '), 'hello-world');
});

test('slugify collapses runs and strips edge dashes', () => {
  assert.equal(lib.slugify('--A   b__C--'), 'a-b-c');
});

test('pick keeps only listed keys that exist', () => {
  assert.deepEqual(lib.pick({ a: 1, b: 2, c: 3 }, ['a', 'c', 'z']), { a: 1, c: 3 });
});

test('pick returns a new object', () => {
  const o = { a: 1 };
  assert.notEqual(lib.pick(o, ['a']), o);
  assert.deepEqual(lib.pick(o, []), {});
});

test('omit removes listed keys', () => {
  assert.deepEqual(lib.omit({ a: 1, b: 2, c: 3 }, ['a', 'c']), { b: 2 });
});

test('omit does not mutate input', () => {
  const o = { a: 1, b: 2 };
  lib.omit(o, ['a']);
  assert.deepEqual(o, { a: 1, b: 2 });
});

test('chunk splits into groups', () => {
  assert.deepEqual(lib.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test('chunk rejects invalid size', () => {
  assert.throws(() => lib.chunk([1], 0), Error);
});

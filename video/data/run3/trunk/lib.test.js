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

test('capitalize fixes casing', () => {
  assert.equal(lib.capitalize('hELLO'), 'Hello');
});

test('capitalize handles empty string', () => {
  assert.equal(lib.capitalize(''), '');
});

test('omit removes listed keys', () => {
  assert.deepEqual(lib.omit({ a: 1, b: 2, c: 3 }, ['a', 'c']), { b: 2 });
});

test('omit does not mutate input', () => {
  const o = { a: 1, b: 2 };
  lib.omit(o, ['a']);
  assert.deepEqual(o, { a: 1, b: 2 });
});

test('average returns the mean', () => {
  assert.equal(lib.average([1, 2, 3, 6]), 3);
});

test('average of empty array is 0', () => {
  assert.equal(lib.average([]), 0);
});

test('countBy counts by key', () => {
  assert.deepEqual(lib.countBy([1, 2, 3, 4, 5], (x) => (x % 2 ? 'odd' : 'even')), { odd: 3, even: 2 });
});

test('countBy on empty array', () => {
  assert.deepEqual(lib.countBy([], (x) => x), {});
});

test('partition splits by predicate preserving order', () => {
  assert.deepEqual(lib.partition([1, 2, 3, 4, 5], (x) => x % 2 === 1), [[1, 3, 5], [2, 4]]);
});

test('partition handles empty input', () => {
  assert.deepEqual(lib.partition([], () => true), [[], []]);
});

test('pick returns only listed keys', () => {
  assert.deepEqual(lib.pick({ a: 1, b: 2, c: 3 }, ['a', 'c']), { a: 1, c: 3 });
});

test('pick ignores keys missing from obj', () => {
  assert.deepEqual(lib.pick({ a: 1 }, ['a', 'z']), { a: 1 });
});

test('flatten flattens one level', () => {
  assert.deepEqual(lib.flatten([1, [2, 3], [4]]), [1, 2, 3, 4]);
});

test('flatten keeps deeper nesting', () => {
  assert.deepEqual(lib.flatten([[1, [2]], 3]), [1, [2], 3]);
});

test('groupBy groups elements by key preserving order', () => {
  assert.deepEqual(lib.groupBy([1, 2, 3, 4, 5], (x) => (x % 2 ? 'odd' : 'even')), { odd: [1, 3, 5], even: [2, 4] });
});

test('groupBy on empty array returns empty object', () => {
  assert.deepEqual(lib.groupBy([], (x) => x), {});
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

test('clamp limits x to the range', () => {
  assert.equal(lib.clamp(5, 0, 3), 3);
  assert.equal(lib.clamp(-1, 0, 3), 0);
  assert.equal(lib.clamp(2, 0, 3), 2);
});

test('clamp throws when lo > hi', () => {
  assert.throws(() => lib.clamp(1, 3, 0), Error);
});

test('unique removes duplicates keeping first appearance order', () => {
  assert.deepEqual(lib.unique([3, 1, 3, 2, 1]), [3, 1, 2]);
});

test('unique of empty array is empty', () => {
  assert.deepEqual(lib.unique([]), []);
});

test('chunk splits into groups, last may be shorter', () => {
  assert.deepEqual(lib.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test('chunk throws on invalid size', () => {
  assert.throws(() => lib.chunk([1], 0), Error);
  assert.throws(() => lib.chunk([1], 1.5), Error);
});

test('slugify converts text to a slug', () => {
  assert.equal(lib.slugify('  Hello, World!  '), 'hello-world');
});

test('slugify collapses runs and strips edge dashes', () => {
  assert.equal(lib.slugify('--Foo   &&  Bar--'), 'foo-bar');
});

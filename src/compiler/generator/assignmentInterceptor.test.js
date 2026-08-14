// src/compiler/generator/assignmentInterceptor.test.js
const assert = require('node:assert/strict');
const test = require('node:test');
const { interceptAssignments } = require('./assignmentInterceptor');

test('intercepts simple assignments', () => {
  const input = `count = 5;`;
  const expected = `count = 5; queueUpdate({ count: true });`;
  assert.equal(interceptAssignments(input, ['count']), expected);
});

test('ignores initial let declarations', () => {
  const input = `let count = 0;`;
  assert.equal(interceptAssignments(input, ['count']), input);
});

test('intercepts compound assignments and increment and decrement operators', () => {
  const input = `count += 1;\ntotal--;\n++count;`;
  const expected = `count += 1; queueUpdate({ count: true });\ntotal--; queueUpdate({ total: true });\n++count; queueUpdate({ count: true });`;
  assert.equal(interceptAssignments(input, ['count', 'total']), expected);
});

test('intercepts object property mutations to trigger the root object', () => {
  const input = `user.name = "Ada";`;
  const expected = `user.name = "Ada"; queueUpdate({ user: true });`;
  assert.equal(interceptAssignments(input, ['user']), expected);
});

test('preserves assignments in strings, comments, and template literals', () => {
  const input = [
    'const message = "count = 5;";',
    '// count = 5;',
    'const label = `count = 5;`;',
    'count = "a;b";'
  ].join('\n');
  const expected = [
    'const message = "count = 5;";',
    '// count = 5;',
    'const label = `count = 5;`;',
    'count = "a;b"; queueUpdate({ count: true });'
  ].join('\n');

  assert.equal(interceptAssignments(input, ['count']), expected);
});

test('does not mistake arrow parameters or equality checks for assignments', () => {
  const input = 'items.map(count => count + 1);\nif (count === 1) {}';

  assert.equal(interceptAssignments(input, ['count']), input);
});

test('leaves reactive identifier reads without mutations unchanged', () => {
  assert.equal(interceptAssignments('count', ['count']), 'count');
});

test('supports reactive names containing dollar signs', () => {
  const input = '$count = 1;';
  const expected = '$count = 1; queueUpdate({ $count: true });';

  assert.equal(interceptAssignments(input, ['$count']), expected);
});
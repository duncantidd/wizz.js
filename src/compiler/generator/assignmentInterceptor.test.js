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

test('leaves for-loop headers untouched while still intercepting body mutations', () => {
  const input = 'for (count = 0; count < 10; count++) { total += count; }';
  const expected = 'for (count = 0; count < 10; count++) { total += count; queueUpdate({ total: true }); }';

  assert.equal(interceptAssignments(input, ['count', 'total']), expected);
});

test('leaves arrow-function default parameters untouched', () => {
  const input = 'const render = (count = 1) => {};\ncount = 2;';
  const expected = 'const render = (count = 1) => {};\ncount = 2; queueUpdate({ count: true });';

  assert.equal(interceptAssignments(input, ['count']), expected);
});

test('preserves regular expression literals that resemble assignments', () => {
  const input = 'const pattern = /count = 5;/;';

  assert.equal(interceptAssignments(input, ['count']), input);
});

test('rewrites statements containing regex literals at their true end', () => {
  const input = 'x = /a;b/.test(s);';
  const expected = 'x = /a;b/.test(s); queueUpdate({ x: true });';

  assert.equal(interceptAssignments(input, ['x']), expected);
});

test('preserves regex literals passed as call arguments', () => {
  const input = 'const matches = value.match(/count = 3;/);';

  assert.equal(interceptAssignments(input, ['count']), input);
});

test('preserves division while intercepting an outer assignment', () => {
  const input = 'average = total / count;';
  const expected = 'average = total / count; queueUpdate({ average: true });';

  assert.equal(interceptAssignments(input, ['average', 'total', 'count']), expected);
});

test('preserves regex literals after return statements', () => {
  const input = 'function matches() { return /count = 5;/; }';

  assert.equal(interceptAssignments(input, ['count']), input);
});

test('still intercepts statement mutations inside function and block bodies', () => {
  assert.equal(
    interceptAssignments('function increment() { count += 1; }', ['count']),
    'function increment() { count += 1; queueUpdate({ count: true }); }'
  );
  assert.equal(
    interceptAssignments('if (!name) { name = "friend"; }', ['name']),
    'if (!name) { name = "friend"; queueUpdate({ name: true }); }'
  );
  assert.equal(
    interceptAssignments('if (ready) { count = 1; }', ['count']),
    'if (ready) { count = 1; queueUpdate({ count: true }); }'
  );
});

test('leaves unbraced control-flow bodies untransformed', () => {
  const conditional = 'if (ready) count = 1; else count = 2;';
  const loop = 'while (ready) count += 1;';

  assert.equal(interceptAssignments(conditional, ['count']), conditional);
  assert.equal(interceptAssignments(loop, ['count']), loop);
});
// src/compiler/generator/assignmentInterceptor.test.js
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  interceptAssignments,
  findReactiveMutations,
  interceptHandlerExpression,
  findHandlerMutations,
  normalizeHandlerExpression,
  findUntrackedMutations,
  findUntrackedHandlerMutations
} = require('./assignmentInterceptor');

// Executes an intercepted script the way a component factory would: with a
// __wizzQueueUpdate dispatcher in scope, and captures the notifications it sends.
function runScript(script, names) {
  const notifications = [];
  const execute = new Function('__wizzQueueUpdate', script);
  execute((changes) => notifications.push(changes));
  return notifications;
}

function assertValidJs(script) {
  assert.doesNotThrow(() => new Function('__wizzQueueUpdate', script), `Generated invalid JS: ${script}`);
}

test('intercepts simple assignments', () => {
  const input = `count = 5;`;
  const expected = `count = 5; __wizzQueueUpdate({ count: true });`;
  assert.equal(interceptAssignments(input, ['count']), expected);
});

test('ignores initial let declarations', () => {
  const input = `let count = 0;`;
  assert.equal(interceptAssignments(input, ['count']), input);
});

test('intercepts compound assignments and increment and decrement operators', () => {
  const input = `count += 1;\ntotal--;\n++count;`;
  const expected = `count += 1; __wizzQueueUpdate({ count: true });\ntotal--; __wizzQueueUpdate({ total: true });\n++count; __wizzQueueUpdate({ count: true });`;
  assert.equal(interceptAssignments(input, ['count', 'total']), expected);
});

test('intercepts object property mutations to trigger the root object', () => {
  const input = `user.name = "Ada";`;
  const expected = `user.name = "Ada"; __wizzQueueUpdate({ user: true });`;
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
    'count = "a;b"; __wizzQueueUpdate({ count: true });'
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
  const expected = '$count = 1; __wizzQueueUpdate({ $count: true });';

  assert.equal(interceptAssignments(input, ['$count']), expected);
});

test('leaves for-loop headers untouched while still intercepting body mutations', () => {
  const input = 'for (count = 0; count < 10; count++) { total += count; }';
  const expected = 'for (count = 0; count < 10; count++) { total += count; __wizzQueueUpdate({ total: true }); }';

  assert.equal(interceptAssignments(input, ['count', 'total']), expected);
});

test('leaves arrow-function default parameters untouched', () => {
  const input = 'const render = (count = 1) => {};\ncount = 2;';
  const expected = 'const render = (count = 1) => {};\ncount = 2; __wizzQueueUpdate({ count: true });';

  assert.equal(interceptAssignments(input, ['count']), expected);
});

test('preserves regular expression literals that resemble assignments', () => {
  const input = 'const pattern = /count = 5;/;';

  assert.equal(interceptAssignments(input, ['count']), input);
});

test('rewrites statements containing regex literals at their true end', () => {
  const input = 'x = /a;b/.test(s);';
  const expected = 'x = /a;b/.test(s); __wizzQueueUpdate({ x: true });';

  assert.equal(interceptAssignments(input, ['x']), expected);
});

test('preserves regex literals passed as call arguments', () => {
  const input = 'const matches = value.match(/count = 3;/);';

  assert.equal(interceptAssignments(input, ['count']), input);
});

test('preserves division while intercepting an outer assignment', () => {
  const input = 'average = total / count;';
  const expected = 'average = total / count; __wizzQueueUpdate({ average: true });';

  assert.equal(interceptAssignments(input, ['average', 'total', 'count']), expected);
});

test('preserves regex literals after return statements', () => {
  const input = 'function matches() { return /count = 5;/; }';

  assert.equal(interceptAssignments(input, ['count']), input);
});

test('still intercepts statement mutations inside function and block bodies', () => {
  assert.equal(
    interceptAssignments('function increment() { count += 1; }', ['count']),
    'function increment() { count += 1; __wizzQueueUpdate({ count: true }); }'
  );
  assert.equal(
    interceptAssignments('if (!name) { name = "friend"; }', ['name']),
    'if (!name) { name = "friend"; __wizzQueueUpdate({ name: true }); }'
  );
  assert.equal(
    interceptAssignments('if (ready) { count = 1; }', ['count']),
    'if (ready) { count = 1; __wizzQueueUpdate({ count: true }); }'
  );
});

test('leaves unbraced control-flow bodies untransformed', () => {
  const conditional = 'if (ready) count = 1; else count = 2;';
  const loop = 'while (ready) count += 1;';
  const doLoop = 'do count = 1; while (ready);';
  const multilineConditional = 'if (ready)\n  count = 1;\nelse\n  count = 2;';

  assert.equal(interceptAssignments(conditional, ['count']), conditional);
  assert.equal(interceptAssignments(loop, ['count']), loop);
  assert.equal(interceptAssignments(doLoop, ['count']), doLoop);
  assert.equal(interceptAssignments(multilineConditional, ['count']), multilineConditional);
});

test('intercepts mutations inside arrow-function callbacks passed as arguments', () => {
  // Previously a documented scanner boundary: parentheses hid these bodies.
  assert.equal(
    interceptAssignments('onMount(() => { count = 1 });', ['count']),
    'onMount(() => { count = 1; __wizzQueueUpdate({ count: true }); });'
  );
  assert.equal(
    interceptAssignments('setTimeout(() => { count = 1 }, 100);', ['count']),
    'setTimeout(() => { count = 1; __wizzQueueUpdate({ count: true }); }, 100);'
  );
  assert.equal(
    interceptAssignments('button.addEventListener("click", () => { total += 1 });', ['total']),
    'button.addEventListener("click", () => { total += 1; __wizzQueueUpdate({ total: true }); });'
  );
});

test('intercepts mutations in async arrows and handlers with parameters', () => {
  assert.equal(
    interceptAssignments('saveButton.onclick = async () => { status = "saved"; };', ['status']),
    'saveButton.onclick = async () => { status = "saved"; __wizzQueueUpdate({ status: true }); };'
  );
  assert.equal(
    interceptAssignments('input.addEventListener("input", (event) => { name = event.target.value; });', ['name']),
    'input.addEventListener("input", (event) => { name = event.target.value; __wizzQueueUpdate({ name: true }); });'
  );
});

test('intercepts mutations in object method shorthand, getters, and setters', () => {
  assert.equal(
    interceptAssignments('const api = { bump() { count += 1; } };', ['count']),
    'const api = { bump() { count += 1; __wizzQueueUpdate({ count: true }); } };'
  );
  assert.equal(
    interceptAssignments('const box = { get label() { return label; }, set label(value) { label = value; } };', ['label']),
    'const box = { get label() { return label; }, set label(value) { label = value; __wizzQueueUpdate({ label: true }); } };'
  );
});

test('intercepts mutations in class methods but not class field initializers', () => {
  assert.equal(
    interceptAssignments('class Counter { increment() { count += 1; } }', ['count']),
    'class Counter { increment() { count += 1; __wizzQueueUpdate({ count: true }); } }'
  );
  // A class field named like a reactive variable defines an instance property;
  // rewriting inside the class body would be a syntax error.
  assert.equal(interceptAssignments('class Counter { count = 1; }', ['count']), 'class Counter { count = 1; }');
  assert.equal(
    interceptAssignments('class Counter { handler = () => { count = 1; }; }', ['count']),
    'class Counter { handler = () => { count = 1; __wizzQueueUpdate({ count: true }); }; }'
  );
});

test('intercepts mutations in async functions, generators, and IIFEs', () => {
  assert.equal(
    interceptAssignments('async function load() { count = await fetchCount(); }', ['count']),
    'async function load() { count = await fetchCount(); __wizzQueueUpdate({ count: true }); }'
  );
  assert.equal(
    interceptAssignments('function* sequence() { step = yield nextStep(); }', ['step']),
    'function* sequence() { step = yield nextStep(); __wizzQueueUpdate({ step: true }); }'
  );
  assert.equal(
    interceptAssignments('(function () { count = 1; })();', ['count']),
    '(function () { count = 1; __wizzQueueUpdate({ count: true }); })();'
  );
});

test('intercepts mutations in switch cases, do-while bodies, and try blocks', () => {
  assert.equal(
    interceptAssignments('switch (mode) { case "fast": count = 1; break; default: count = 2; }', ['count']),
    'switch (mode) { case "fast": count = 1; __wizzQueueUpdate({ count: true }); break; default: count = 2; __wizzQueueUpdate({ count: true }); }'
  );
  assert.equal(
    interceptAssignments('do { count = 1; } while (ready);', ['count']),
    'do { count = 1; __wizzQueueUpdate({ count: true }); } while (ready);'
  );
  assert.equal(
    interceptAssignments('try { count = 1; } catch (error) { count = 2; } finally { count = 3; }', ['count']),
    [
      'try { count = 1; __wizzQueueUpdate({ count: true }); }',
      ' catch (error) { count = 2; __wizzQueueUpdate({ count: true }); }',
      ' finally { count = 3; __wizzQueueUpdate({ count: true }); }'
    ].join('')
  );
});

test('intercepts mutations in for-of bodies and nested functions', () => {
  assert.equal(
    interceptAssignments('for (const item of items) { total += 1; }', ['total']),
    'for (const item of items) { total += 1; __wizzQueueUpdate({ total: true }); }'
  );
  assert.equal(
    interceptAssignments('function outer() { function inner() { count = 1; } }', ['count']),
    'function outer() { function inner() { count = 1; __wizzQueueUpdate({ count: true }); } }'
  );
});

test('intercepts statements that omit semicolons before a closing brace', () => {
  assert.equal(
    interceptAssignments('function increment() { count += 1 }', ['count']),
    'function increment() { count += 1; __wizzQueueUpdate({ count: true }); }'
  );
  assert.equal(
    interceptAssignments('if (ready) { count = 1 }', ['count']),
    'if (ready) { count = 1; __wizzQueueUpdate({ count: true }); }'
  );
});

test('intercepts both statements when a semicolon-less mutation ends a line', () => {
  assert.equal(
    interceptAssignments('count = 1\ntotal = 2;', ['count', 'total']),
    'count = 1; __wizzQueueUpdate({ count: true });\ntotal = 2; __wizzQueueUpdate({ total: true });'
  );
});

test('treats a newline before a prefix update as a new statement', () => {
  assert.equal(
    interceptAssignments('count\n++total;', ['count', 'total']),
    'count\n++total; __wizzQueueUpdate({ total: true });'
  );
  assert.equal(
    interceptAssignments('count++\n--total;', ['count', 'total']),
    'count++; __wizzQueueUpdate({ count: true });\n--total; __wizzQueueUpdate({ total: true });'
  );
});

test('leaves arrow parameter mutations alone when they shadow reactive state', () => {
  assert.equal(
    interceptAssignments('items.map(count => { count = 1; });', ['count']),
    'items.map(count => { count = 1; });'
  );
  assert.equal(
    interceptAssignments('items.forEach((count, index) => { count = index; });', ['count']),
    'items.forEach((count, index) => { count = index; });'
  );
  assert.equal(
    interceptAssignments('function render(count) { count = 1; }', ['count']),
    'function render(count) { count = 1; }'
  );
});

test('intercepts non-shadowed reactive names inside parameter-bearing bodies', () => {
  assert.equal(
    interceptAssignments('items.forEach((item, index) => { total += item; });', ['total']),
    'items.forEach((item, index) => { total += item; __wizzQueueUpdate({ total: true }); });'
  );
});

test('shadowing ends when the parameter-bearing body closes', () => {
  const input = 'items.map(count => { count = 1; });\ncount = 2;';
  const expected = 'items.map(count => { count = 1; });\ncount = 2; __wizzQueueUpdate({ count: true });';

  assert.equal(interceptAssignments(input, ['count']), expected);
});

test('outer parameters stay shadowed inside nested bodies', () => {
  const input = 'function outer(count) { items.map(() => { count = 1; }); }';

  assert.equal(interceptAssignments(input, ['count']), input);
});

test('catch parameters shadow reactive state in the catch body', () => {
  assert.equal(
    interceptAssignments('try { } catch (count) { count = 1; }', ['count']),
    'try { } catch (count) { count = 1; }'
  );
});

test('intercepts assignments inside an arrow block body and not its condition', () => {
  assert.equal(
    interceptAssignments('const load = () => { if (ready) { count = 1; } };', ['count']),
    'const load = () => { if (ready) { count = 1; __wizzQueueUpdate({ count: true }); } };'
  );
});

test('does not mistake division followed by a regex for one merged statement', () => {
  // The previous scanner consumed division as an unterminated regex and
  // merged these three statements, placing the notification after the regex.
  const input = 'average = total / count;\nconst re = /count = 5/;\ndone = 1;';
  const expected = [
    'average = total / count; __wizzQueueUpdate({ average: true });',
    '\nconst re = /count = 5/;\n',
    'done = 1; __wizzQueueUpdate({ done: true });'
  ].join('');

  assert.equal(interceptAssignments(input, ['average', 'done']), expected);
});

test('does not mistake a chained division for a regex literal', () => {
  const input = 'scaled = value++ / 2 / divisor;\ndone = 1;';
  const expected = 'scaled = value++ / 2 / divisor; __wizzQueueUpdate({ scaled: true });\ndone = 1; __wizzQueueUpdate({ done: true });';

  assert.equal(interceptAssignments(input, ['scaled', 'done']), expected);
});

test('rewrites statements whose values contain regex character classes', () => {
  const input = 'pattern = /a[/]b/gi.exec(text);';
  const expected = 'pattern = /a[/]b/gi.exec(text); __wizzQueueUpdate({ pattern: true });';

  assert.equal(interceptAssignments(input, ['pattern']), expected);
});

test('rewrites statements containing regex literals after typeof and case', () => {
  assert.equal(
    interceptAssignments('kind = typeof /x = 1/.source;', ['kind']),
    'kind = typeof /x = 1/.source; __wizzQueueUpdate({ kind: true });'
  );
  assert.equal(
    interceptAssignments('switch (probe) { case /y = 2/.test(s): flag = true; }', ['flag']),
    'switch (probe) { case /y = 2/.test(s): flag = true; __wizzQueueUpdate({ flag: true }); }'
  );
});

test('preserves template literals with interpolations and rewrites the surrounding statement', () => {
  const input = 'greeting = `Hello ${user.name}, you have ${unread} messages`;';
  const expected = 'greeting = `Hello ${user.name}, you have ${unread} messages`; __wizzQueueUpdate({ greeting: true });';

  assert.equal(interceptAssignments(input, ['greeting']), expected);
});

test('leaves assignments inside template interpolations untransformed but rewrites the outer statement', () => {
  const input = 'label = `value: ${count = 1}`;';
  const expected = 'label = `value: ${count = 1}`; __wizzQueueUpdate({ label: true });';

  assert.equal(interceptAssignments(input, ['label', 'count']), expected);
});

test('handles nested template literals inside interpolations', () => {
  const input = 'markup = `<div>${ items.map(item => `<b>${item}</b>`) }</div>`;\ndone = 1;';
  const expected = [
    'markup = `<div>${ items.map(item => `<b>${item}</b>`) }</div>`; __wizzQueueUpdate({ markup: true });',
    '\ndone = 1; __wizzQueueUpdate({ done: true });'
  ].join('');

  assert.equal(interceptAssignments(input, ['markup', 'done']), expected);
});

test('preserves escaped backticks and dollar signs while scanning templates', () => {
  const input = 'text = `a\\`b\\${c}d`;\ndone = 1;';
  const expected = 'text = `a\\`b\\${c}d`; __wizzQueueUpdate({ text: true });\ndone = 1; __wizzQueueUpdate({ done: true });';

  assert.equal(interceptAssignments(input, ['text', 'done']), expected);
});

test('rewrites assignments whose values are or contain templates', () => {
  assert.equal(
    interceptAssignments('label = `x`;', ['label']),
    'label = `x`; __wizzQueueUpdate({ label: true });'
  );
  assert.equal(
    interceptAssignments('page = `${section}-${index}`;', ['page']),
    'page = `${section}-${index}`; __wizzQueueUpdate({ page: true });'
  );
});

test('does not rewrite assignments inside object literal expression position', () => {
  const input = 'const options = { mode: count = 1 };';

  assert.equal(interceptAssignments(input, ['count']), input);
});

test('does not rewrite assignments inside call arguments or conditions', () => {
  const inputs = [
    'log(count = 1);',
    'if (count = 1) { }',
    'while (count = next()) { }',
    'return Math.max(count = 1, 0);'
  ];

  for (const input of inputs) {
    assert.equal(interceptAssignments(input, ['count']), input, input);
  }
});

test('does not rewrite expression-bodied arrows', () => {
  const input = 'setTimeout(() => count = 1, 100);';

  assert.equal(interceptAssignments(input, ['count']), input);
});

test('does not rewrite chained assignments beyond the first target', () => {
  const input = 'count = total = 1;';
  const expected = 'count = total = 1; __wizzQueueUpdate({ count: true });';

  assert.equal(interceptAssignments(input, ['count', 'total']), expected);
});

test('rewrites a sequence expression after its terminating semicolon', () => {
  const input = 'count = 1, other = 2;';
  const expected = 'count = 1, other = 2; __wizzQueueUpdate({ count: true });';

  assert.equal(interceptAssignments(input, ['count']), expected);
});

test('rewrites statements with ternary and compound values', () => {
  assert.equal(
    interceptAssignments('count = ready ? 1 : 2;', ['count']),
    'count = ready ? 1 : 2; __wizzQueueUpdate({ count: true });'
  );
  assert.equal(
    interceptAssignments('items = ready ? [1, 2] : { a: 1 };', ['items']),
    'items = ready ? [1, 2] : { a: 1 }; __wizzQueueUpdate({ items: true });'
  );
  assert.equal(
    interceptAssignments('count = cond ? x : y, z;', ['count']),
    'count = cond ? x : y, z; __wizzQueueUpdate({ count: true });'
  );
});

test('rewrites assignments spanning multiple lines', () => {
  const input = 'count =\n  a +\n  b;';
  const expected = 'count =\n  a +\n  b; __wizzQueueUpdate({ count: true });';

  assert.equal(interceptAssignments(input, ['count']), expected);
});

test('does not rewrite destructuring declarations or assignment statements', () => {
  const inputs = [
    'let { count, other } = source;',
    'let [count] = source;',
    '({ count } = source);',
    '[count] = source;'
  ];

  for (const input of inputs) {
    assert.equal(interceptAssignments(input, ['count']), input, input);
  }
});

test('does not rewrite property assignments through a receiver object', () => {
  const inputs = [
    'this.count = 1;',
    'obj.count = 1;',
    'obj?.count = 1;'
  ];

  for (const input of inputs) {
    assert.equal(interceptAssignments(input, ['count']), input, input);
  }
});

test('rewrites element and property chains rooted at the reactive name', () => {
  assert.equal(
    interceptAssignments('items[0] = "x";', ['items']),
    'items[0] = "x"; __wizzQueueUpdate({ items: true });'
  );
  assert.equal(
    interceptAssignments('user["name"] = "Ada";', ['user']),
    'user["name"] = "Ada"; __wizzQueueUpdate({ user: true });'
  );
  assert.equal(
    interceptAssignments('user.tags[0].label = "x";', ['user']),
    'user.tags[0].label = "x"; __wizzQueueUpdate({ user: true });'
  );
  assert.equal(
    interceptAssignments('user.age++;', ['user']),
    'user.age++; __wizzQueueUpdate({ user: true });'
  );
});

test('rewrites chains split across comments and newlines', () => {
  assert.equal(
    interceptAssignments('user /* which */ . name = "Ada";', ['user']),
    'user /* which */ . name = "Ada"; __wizzQueueUpdate({ user: true });'
  );
  assert.equal(
    interceptAssignments('user\n  .name = "Ada";', ['user']),
    'user\n  .name = "Ada"; __wizzQueueUpdate({ user: true });'
  );
});

test('does not rewrite assignments to names that merely contain a reactive name', () => {
  const inputs = [
    'counts = 1;',
    'mycount = 1;',
    'countX = 1;',
    'Count = 1;'
  ];

  for (const input of inputs) {
    assert.equal(interceptAssignments(input, ['count']), input, input);
  }
});

test('does not rewrite var, const, or let declarations of reactive names', () => {
  for (const keyword of ['var', 'const', 'let']) {
    assert.equal(interceptAssignments(`${keyword} count = 1;`, ['count']), `${keyword} count = 1;`);
  }
});

test('leaves comments, whitespace-only scripts, and empty scripts unchanged', () => {
  const inputs = ['', '   \n  ', '// nothing here', '/* nothing */'];

  for (const input of inputs) {
    assert.equal(interceptAssignments(input, ['count']), input, input);
  }
});

test('recovers from unterminated strings, templates, comments, and regexes', () => {
  const inputs = [
    'const s = "unterminated',
    'const s = `unterminated',
    '/* unterminated block comment count = 1;',
    'const re = /unterminated count = 1;'
  ];

  for (const input of inputs) {
    assert.equal(interceptAssignments(input, ['count']), input, input);
  }
});

test('handles mutations inside comments and unterminated regions without corrupting code', () => {
  const input = [
    '// count = 1;',
    '/* count = 1; */',
    'count = 2; // trailing comment'
  ].join('\n');
  const expected = [
    '// count = 1;',
    '/* count = 1; */',
    'count = 2; __wizzQueueUpdate({ count: true }); // trailing comment'
  ].join('\n');

  assert.equal(interceptAssignments(input, ['count']), expected);
});

test('rewrites a mutation preceded by a block comment', () => {
  const input = '/* setup */ count = 1;';
  const expected = '/* setup */ count = 1; __wizzQueueUpdate({ count: true });';

  assert.equal(interceptAssignments(input, ['count']), expected);
});

test('rewrites compound operators across the full assignment family', () => {
  const operators = ['=', '+=', '-=', '*=', '/=', '%=', '**=', '&&=', '||=', '??=', '&=', '|=', '^=', '<<=', '>>=', '>>>='];
  for (const operator of operators) {
    const input = `count ${operator} 1;`;
    const expected = `count ${operator} 1; __wizzQueueUpdate({ count: true });`;
    assert.equal(interceptAssignments(input, ['count']), expected, operator);
  }
});

test('does not treat comparison or arrow tokens as assignment operators', () => {
  const inputs = [
    'count == 1;',
    'count === 1;',
    'count != 1;',
    'count !== 1;',
    'count >= 1;',
    'count <= 1;',
    'count => 1;'
  ];

  for (const input of inputs) {
    assert.equal(interceptAssignments(input, ['count']), input, input);
  }
});

test('supports underscore and unicode-adjacent identifier spellings', () => {
  assert.equal(
    interceptAssignments('_private = 1;', ['_private']),
    '_private = 1; __wizzQueueUpdate({ _private: true });'
  );
  assert.equal(
    interceptAssignments('$total += 1;', ['$total']),
    '$total += 1; __wizzQueueUpdate({ $total: true });'
  );
});

test('returns the script untouched when no reactive names are provided', () => {
  const input = 'count = 1;';

  assert.equal(interceptAssignments(input, []), input);
  assert.equal(interceptAssignments(input, undefined), input);
});

test('executed intercepted scripts notify the dispatcher with the mutated name', () => {
  const script = interceptAssignments('let count = 0;\nfunction increment() { count += 1; }\nincrement();', ['count']);

  const notifications = [];
  new Function('__wizzQueueUpdate', script)((changes) => notifications.push(changes));
  assert.deepEqual(notifications, [{ count: true }]);
});

test('intercepted arrow callbacks notify when executed after mounting', () => {
  const script = interceptAssignments('function register() { setTimeout(() => { count = 1 }, 0); }', ['count']);
  assertValidJs(script);

  const notifications = [];
  const run = new Function('__wizzQueueUpdate', `${script}\nregister();`);
  run((changes) => notifications.push(changes));

  return new Promise((resolve) => setTimeout(() => {
    assert.deepEqual(notifications, [{ count: true }]);
    resolve();
  }, 10));
});

test('every intercepted script with string, comment, regex, and template hazards stays valid JavaScript', () => {
  const scripts = [
    'function f() { count = "a; }"; }',
    'function f() { count = `a${b}c; }`; }',
    'function f() { count = /a;[/]b/g; }',
    'function f() { /* count = 1; */ count = 2; }',
    'function f() { count = cond ? { a: ";" } : [`;`]; }',
    'function f() { label = `${count = 1}`; }',
    'function f() { count = 1, other = 2; }',
    'function f() { if (ready) { count = 1 } total = 2 }',
    'switch (mode) { case 1: count = 1; break; default: count = 0 }',
    'class A { field = 1; method() { count = 1; } }'
  ];

  for (const input of scripts) {
    const output = interceptAssignments(input, ['count', 'total', 'label']);
    assert.doesNotThrow(
      () => new Function('__wizzQueueUpdate', output),
      `Interception broke valid JS:\n  in:  ${input}\n  out: ${output}`
    );
  }
});

test('notification text matches the generated component dispatcher contract', () => {
  assert.equal(
    interceptAssignments('count = 1;', ['count']),
    'count = 1; __wizzQueueUpdate({ count: true });'
  );
});
test('locates statement-level mutations of the given names', () => {
  const script = 'let clicks = 0;\nfunction bump() {\n  name = "Ada";\n  clicks++;\n}';
  const mutations = findReactiveMutations(script, ['name']);

  assert.deepEqual(mutations.map((mutation) => [mutation.name, mutation.line, mutation.column]), [
    ['name', 3, 3]
  ]);
});

test('reports every assignment operator and update form', () => {
  const script = 'a = 1;\nb += 2;\nc++;\n++d;\ne.name = "x";';
  const names = ['a', 'b', 'c', 'd', 'e'];
  const mutations = findReactiveMutations(script, names);

  assert.deepEqual(mutations.map((mutation) => mutation.name), ['a', 'b', 'c', 'd', 'e']);
});

test('respects function parameter shadowing for prop names', () => {
  const script = 'function rename(name) { name = "local"; } rename("x");';
  assert.deepEqual(findReactiveMutations(script, ['name']), []);
});

test('respects block-scoped let, const, and var shadowing for prop names', () => {
  const blockShadow = '{ let name = "local"; name = "other"; }';
  assert.deepEqual(findReactiveMutations(blockShadow, ['name']), []);

  const constShadow = 'function f() { const total = 1; total = 2; }';
  assert.deepEqual(findReactiveMutations(constShadow, ['total']), []);

  const varShadow = 'if (ready) { var label = "x"; label = "y"; }';
  assert.deepEqual(findReactiveMutations(varShadow, ['label']), []);
});

test('shadowing ends when the declaring block closes', () => {
  const script = '{ let count = 1; }\ncount = 2;';
  const mutations = findReactiveMutations(script, ['count']);

  assert.deepEqual(mutations.map((mutation) => mutation.name), ['count']);
});

test('for-loop header declarations shadow the braced body', () => {
  const script = 'for (const item of items) {\n  item = 1;\n}';
  assert.deepEqual(findReactiveMutations(script, ['item']), []);
});

test('handles destructuring and multi-declarator shadow declarations', () => {
  const destructuring = '{ let { name, role } = user; name = "x"; role = "y"; }';
  assert.deepEqual(findReactiveMutations(destructuring, ['name', 'role']), []);

  const multi = '{ let a = 1, b = 2; b = 3; }';
  assert.deepEqual(findReactiveMutations(multi, ['b']), []);
});

test('accepts Set input and returns nothing for empty names or empty script', () => {
  assert.deepEqual(findReactiveMutations('name = 1;', new Set(['name'])).map((m) => m.name), ['name']);
  assert.deepEqual(findReactiveMutations('name = 1;', []), []);
  assert.deepEqual(findReactiveMutations('', ['name']), []);
});

test('leaves mutations of block-local names unrewritten during interception', () => {
  const script = 'let count = 0;\n{ let count = 1; count = 2; }\ncount = 3;';
  const rewritten = interceptAssignments(script, ['count']);

  // Only the outer component-state mutation is intercepted.
  assert.equal(rewritten.split('__wizzQueueUpdate({ count: true });').length - 1, 1);
  assert.match(rewritten, /count = 3; __wizzQueueUpdate\(\{ count: true \}\);/);
});

// --- Persistent write-through (milestone 17) ---

const THEME = { name: 'theme', storageKey: 'theme' };

test('inserts a persist write after the queue notification for persistent vars', () => {
  assert.equal(
    interceptAssignments('theme = nextTheme;', ['theme'], [THEME]),
    'theme = nextTheme; __wizzQueueUpdate({ theme: true }); __wizzPersistWrite("theme", theme);'
  );
});

test('inserts persist writes on statements without semicolons too', () => {
  assert.equal(
    interceptAssignments('function toggle() { theme = theme === "light" ? "dark" : "light" }', ['theme'], [THEME]),
    'function toggle() { theme = theme === "light" ? "dark" : "light"; __wizzQueueUpdate({ theme: true }); __wizzPersistWrite("theme", theme); }'
  );
});

test('persistent vars still emit persist writes for compound and update operators', () => {
  const output = interceptAssignments('volume += 2;\nstep++;\n++step;', ['volume', 'step'], [
    { name: 'volume', storageKey: 'vol' },
    { name: 'step', storageKey: 'step' }
  ]);

  assert.equal(
    output,
    [
      'volume += 2; __wizzQueueUpdate({ volume: true }); __wizzPersistWrite("vol", volume);',
      '\nstep++; __wizzQueueUpdate({ step: true }); __wizzPersistWrite("step", step);',
      '\n++step; __wizzQueueUpdate({ step: true }); __wizzPersistWrite("step", step);'
    ].join('')
  );
});

test('writes persist keys through chains rooted at a persistent var', () => {
  assert.equal(
    interceptAssignments('settings.items[0] = "x";', ['settings'], [{ name: 'settings', storageKey: 'settings' }]),
    'settings.items[0] = "x"; __wizzQueueUpdate({ settings: true }); __wizzPersistWrite("settings", settings);'
  );
});

test('non-persistent reactive vars are intercepted without persist writes', () => {
  const output = interceptAssignments('clicks = 1;\ntheme = "dark";', ['clicks', 'theme'], [THEME]);

  assert.equal(
    output,
    'clicks = 1; __wizzQueueUpdate({ clicks: true });\ntheme = "dark"; __wizzQueueUpdate({ theme: true }); __wizzPersistWrite("theme", theme);'
  );
  assert.equal(output.includes('__wizzPersistWrite("theme", clicks)'), false);
});

test('persistent declarations themselves do not emit persist writes', () => {
  const input = 'let theme = "light";\ntheme = "dark";';
  const output = interceptAssignments(input, ['theme'], [THEME]);

  assert.equal(output, 'let theme = "light";\ntheme = "dark"; __wizzQueueUpdate({ theme: true }); __wizzPersistWrite("theme", theme);');
  assert.equal(output.split('__wizzPersistWrite').length - 1, 1);
});

test('persistent interception keeps hazardous scripts valid JavaScript', () => {
  const inputs = [
    'function f() { theme = `a${b}c; }`; }',
    'function f() { theme = /a;[/]b/g; }',
    'function f() { if (ready) { theme = 1 } }',
    'switch (mode) { case 1: theme = 1; break; default: theme = 0 }'
  ];

  for (const input of inputs) {
    const output = interceptAssignments(input, ['theme'], [THEME]);
    assert.doesNotThrow(
      () => new Function('__wizzQueueUpdate', '__wizzPersistWrite', output),
      `Interception broke valid JS:\n  in:  ${input}\n  out: ${output}`
    );
  }
});

test('executed persistent scripts call the write-through with the new value', () => {
  const script = interceptAssignments(
    'let theme = "light";\nfunction toggle() { theme = "dark"; }\ntoggle();',
    ['theme'],
    [THEME]
  );

  const notifications = [];
  const writes = [];
  new Function('__wizzQueueUpdate', '__wizzPersistWrite', script)((changes) => notifications.push(changes), (key, value) => writes.push([key, value]));

  assert.deepEqual(notifications, [{ theme: true }]);
  assert.deepEqual(writes, [['theme', 'dark']]);
});

// ---------------------------------------------------------------------------
// Inline on: handler instrumentation
// ---------------------------------------------------------------------------

// Evaluates an instrumented handler expression with the component's state
// held in `state`, invokes it with `event`, and reports the notifications,
// persistence writes, and resulting state. `with` would be simpler but is
// illegal in strict mode, so names are bound as accessor-backed locals.
function runHandler(handlerSource, initialState, event) {
  const names = Object.keys(initialState);
  const notifications = [];
  const writes = [];
  const body = `let ${names.map((name) => `${name} = __state.${name}`).join(', ')};
    const __handler = (${handlerSource});
    const __result = __handler(__event);
    return { result: __result, state: { ${names.join(', ')} } };`;
  const run = new Function('__wizzQueueUpdate', '__wizzPersistWrite', '__state', '__event', body);
  const outcome = run((changes) => notifications.push(changes), (key, value) => writes.push([key, value]), initialState, event);
  return { ...outcome, notifications, writes };
}

const REACTIVE = ['name', 'count', 'items'];

test('instruments expression-bodied arrow handlers into block bodies', () => {
  assert.equal(
    interceptHandlerExpression('(e) => name = e.target.value', REACTIVE),
    '(e) => { name = e.target.value; __wizzQueueUpdate({ name: true }); }'
  );
  const run = runHandler(interceptHandlerExpression('(e) => name = e.target.value', REACTIVE), { name: '' }, { target: { value: 'Ada' } });
  assert.deepEqual(run.notifications, [{ name: true }]);
  assert.equal(run.state.name, 'Ada');
});

test('instruments every assignment and update operator form inside handlers', () => {
  for (const [handler, initial, expected] of [
    ['() => count += 2', { count: 1 }, 3],
    ['() => count++', { count: 1 }, 2],
    ['() => --count', { count: 1 }, 0],
    ['() => count **= 3', { count: 2 }, 8],
    ['() => count ??= 5', { count: null }, 5]
  ]) {
    const run = runHandler(interceptHandlerExpression(handler, REACTIVE), initial);
    assert.deepEqual(run.notifications, [{ count: true }], handler);
    assert.equal(run.state.count, expected, handler);
  }
});

test('instruments single-parameter, async, and multi-line arrow heads', () => {
  assert.match(interceptHandlerExpression('e => count = e', REACTIVE), /^e => \{ count = e; __wizzQueueUpdate\(\{ count: true \}\); \}$/);
  assert.match(interceptHandlerExpression('async (e) => count = 1', REACTIVE), /^async \(e\) => \{ count = 1; __wizzQueueUpdate/);
  assert.match(interceptHandlerExpression('async e => count = 1', REACTIVE), /^async e => \{ count = 1; __wizzQueueUpdate/);
  // `async` used as the parameter name, not the modifier.
  assert.match(interceptHandlerExpression('async => count = async', REACTIVE), /^async => \{ count = async; __wizzQueueUpdate/);
  const multiLine = interceptHandlerExpression('(\n  event\n) =>\n  count = event.detail', REACTIVE);
  assert.deepEqual(runHandler(multiLine, { count: 0 }, { detail: 7 }).state.count, 7);
});

test('instruments block-bodied arrows and function expressions in place', () => {
  assert.equal(
    interceptHandlerExpression('(e) => { name = e.target.value; count += 1; }', REACTIVE),
    '(e) => { name = e.target.value; __wizzQueueUpdate({ name: true }); count += 1; __wizzQueueUpdate({ count: true }); }'
  );
  assert.equal(
    interceptHandlerExpression('function (e) { count = 1; }', REACTIVE),
    'function (e) { count = 1; __wizzQueueUpdate({ count: true }); }'
  );
  assert.equal(
    interceptHandlerExpression('function named(e) { count = 1 }', REACTIVE),
    'function named(e) { count = 1; __wizzQueueUpdate({ count: true }); }'
  );
  // ASI inside a block body.
  const run = runHandler(interceptHandlerExpression('() => {\n  count = 1\n  name = "x"\n}', REACTIVE), { count: 0, name: '' });
  assert.deepEqual(run.notifications, [{ count: true }, { name: true }]);
});

test('instruments property-chain mutations with the root reactive name', () => {
  const run = runHandler(interceptHandlerExpression('() => items.list = [1]', REACTIVE), { items: { list: [] } });
  assert.deepEqual(run.notifications, [{ items: true }]);
  assert.deepEqual(run.state.items.list, [1]);
});

test('writes persistent state through the persistence helper from handlers', () => {
  const source = interceptHandlerExpression('() => count += 1', REACTIVE, [{ name: 'count', storageKey: 'clicks' }]);
  const run = runHandler(source, { count: 1 });
  assert.deepEqual(run.notifications, [{ count: true }]);
  assert.deepEqual(run.writes, [['clicks', 2]]);
});

test('arrow parameters and local declarations shadow reactive names in handlers', () => {
  for (const handler of [
    '(name) => name = 1',
    'name => name = 2',
    '({ name }) => name = 3',
    '(e, count) => count += 1',
    '() => { let count = 0; count = 1; }',
    'function (name) { name = 1; }'
  ]) {
    assert.equal(interceptHandlerExpression(handler, REACTIVE), handler, handler);
  }
  // Shadowing is per-name: an unshadowed sibling is still instrumented.
  assert.equal(
    interceptHandlerExpression('(name) => { name = 1; count = name; }', REACTIVE),
    '(name) => { name = 1; count = name; __wizzQueueUpdate({ count: true }); }'
  );
});

test('leaves handlers without a statement-level reactive mutation byte-identical', () => {
  for (const handler of [
    'increment',
    'handlers.save',
    '(event) => increment(event.detail)',
    '(e) => items.push(e)',
    '() => ({ count: 1 })',
    '() => ok ? count = 1 : 0',
    '() => other = 1',
    '() => "count = 1"',
    '() => `count = ${1}`',
    '() => /count = 1/.test(x)',
    '() => count === 1',
    '() => count == 1'
  ]) {
    assert.equal(interceptHandlerExpression(handler, REACTIVE), handler, handler);
  }
});

test('refuses forms whose meaning would change in statement position', () => {
  for (const handler of [
    // A directive value that is itself an assignment evaluates at mount.
    'count = 5',
    'count += 1',
    // A sequence whose first element is the arrow: wrapping would swallow b.
    '(e) => count = 1, b',
    // Bodies that become declarations as statements.
    '() => function () { count = 1 }',
    '() => class { m() { count = 1 } }',
    // The arrow ends before the value does.
    '(() => count = 1)',
    '() => { count = 1 }, other',
    'function () { count = 1 }, other',
    // Malformed or unbalanced heads.
    '(e => count = 1',
    'if => count = 1',
    ''
  ]) {
    assert.equal(normalizeHandlerExpression(handler), null, handler);
    assert.equal(interceptHandlerExpression(handler, REACTIVE), handler, handler);
  }
  assert.equal(normalizeHandlerExpression(undefined), null);
  assert.equal(normalizeHandlerExpression(null), null);
});

test('tracks brackets, strings, and template interpolations when finding the body end', () => {
  // Commas and braces nested inside the body do not end it.
  const nested = interceptHandlerExpression('(e) => items = [...items, { id: e, label: `${e, "}"}` }]', REACTIVE);
  assert.match(nested, /^\(e\) => \{ items = \[\.\.\.items, \{ id: e, label: `\$\{e, "\}"\}` \}\]; __wizzQueueUpdate\(\{ items: true \}\); \}$/);
  assert.deepEqual(runHandler(nested, { items: [] }, 1).state.items, [{ id: 1, label: '}' }]);
  assert.equal(
    interceptHandlerExpression("() => name = '}'", REACTIVE),
    "() => { name = '}'; __wizzQueueUpdate({ name: true }); }"
  );
  // Inner arrows in the body are expressions, not the handler.
  const inner = interceptHandlerExpression('() => items = items.map((x) => x + 1)', REACTIVE);
  assert.deepEqual(runHandler(inner, { items: [1] }).state.items, [2]);
});

test('closes the block on a new line after a trailing line comment', () => {
  const source = interceptHandlerExpression('() => count = 1 // bump', REACTIVE);
  assert.equal(source, '() => { count = 1; __wizzQueueUpdate({ count: true }); // bump\n}');
  assert.deepEqual(runHandler(source, { count: 0 }).notifications, [{ count: true }]);
  assert.equal(
    interceptHandlerExpression('() => count = 1 /* bump */', REACTIVE),
    '() => { count = 1; __wizzQueueUpdate({ count: true }); /* bump */ }'
  );
});

test('every instrumented handler is a valid expression that returns undefined', () => {
  for (const handler of [
    '(e) => name = e',
    'async (e) => count = await e',
    '() => count = 1 // c',
    '(e) => { count = e; }',
    'function (e) { count = e; }'
  ]) {
    const source = interceptHandlerExpression(handler, REACTIVE);
    assert.notEqual(source, handler, handler);
    assert.doesNotThrow(() => new Function('__wizzQueueUpdate', `return (${source});`), source);
  }
  // Listener return values are ignored by addEventListener, so dropping the
  // expression body's value is unobservable; pin that it is dropped.
  assert.equal(runHandler(interceptHandlerExpression('() => count = 4', REACTIVE), { count: 0 }).result, undefined);
});

test('handler instrumentation ignores prototype-named identifiers', () => {
  // Reactive names are looked up in a Set, never on an object, so
  // `__proto__`/`constructor` in handler source cannot hit inherited keys.
  for (const handler of ['() => __proto__ = 1', '() => constructor = 1', '() => toString = 1']) {
    assert.equal(interceptHandlerExpression(handler, REACTIVE), handler, handler);
  }
});

test('findHandlerMutations reports handler mutations of the given names only', () => {
  assert.deepEqual(findHandlerMutations('(e) => title = e', ['title']).map((mutation) => mutation.name), ['title']);
  assert.deepEqual(findHandlerMutations('() => { title.text = 1; }', ['title']).map((mutation) => mutation.name), ['title']);
  assert.deepEqual(findHandlerMutations('(title) => title = 1', ['title']), []);
  assert.deepEqual(findHandlerMutations('select', ['title']), []);
  assert.deepEqual(findHandlerMutations('() => title === 1', ['title']), []);
});

// --- Issue #73: parenthesized assignment bodies ---

test('instruments arrows whose whole body is a parenthesized assignment', () => {
  const handler = interceptHandlerExpression('(e) => (name = e.target.value)', REACTIVE);
  assert.equal(handler, '(e) => { name = e.target.value; __wizzQueueUpdate({ name: true }); }');
  const run = runHandler(handler, { name: '' }, { target: { value: 'Ada' } });
  assert.equal(run.state.name, 'Ada');
  assert.deepEqual(run.notifications, [{ name: true }]);
  // Any number of wrapping pairs, async arrows, and bare parameters.
  assert.equal(interceptHandlerExpression('e => ((count = e))', REACTIVE), 'e => { count = e; __wizzQueueUpdate({ count: true }); }');
  assert.equal(interceptHandlerExpression('async (e) => (count += 1)', REACTIVE), 'async (e) => { count += 1; __wizzQueueUpdate({ count: true }); }');
  // Trailing comments, inside or after the parentheses, cannot swallow the
  // closing brace.
  assert.equal(interceptHandlerExpression('() => (count = 1) // c', REACTIVE), '() => { count = 1; __wizzQueueUpdate({ count: true }); // c\n}');
  assert.equal(interceptHandlerExpression('() => (count = 1 // c\n)', REACTIVE), '() => { count = 1; __wizzQueueUpdate({ count: true }); // c\n }');
});

test('leaves parenthesized bodies alone when unwrapping would change their meaning', () => {
  for (const handler of [
    // An object literal would become a block (or a label) as a statement.
    '() => ({ count: 1 })',
    '() => (({ count: 1 }))',
    // A declaration as a statement.
    '() => (class {})',
    // The parentheses do not span the whole body.
    '() => (count) + (name = 1)',
    '() => (count = 1), name',
    // Empty parentheses are not a body.
    '() => ()'
  ]) {
    assert.equal(interceptHandlerExpression(handler, REACTIVE), handler, handler);
  }
});

test('prop mutations in parenthesized bodies are found like any other', () => {
  assert.deepEqual(findHandlerMutations('(e) => (name = e.target.value)', ['name']).map((m) => m.name), ['name']);
});

// --- Issue #73: untracked mutations ---

const STATE = ['count', 'items', 'user', 'a', 'b'];
const untracked = (source) => findUntrackedMutations(source, STATE).map(({ name, line, column }) => `${name}@${line}:${column}`);

test('reports mutations the rewriter leaves in expression position', () => {
  assert.deepEqual(untracked('function f() { g(count = 1); }'), ['count@1:18']);
  assert.deepEqual(untracked('if (count = 1) {}'), ['count@1:5']);
  assert.deepEqual(untracked('const v = (count += 1);'), ['count@1:12']);
  assert.deepEqual(untracked('items.forEach((i) => count += i);'), ['count@1:22']);
  assert.deepEqual(untracked('const o = { a: count = 1 };'), ['count@1:16']);
  assert.deepEqual(untracked('const t = `${count = 1}`;'), ['count@1:14']);
  assert.deepEqual(untracked('g(user.name = "x");'), ['user@1:3']);
  assert.deepEqual(untracked('g(++count);\ng(count++);'), ['count@1:3', 'count@2:3']);
  assert.deepEqual(untracked('for (count = 0; count < 3; count++) {}'), ['count@1:6', 'count@1:28']);
});

test('reports unbraced control-flow bodies and chained targets', () => {
  assert.deepEqual(untracked('if (x) count = 1;'), ['count@1:8']);
  assert.deepEqual(untracked('if (x) {} else count = 1;'), ['count@1:16']);
  assert.deepEqual(untracked('while (x) count++;'), ['count@1:11']);
  assert.deepEqual(untracked('a = b = 1;'), ['b@1:5']);
});

test('does not report what is rewritten, declared, shadowed, or not component state', () => {
  for (const source of [
    // Statement-level mutations are rewritten.
    'count = 1;', 'onMount(() => { count = 1; });', 'function f() {\n  user.name = "x";\n  count++;\n}',
    // Declarations and their destructuring defaults.
    'let count = 0;', 'const { count = 1 } = obj;', 'let x = 1, items = [];', 'export let count;',
    // Parameters and their defaults shadow.
    'const f = (count = 1) => count;', 'function g(count = 1) { count = 2; }', 'items.forEach(count => count += 1);',
    'try {} catch (count) { g(count = 1); }', 'function h() { let count = 0; g(count = 1); }',
    // Class fields, other objects' properties, comparisons, strings.
    'class A { count = 1; m() { count = 2; } }', 'obj.count = 1;', 'g(obj.count = 1);', 'x = count === 1;',
    'g("count = 1");', 'g(/count = 1/);', '// count = 1\ng();'
  ]) {
    assert.deepEqual(untracked(source), [], source);
  }
});

test('expression-arrow parameter shadowing ends with the arrow', () => {
  // The parameter shadows inside the arrow; the same name after the call is
  // component state again.
  assert.deepEqual(untracked('g(count => count = 1, count = 2);'), ['count@1:23']);
  assert.deepEqual(untracked('g((count) => count++);\ng(count++);'), ['count@2:3']);
});

test('untracked analysis never changes what is rewritten', () => {
  const script = 'function f() { count = 1; g(count = 2); if (x) count = 3; items.push(1); }';
  assert.equal(
    interceptAssignments(script, ['count', 'items']),
    'function f() { count = 1; __wizzQueueUpdate({ count: true }); g(count = 2); if (x) count = 3; items.push(1); }'
  );
  findUntrackedMutations(script, ['count', 'items']);
  assert.equal(interceptAssignments(script, ['count', 'items']).includes('g(count = 2)'), true);
});

test('handler analysis scans the instrumented form, or the raw value when it is not a function', () => {
  const handler = (source) => findUntrackedHandlerMutations(source, STATE).map(({ name }) => name);
  assert.deepEqual(handler('(e) => (count = e)'), []);
  assert.deepEqual(handler('(e) => { count = e; }'), []);
  assert.deepEqual(handler('increment'), []);
  assert.deepEqual(handler('() => g(count = 1)'), ['count']);
  assert.deepEqual(handler('() => count = 1, b'), ['count']);
  // A value that is not a function literal runs once, at mount, untracked.
  assert.deepEqual(handler('count = 1'), ['count']);
  assert.deepEqual(handler(undefined), []);
  assert.deepEqual(findUntrackedMutations('', STATE), []);
  assert.deepEqual(findUntrackedMutations('count = 1', []), []);
});

// --- Review follow-ups (issue #73) ---

// The emitted handler must parse as an expression, exactly where the
// generator places it (an addEventListener argument).
const parsesAsHandler = (source) => {
  // eslint-disable-next-line no-new-func -- test oracle only, never generated code.
  new Function('__wizzQueueUpdate', 'count', `'use strict'; return (${source});`);
  return true;
};

test('async function bodies are statement hazards, parenthesized or not', () => {
  for (const handler of [
    '() => (async function () { count = 1 })',
    '() => async function () { count = 1 }',
    '() => ((async function named() { count = 1 }))',
    '() => async function named() { count = 1 }'
  ]) {
    const output = interceptHandlerExpression(handler, REACTIVE);
    assert.ok(parsesAsHandler(output), output);
    assert.doesNotMatch(output, /^\(\) => \{ async function/, handler);
  }
  // async arrows and a name called async still unwrap and instrument.
  assert.equal(interceptHandlerExpression('() => (count = async)', REACTIVE), '() => { count = async; __wizzQueueUpdate({ count: true }); }');
  const asyncArrow = interceptHandlerExpression('() => (async () => { count = 1 })', REACTIVE);
  assert.ok(parsesAsHandler(asyncArrow), asyncArrow);
});

test('a for-header let shadows its own header and its body', () => {
  assert.deepEqual(untracked('for (let count = 0; count < 10; count++) {}'), []);
  assert.deepEqual(untracked('for (let count = 0; count < 10; count += 1) {}'), []);
  assert.deepEqual(untracked('for (let i = 0, count = 0; i < 3; i++, count++) { g(count = 1); }'), []);
  // Without a declaration the header assigns component state, as before.
  assert.deepEqual(untracked('for (count = 0; count < 10; count++) {}'), ['count@1:6', 'count@1:29']);
  // The braced body is shadowed for the rewrite too: the loop's own let is
  // never instrumented as component state.
  assert.equal(
    interceptAssignments('for (let count = 0; count < 3; count++) { count = 5; }', ['count']),
    'for (let count = 0; count < 3; count++) { count = 5; }'
  );
});

test('a for-header let over an unbraced body shadows that statement only', () => {
  // The body statement is the loop's own variable.
  assert.deepEqual(untracked('for (let count = 0; count < 3; count++) g(count++);'), []);
  // The body may start on the next line; the statement after it is state again.
  assert.deepEqual(untracked('for (let count = 0; count < 3; count++)\n  g(count++);\ng(count = 1);'), ['count@3:3']);
  // Without a semicolon, the declaration must not leak into the next block.
  const script = 'for (let count = 0; count < 3; count++) g(count)\nfunction f() { count = 1; g(count = 2); }';
  assert.deepEqual(untracked(script), ['count@2:29']);
  assert.equal(
    interceptAssignments(script, ['count']),
    'for (let count = 0; count < 3; count++) g(count)\nfunction f() { count = 1; __wizzQueueUpdate({ count: true }); g(count = 2); }'
  );
});

test('expression-arrow shadowing ends at a new statement without semicolons', () => {
  const script = 'let count = 0\nconst inc = count => count + 1\nfunction bad(ready) {\n  if (ready) count = 2\n}';
  assert.deepEqual(untracked(script), ['count@4:14']);
  // A continuation line keeps the arrow's expression (and its shadowing).
  assert.deepEqual(untracked('const f = count => count\n  .toString(count = 1)'), []);
});

test('expression-arrow shadowing ends at a ternary colon it did not open', () => {
  assert.deepEqual(untracked('const x = ok ? count => count + 1 : (count = 2);'), ['count@1:38']);
  // A ternary inside the arrow body keeps the parameter shadowed through
  // its own colon.
  assert.deepEqual(untracked('const f = count => ok ? (count = 1) : (count = 2);'), []);
  assert.deepEqual(untracked('const y = a ? count => ok ? 1 : (count = 2) : (count = 3);'), ['count@1:48']);
});

test('defaults in generator, computed, and reserved-word method parameters are not mutations', () => {
  for (const source of [
    'const g = function* (count = 1) { yield count; };',
    'const g = async function* (count = 1) { yield count; };',
    'const o = { *gen(count = 1) { yield count; } };',
    'const o = { [k](count = 1) { return count; } };',
    'const o = { delete(count = 1) { return count; } };',
    'const o = { get(count = 1) {} };',
    'class C { async get(count = 1) {} }',
    'class C { static delete(count = 1) {} [k](count = 2) {} }'
  ]) {
    assert.deepEqual(untracked(source), [], source);
  }
  // Control-flow headers still assign.
  assert.deepEqual(untracked('if (count = 1) {}'), ['count@1:5']);
  assert.deepEqual(untracked('while (count = 1) {}'), ['count@1:8']);
  assert.deepEqual(untracked('function f() { if (count = 1) {} }'), ['count@1:20']);
});

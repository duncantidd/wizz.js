// src/compiler/generator/assignmentInterceptor.test.js
const assert = require('node:assert/strict');
const test = require('node:test');
const { interceptAssignments } = require('./assignmentInterceptor');

// Executes an intercepted script the way a component factory would: with a
// queueUpdate dispatcher in scope, and captures the notifications it sends.
function runScript(script, names) {
  const notifications = [];
  const execute = new Function('queueUpdate', script);
  execute((changes) => notifications.push(changes));
  return notifications;
}

function assertValidJs(script) {
  assert.doesNotThrow(() => new Function('queueUpdate', script), `Generated invalid JS: ${script}`);
}

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
    'onMount(() => { count = 1; queueUpdate({ count: true }); });'
  );
  assert.equal(
    interceptAssignments('setTimeout(() => { count = 1 }, 100);', ['count']),
    'setTimeout(() => { count = 1; queueUpdate({ count: true }); }, 100);'
  );
  assert.equal(
    interceptAssignments('button.addEventListener("click", () => { total += 1 });', ['total']),
    'button.addEventListener("click", () => { total += 1; queueUpdate({ total: true }); });'
  );
});

test('intercepts mutations in async arrows and handlers with parameters', () => {
  assert.equal(
    interceptAssignments('saveButton.onclick = async () => { status = "saved"; };', ['status']),
    'saveButton.onclick = async () => { status = "saved"; queueUpdate({ status: true }); };'
  );
  assert.equal(
    interceptAssignments('input.addEventListener("input", (event) => { name = event.target.value; });', ['name']),
    'input.addEventListener("input", (event) => { name = event.target.value; queueUpdate({ name: true }); });'
  );
});

test('intercepts mutations in object method shorthand, getters, and setters', () => {
  assert.equal(
    interceptAssignments('const api = { bump() { count += 1; } };', ['count']),
    'const api = { bump() { count += 1; queueUpdate({ count: true }); } };'
  );
  assert.equal(
    interceptAssignments('const box = { get label() { return label; }, set label(value) { label = value; } };', ['label']),
    'const box = { get label() { return label; }, set label(value) { label = value; queueUpdate({ label: true }); } };'
  );
});

test('intercepts mutations in class methods but not class field initializers', () => {
  assert.equal(
    interceptAssignments('class Counter { increment() { count += 1; } }', ['count']),
    'class Counter { increment() { count += 1; queueUpdate({ count: true }); } }'
  );
  // A class field named like a reactive variable defines an instance property;
  // rewriting inside the class body would be a syntax error.
  assert.equal(interceptAssignments('class Counter { count = 1; }', ['count']), 'class Counter { count = 1; }');
  assert.equal(
    interceptAssignments('class Counter { handler = () => { count = 1; }; }', ['count']),
    'class Counter { handler = () => { count = 1; queueUpdate({ count: true }); }; }'
  );
});

test('intercepts mutations in async functions, generators, and IIFEs', () => {
  assert.equal(
    interceptAssignments('async function load() { count = await fetchCount(); }', ['count']),
    'async function load() { count = await fetchCount(); queueUpdate({ count: true }); }'
  );
  assert.equal(
    interceptAssignments('function* sequence() { step = yield nextStep(); }', ['step']),
    'function* sequence() { step = yield nextStep(); queueUpdate({ step: true }); }'
  );
  assert.equal(
    interceptAssignments('(function () { count = 1; })();', ['count']),
    '(function () { count = 1; queueUpdate({ count: true }); })();'
  );
});

test('intercepts mutations in switch cases, do-while bodies, and try blocks', () => {
  assert.equal(
    interceptAssignments('switch (mode) { case "fast": count = 1; break; default: count = 2; }', ['count']),
    'switch (mode) { case "fast": count = 1; queueUpdate({ count: true }); break; default: count = 2; queueUpdate({ count: true }); }'
  );
  assert.equal(
    interceptAssignments('do { count = 1; } while (ready);', ['count']),
    'do { count = 1; queueUpdate({ count: true }); } while (ready);'
  );
  assert.equal(
    interceptAssignments('try { count = 1; } catch (error) { count = 2; } finally { count = 3; }', ['count']),
    [
      'try { count = 1; queueUpdate({ count: true }); }',
      ' catch (error) { count = 2; queueUpdate({ count: true }); }',
      ' finally { count = 3; queueUpdate({ count: true }); }'
    ].join('')
  );
});

test('intercepts mutations in for-of bodies and nested functions', () => {
  assert.equal(
    interceptAssignments('for (const item of items) { total += 1; }', ['total']),
    'for (const item of items) { total += 1; queueUpdate({ total: true }); }'
  );
  assert.equal(
    interceptAssignments('function outer() { function inner() { count = 1; } }', ['count']),
    'function outer() { function inner() { count = 1; queueUpdate({ count: true }); } }'
  );
});

test('intercepts statements that omit semicolons before a closing brace', () => {
  assert.equal(
    interceptAssignments('function increment() { count += 1 }', ['count']),
    'function increment() { count += 1; queueUpdate({ count: true }); }'
  );
  assert.equal(
    interceptAssignments('if (ready) { count = 1 }', ['count']),
    'if (ready) { count = 1; queueUpdate({ count: true }); }'
  );
});

test('intercepts both statements when a semicolon-less mutation ends a line', () => {
  assert.equal(
    interceptAssignments('count = 1\ntotal = 2;', ['count', 'total']),
    'count = 1; queueUpdate({ count: true });\ntotal = 2; queueUpdate({ total: true });'
  );
});

test('treats a newline before a prefix update as a new statement', () => {
  assert.equal(
    interceptAssignments('count\n++total;', ['count', 'total']),
    'count\n++total; queueUpdate({ total: true });'
  );
  assert.equal(
    interceptAssignments('count++\n--total;', ['count', 'total']),
    'count++; queueUpdate({ count: true });\n--total; queueUpdate({ total: true });'
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
    'items.forEach((item, index) => { total += item; queueUpdate({ total: true }); });'
  );
});

test('shadowing ends when the parameter-bearing body closes', () => {
  const input = 'items.map(count => { count = 1; });\ncount = 2;';
  const expected = 'items.map(count => { count = 1; });\ncount = 2; queueUpdate({ count: true });';

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
    'const load = () => { if (ready) { count = 1; queueUpdate({ count: true }); } };'
  );
});

test('does not mistake division followed by a regex for one merged statement', () => {
  // The previous scanner consumed division as an unterminated regex and
  // merged these three statements, placing the notification after the regex.
  const input = 'average = total / count;\nconst re = /count = 5/;\ndone = 1;';
  const expected = [
    'average = total / count; queueUpdate({ average: true });',
    '\nconst re = /count = 5/;\n',
    'done = 1; queueUpdate({ done: true });'
  ].join('');

  assert.equal(interceptAssignments(input, ['average', 'done']), expected);
});

test('does not mistake a chained division for a regex literal', () => {
  const input = 'scaled = value++ / 2 / divisor;\ndone = 1;';
  const expected = 'scaled = value++ / 2 / divisor; queueUpdate({ scaled: true });\ndone = 1; queueUpdate({ done: true });';

  assert.equal(interceptAssignments(input, ['scaled', 'done']), expected);
});

test('rewrites statements whose values contain regex character classes', () => {
  const input = 'pattern = /a[/]b/gi.exec(text);';
  const expected = 'pattern = /a[/]b/gi.exec(text); queueUpdate({ pattern: true });';

  assert.equal(interceptAssignments(input, ['pattern']), expected);
});

test('rewrites statements containing regex literals after typeof and case', () => {
  assert.equal(
    interceptAssignments('kind = typeof /x = 1/.source;', ['kind']),
    'kind = typeof /x = 1/.source; queueUpdate({ kind: true });'
  );
  assert.equal(
    interceptAssignments('switch (probe) { case /y = 2/.test(s): flag = true; }', ['flag']),
    'switch (probe) { case /y = 2/.test(s): flag = true; queueUpdate({ flag: true }); }'
  );
});

test('preserves template literals with interpolations and rewrites the surrounding statement', () => {
  const input = 'greeting = `Hello ${user.name}, you have ${unread} messages`;';
  const expected = 'greeting = `Hello ${user.name}, you have ${unread} messages`; queueUpdate({ greeting: true });';

  assert.equal(interceptAssignments(input, ['greeting']), expected);
});

test('leaves assignments inside template interpolations untransformed but rewrites the outer statement', () => {
  const input = 'label = `value: ${count = 1}`;';
  const expected = 'label = `value: ${count = 1}`; queueUpdate({ label: true });';

  assert.equal(interceptAssignments(input, ['label', 'count']), expected);
});

test('handles nested template literals inside interpolations', () => {
  const input = 'markup = `<div>${ items.map(item => `<b>${item}</b>`) }</div>`;\ndone = 1;';
  const expected = [
    'markup = `<div>${ items.map(item => `<b>${item}</b>`) }</div>`; queueUpdate({ markup: true });',
    '\ndone = 1; queueUpdate({ done: true });'
  ].join('');

  assert.equal(interceptAssignments(input, ['markup', 'done']), expected);
});

test('preserves escaped backticks and dollar signs while scanning templates', () => {
  const input = 'text = `a\\`b\\${c}d`;\ndone = 1;';
  const expected = 'text = `a\\`b\\${c}d`; queueUpdate({ text: true });\ndone = 1; queueUpdate({ done: true });';

  assert.equal(interceptAssignments(input, ['text', 'done']), expected);
});

test('rewrites assignments whose values are or contain templates', () => {
  assert.equal(
    interceptAssignments('label = `x`;', ['label']),
    'label = `x`; queueUpdate({ label: true });'
  );
  assert.equal(
    interceptAssignments('page = `${section}-${index}`;', ['page']),
    'page = `${section}-${index}`; queueUpdate({ page: true });'
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
  const expected = 'count = total = 1; queueUpdate({ count: true });';

  assert.equal(interceptAssignments(input, ['count', 'total']), expected);
});

test('rewrites a sequence expression after its terminating semicolon', () => {
  const input = 'count = 1, other = 2;';
  const expected = 'count = 1, other = 2; queueUpdate({ count: true });';

  assert.equal(interceptAssignments(input, ['count']), expected);
});

test('rewrites statements with ternary and compound values', () => {
  assert.equal(
    interceptAssignments('count = ready ? 1 : 2;', ['count']),
    'count = ready ? 1 : 2; queueUpdate({ count: true });'
  );
  assert.equal(
    interceptAssignments('items = ready ? [1, 2] : { a: 1 };', ['items']),
    'items = ready ? [1, 2] : { a: 1 }; queueUpdate({ items: true });'
  );
  assert.equal(
    interceptAssignments('count = cond ? x : y, z;', ['count']),
    'count = cond ? x : y, z; queueUpdate({ count: true });'
  );
});

test('rewrites assignments spanning multiple lines', () => {
  const input = 'count =\n  a +\n  b;';
  const expected = 'count =\n  a +\n  b; queueUpdate({ count: true });';

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
    'items[0] = "x"; queueUpdate({ items: true });'
  );
  assert.equal(
    interceptAssignments('user["name"] = "Ada";', ['user']),
    'user["name"] = "Ada"; queueUpdate({ user: true });'
  );
  assert.equal(
    interceptAssignments('user.tags[0].label = "x";', ['user']),
    'user.tags[0].label = "x"; queueUpdate({ user: true });'
  );
  assert.equal(
    interceptAssignments('user.age++;', ['user']),
    'user.age++; queueUpdate({ user: true });'
  );
});

test('rewrites chains split across comments and newlines', () => {
  assert.equal(
    interceptAssignments('user /* which */ . name = "Ada";', ['user']),
    'user /* which */ . name = "Ada"; queueUpdate({ user: true });'
  );
  assert.equal(
    interceptAssignments('user\n  .name = "Ada";', ['user']),
    'user\n  .name = "Ada"; queueUpdate({ user: true });'
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
    'count = 2; queueUpdate({ count: true }); // trailing comment'
  ].join('\n');

  assert.equal(interceptAssignments(input, ['count']), expected);
});

test('rewrites a mutation preceded by a block comment', () => {
  const input = '/* setup */ count = 1;';
  const expected = '/* setup */ count = 1; queueUpdate({ count: true });';

  assert.equal(interceptAssignments(input, ['count']), expected);
});

test('rewrites compound operators across the full assignment family', () => {
  const operators = ['=', '+=', '-=', '*=', '/=', '%=', '**=', '&&=', '||=', '??=', '&=', '|=', '^=', '<<=', '>>=', '>>>='];
  for (const operator of operators) {
    const input = `count ${operator} 1;`;
    const expected = `count ${operator} 1; queueUpdate({ count: true });`;
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
    '_private = 1; queueUpdate({ _private: true });'
  );
  assert.equal(
    interceptAssignments('$total += 1;', ['$total']),
    '$total += 1; queueUpdate({ $total: true });'
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
  new Function('queueUpdate', script)((changes) => notifications.push(changes));
  assert.deepEqual(notifications, [{ count: true }]);
});

test('intercepted arrow callbacks notify when executed after mounting', () => {
  const script = interceptAssignments('function register() { setTimeout(() => { count = 1 }, 0); }', ['count']);
  assertValidJs(script);

  const notifications = [];
  const run = new Function('queueUpdate', `${script}\nregister();`);
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
      () => new Function('queueUpdate', output),
      `Interception broke valid JS:\n  in:  ${input}\n  out: ${output}`
    );
  }
});

test('notification text matches the generated component dispatcher contract', () => {
  assert.equal(
    interceptAssignments('count = 1;', ['count']),
    'count = 1; queueUpdate({ count: true });'
  );
});

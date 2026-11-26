const assert = require('node:assert/strict');
const test = require('node:test');
const { parseComponent } = require('../parser');
const { collectUntrackedWarnings } = require('./untrackedWarnings');

// Issue #73: a reactive name assigned where the update scheduler never hears
// about it is a WIZZ-G026 warning, located in the component file.

const warn = (source, filePath = 'src/A.wizz') => collectUntrackedWarnings(parseComponent(source), filePath);

test('script warnings are located in the component, imports and props included', () => {
  const source = '<main>{count}</main>\n<script>\nimport Card from "./Card.wizz";\nexport let title = "t";\nlet count = 0;\nfunction bump() { g(count += 1); }\n</script>';
  const [warning, ...rest] = warn(source);
  assert.deepEqual(rest, []);
  assert.deepEqual(
    { ...warning, message: undefined },
    { code: 'WIZZ-G026', severity: 'warning', message: undefined, file: 'src/A.wizz', line: 6, column: 21 }
  );
  assert.match(warning.message, /^'count' is assigned where the update scheduler does not see it, so the DOM will not update at src\/A\.wizz:6:21\. Make the assignment a statement of its own/);
});

test('a script on the first line keeps its column offset', () => {
  const [warning] = warn('<script>let count = 0; const v = (count = 1);</script><p>{count}</p>');
  assert.equal(warning.line, 1);
  assert.equal(warning.column, 35);
});

test('handler warnings name the directive and element, in template order', () => {
  const source = "<script>let count = 0; let open = false;</script>"
    + '<main><button on:click={() => g(count = 1)}>a</button>'
    + '{#if open}<i on:click={count = 2}>b</i>{:else}<b on:click={() => g(open = true)}>c</b>{/if}</main>';
  const warnings = warn(source);
  assert.deepEqual(warnings.map((warning) => warning.message.split(' where ')[0]), [
    "'count' is assigned in the 'on:click' handler on <button>",
    "'count' is assigned in the 'on:click' handler on <i>",
    "'open' is assigned in the 'on:click' handler on <b>"
  ]);
  // Each points at its element's opening tag.
  assert.ok(warnings.every((warning) => warning.line === 1));
  const columns = warnings.map((warning) => warning.column);
  assert.deepEqual(columns, [...columns].sort((x, y) => x - y));
  assert.equal(source[columns[0] - 1], '<');
  assert.equal(source.slice(columns[1] - 1, columns[1] + 1), '<i');
});

test('an each item variable shadows a same-named let inside its body', () => {
  const source = "<script>let item = 0; let items = [];</script>"
    + '<ul>{#each items as item}<li on:click={() => g(item = 1)}>x</li>{/each}</ul><p on:click={() => g(item = 2)}>y</p>';
  const warnings = warn(source);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /on <p>/);
});

test('bindings, rewritten handlers, and clean components produce no warnings', () => {
  assert.deepEqual(warn("<script>let name = ''; let n = 0;</script><main><input bind:value={name} /><button on:click={() => n++}>+</button><button on:click={(e) => (name = e.type)}>x</button></main>"), []);
  assert.deepEqual(warn('<main>static</main>'), []);
  assert.deepEqual(warn('<script>const fixed = 1; function f() { g(fixed); }</script><p>{fixed}</p>'), []);
});

test('records without a file path carry a bare location', () => {
  const [warning] = collectUntrackedWarnings(parseComponent('<script>let count = 0; g(count = 1);</script><p>{count}</p>'));
  assert.equal(warning.file, null);
  assert.match(warning.message, / at 1:\d+\. /);
});

// --- Milestone 26: WIZZ-G027, in-place array changes with no update ---

const codes = (warnings) => warnings.map((warning) => `${warning.code}@${warning.line}:${warning.column}`);

test('G027 records are located at the call in the component file', () => {
  const source = '<ul>{#each items as item}<li>{item}</li>{/each}</ul>\n<script>\nimport Row from "./Row.wizz";\nexport let title = "t";\nlet items = [];\nfunction add(x) {\n  items.push(x);\n}\n</script>';
  const [warning, ...rest] = warn(source);
  assert.deepEqual(rest, []);
  assert.deepEqual(
    { ...warning, message: undefined },
    { code: 'WIZZ-G027', severity: 'warning', message: undefined, file: 'src/A.wizz', line: 7, column: 3 }
  );
  assert.equal(warning.message, "'items' is changed in place by .push() and never reassigned afterwards, so the DOM will not update at src/A.wizz:7:3. Reassign it after the call (`items.push(x); items = items;`) or assign a new array instead (`items = [...items, x]`); assignment is what schedules the update.");
});

test('G027 hints name both fixes for every method', () => {
  const expected = {
    push: ['items.push(x); items = items;', 'items = [...items, x]'],
    unshift: ['items.unshift(x); items = items;', 'items = [x, ...items]'],
    pop: ['items.pop(); items = items;', 'items = items.slice(0, -1)'],
    shift: ['items.shift(); items = items;', 'items = items.slice(1)'],
    splice: ['items.splice(…); items = items;', 'items = items.toSpliced(…)'],
    sort: ['items.sort(…); items = items;', 'items = items.toSorted(…)'],
    reverse: ['items.reverse(); items = items;', 'items = items.toReversed()'],
    fill: ['items.fill(…); items = items;', 'items = [...items].fill(…)'],
    copyWithin: ['items.copyWithin(…); items = items;', 'items = [...items].copyWithin(…)']
  };
  for (const [method, [reassign, copy]] of Object.entries(expected)) {
    const [warning] = warn(`<script>let items = []; function f() { items.${method}(0); }</script><p>{items}</p>`);
    assert.equal(warning.code, 'WIZZ-G027', method);
    assert.ok(warning.message.includes(`.${method}()`), method);
    assert.ok(warning.message.includes(`\`${reassign}\``), `${method}: ${warning.message}`);
    assert.ok(warning.message.includes(`\`${copy}\``), `${method}: ${warning.message}`);
  }
});

test('a script on the first line keeps its column offset for G027', () => {
  const source = '<script>let items = []; function f() { items.sort(); }</script><p>{items}</p>';
  const [warning] = warn(source);
  assert.equal(warning.line, 1);
  assert.equal(warning.column, 40);
  assert.equal(source.slice(warning.column - 1, warning.column + 9), 'items.sort');
});

test('G026 and G027 script findings are merged in source order', () => {
  const source = '<p>{items}{count}</p>\n<script>\nlet items = [];\nlet count = 0;\n'
    + 'function a() { items.pop(); }\nfunction b() { g(count = 1); }\nfunction c() { items.shift(); }\n</script>';
  assert.deepEqual(codes(warn(source)), ['WIZZ-G027@5:16', 'WIZZ-G026@6:18', 'WIZZ-G027@7:16']);
});

test('G027 does not fire when a reassignment follows, on a shadowing local, on a const, or in expression position', () => {
  const clean = [
    '<script>let items = []; function f() { items.push(1); items = items; }</script><p>{items}</p>',
    '<script>let items = []; function f() { let items = []; items.push(1); }</script><p>{items}</p>',
    '<script>const items = []; function f() { items.push(1); }</script><p>{items}</p>',
    '<script>let items = []; function f() { return items.push(1); }</script><p>{items}</p>',
    '<script>let items = []; function f() { g(items.push(1)); }</script><p>{items}</p>',
    '<script>let items = []; items.push(1);</script><p>{items}</p>'
  ];
  for (const source of clean) assert.deepEqual(warn(source), [], source);
});

test('props are excluded: they are read-only, so reassignment cannot fix them', () => {
  assert.deepEqual(warn('<script>export let rows = []; function f() { rows.push(1); }</script><p>{rows}</p>'), []);
});

test('persistent state is reported like any other reactive let', () => {
  assert.deepEqual(codes(warn('<script>let items = persist("k", []); function f() { items.push(1); }</script><p>{items}</p>')), ['WIZZ-G027@1:54']);
});

test('G027 handler warnings name the directive and element, in template order', () => {
  const source = '<script>let items = []; let open = true;</script>'
    + '<main><button on:click={() => items.push(1)}>a</button>'
    + '{#if open}<i on:click={() => { items.sort(); }}>b</i>{:else}<b on:click={() => { items.push(2); items = items; }}>c</b>{/if}'
    + '<s on:click={(e) => (items.reverse())}>d</s></main>';
  const warnings = warn(source);
  assert.deepEqual(warnings.map((warning) => warning.message.split(' and never')[0]), [
    "'items' is changed in place by .push() in the 'on:click' handler on <button>",
    "'items' is changed in place by .sort() in the 'on:click' handler on <i>",
    "'items' is changed in place by .reverse() in the 'on:click' handler on <s>"
  ]);
  assert.ok(warnings.every((warning) => warning.code === 'WIZZ-G027' && warning.line === 1));
  assert.equal(source.slice(warnings[1].column - 1, warnings[1].column + 1), '<i');
});

test('within one handler G026 precedes G027', () => {
  const warnings = warn('<script>let items = []; let n = 0;</script><p on:click={() => { g(n = 1); items.pop(); }}>x</p>');
  assert.deepEqual(warnings.map((warning) => warning.code), ['WIZZ-G026', 'WIZZ-G027']);
});

test('an each item variable shadows a same-named let for G027 too', () => {
  const source = '<script>let row = []; let rows = [];</script>'
    + '<ul>{#each rows as row}<li on:click={() => row.push(1)}>x</li>{/each}</ul><p on:click={() => row.push(2)}>y</p>';
  const warnings = warn(source);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /on <p>/);
});

test('handler references and non-function values are not scanned for G027', () => {
  assert.deepEqual(warn('<script>let items = []; function add() { items.push(1); items = items; }</script><p on:click={add}>{items}</p>'), []);
});

test('a hostile reactive name cannot reach the hint table through the prototype', () => {
  // Names come from author code; method names come from a fixed set, and the
  // hint table has no prototype, so neither can select an inherited entry.
  const warnings = warn('<script>let __proto__x = []; let constructor = []; function f() { constructor.push(1); }</script><p>{constructor}</p>');
  assert.deepEqual(warnings.map((warning) => warning.code), ['WIZZ-G027']);
  assert.match(warnings[0].message, /`constructor = \[\.\.\.constructor, x\]`/);
});

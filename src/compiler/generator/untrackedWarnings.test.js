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

const assert = require('node:assert/strict');
const test = require('node:test');
const { extractProps, RESERVED_PROP_NAMES } = require('./propExtractor');

test('extracts initialized and bare props in declaration order and removes their statements', () => {
  const { props, script } = extractProps(
    "export let name = 'Guest';\nexport let count;\nlet clicks = 0;\nfunction tick() {}"
  );

  assert.deepEqual(props, [
    { name: 'name', defaultValue: "'Guest'" },
    { name: 'count', defaultValue: null }
  ]);
  // The remaining script keeps author state and functions, without the props.
  assert.equal(script.includes('export'), false);
  assert.equal(script.includes("'Guest'"), false);
  assert.equal(script.includes('let clicks = 0;'), true);
  assert.equal(script.includes('function tick() {}'), true);
});

test('preserves default expressions that hide semicolons and brackets', () => {
  const cases = [
    ['export let s = "a;b";', 's', '"a;b"'],
    ["export let s = 'it\\'s ; here';", 's', "'it\\'s ; here'"],
    ['export let t = `a;${b};c`;', 't', '`a;${b};c`'],
    ['export let re = /x; y/g;', 're', '/x; y/g'],
    ['export let o = { a: 1, b: "};"; };', 'o', '{ a: 1, b: "};"; }'],
    ['export let f = function() { return 1; };', 'f', 'function() { return 1; }'],
    ['export let g = () => a;', 'g', '() => a'],
    ['export let has = "a" in obj;', 'has', '"a" in obj'],
    ['export let n = items.map(x => x * 2);', 'n', 'items.map(x => x * 2)'],
    ['export let c = cond ? 1 : 2;', 'c', 'cond ? 1 : 2'],
    ['export let d = 1 +\n  2;', 'd', '1 +\n  2'],
    ['export let loader = async () => await load();', 'loader', 'async () => await load()']
  ];

  for (const [source, name, expected] of cases) {
    const { props, script } = extractProps(source);
    assert.deepEqual(props.map((prop) => [prop.name, prop.defaultValue]), [[name, expected]], source);
    assert.equal(script.trim(), '', source);
  }
});

test('keeps comments attached to or around prop statements without breaking extents', () => {
  const { props, script } = extractProps(
    '// greeting prop\nexport let greeting = "hi" /* inline ; */; // trailing\nlet x = 1;'
  );

  assert.deepEqual(props, [{ name: 'greeting', defaultValue: '"hi" /* inline ; */' }]);
  assert.equal(script.includes('let x = 1;'), true);
  assert.equal(script.includes('export'), false);
});

test('ignores export-looking text inside strings, templates, comments, and property access', () => {
  const { props, script } = extractProps(
    "const tip = 'export let fake = 1;';\nconst tpl = `export let fake2 = 2;`;\n// export let fake3 = 3;\n/* export let fake4 = 4; */\nconst value = config.export; export let real = 5;"
  );

  assert.deepEqual(props, [{ name: 'real', defaultValue: '5' }]);
  assert.equal(script.includes('const tip'), true);
  assert.equal(script.includes('const tpl'), true);
  assert.equal(script.includes('config.export'), true);
  assert.equal(script.includes('export let real'), false);
});

test('does not treat a backslash escape or regex division as prop syntax', () => {
  const { props } = extractProps('export let quotient = total / count; export let re = /export let x = 1;/;');
  assert.deepEqual(props, [
    { name: 'quotient', defaultValue: 'total / count' },
    { name: 're', defaultValue: '/export let x = 1;/' }
  ]);
});

test('returns the script unchanged when it contains no props', () => {
  const script = 'let count = 0;\nfunction increment() { count += 1; }';
  const { props, script: result } = extractProps(script);

  assert.deepEqual(props, []);
  assert.equal(result, script);
});

test('handles non-string input defensively', () => {
  assert.deepEqual(extractProps(''), { props: [], script: '' });
  assert.deepEqual(extractProps(null), { props: [], script: '' });
  assert.deepEqual(extractProps(undefined), { props: [], script: '' });
});

test('rejects non-let export syntax with guidance', () => {
  const cases = [
    ['export const x = 1;', /Unsupported export syntax.*Only 'export let/],
    ['export var x = 1;', /Unsupported export syntax/],
    ['export default 1;', /Unsupported export syntax/],
    ['export {};', /Unsupported export syntax/],
    ['export;', /Unsupported export syntax/],
    ['export', /found 'export end of script'/]
  ];

  for (const [source, pattern] of cases) {
    assert.throws(() => extractProps(source), pattern, source);
  }
});

test('rejects nested export declarations so props stay component-level', () => {
  assert.throws(
    () => extractProps('function f() { export let x = 1; }'),
    /'export' is only supported at the top level/
  );
  assert.doesNotThrow(() => extractProps('const options = { export: 1 };'));
});

test('rejects multi-declarator prop statements', () => {
  assert.throws(() => extractProps('export let a, b;'), /Declare one prop per 'export let' statement/);
  assert.throws(() => extractProps('export let a = 1, b = 2;'), /Declare one prop per 'export let' statement/);
  assert.throws(
    () => extractProps('export let o = { a: 1 }, b = 2;'),
    /Declare one prop per 'export let' statement/
  );
});

test('rejects prop statements whose extent cannot be bounded confidently', () => {
  // A following statement must never be swallowed into a default expression.
  assert.throws(
    () => extractProps('export let x = 5 let y = 2;'),
    /must end with a semicolon/
  );
  assert.throws(
    () => extractProps('export let x = 5\nlet y = 2;'),
    /must end with a semicolon/
  );
  assert.throws(
    () => extractProps('export let x = count++ total = 1;'),
    /must end with a semicolon/
  );
  assert.throws(
    () => extractProps('export let x = 5'),
    /must end with a semicolon/
  );
});

test('rejects malformed prop declarations', () => {
  assert.throws(() => extractProps('export let x = ;'), /missing a value after '='/i);
  assert.throws(() => extractProps('export let x ='), /missing a value after '='/i);
  assert.throws(() => extractProps('export let = 5;'), /requires a prop name/);
  assert.throws(() => extractProps('export let'), /requires a prop name/);
  assert.throws(() => extractProps('export let x.y = 1;'), /Invalid prop declaration/);
  assert.throws(() => extractProps('export let 5 = 1;'), /requires a prop name/);
  assert.throws(() => extractProps('export'), /Unsupported export syntax/);
});

test('rejects reserved prop names including the generated closure names', () => {
  for (const name of ['props', '__proto__', 'let', 'function', 'eval', 'arguments', 'static', 'yield']) {
    assert.throws(
      () => extractProps(`export let ${name} = 1;`),
      new RegExp(`'${name}' cannot be used as a prop name`),
      name
    );
  }
  for (const name of ['__wizzNext', '__wizzChanges']) {
    assert.throws(
      () => extractProps(`export let ${name} = 1;`),
      new RegExp(`'${name}' uses the reserved '__wizz' framework prefix`),
      name
    );
  }
  assert.doesNotThrow(() => extractProps('export let wizz = 1;'));
});

test('exposes the reserved name table for tests and tooling', () => {
  assert.equal(RESERVED_PROP_NAMES instanceof Set, true);
  assert.equal(RESERVED_PROP_NAMES.has('props'), true);
  assert.equal(RESERVED_PROP_NAMES.has('__proto__'), true);
});

test('extracts multiple props with brackets and strings across lines', () => {
  const { props, script } = extractProps(
    'export let first = "one";\nexport let second = [\n  1,\n  2,\n];\nexport let third;\nconst local = 3;'
  );

  assert.deepEqual(props, [
    { name: 'first', defaultValue: '"one"' },
    { name: 'second', defaultValue: '[\n  1,\n  2,\n]' },
    { name: 'third', defaultValue: null }
  ]);
  assert.equal(script.trim(), 'const local = 3;');
});

test('rejects duplicate prop declarations', () => {
  assert.throws(
    () => extractProps('export let count = 1;\nexport let count = 2;'),
    /Prop 'count' is declared more than once/
  );
});

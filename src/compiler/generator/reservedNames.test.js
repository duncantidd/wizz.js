const assert = require('node:assert/strict');
const test = require('node:test');
const { compile, compileServer } = require('../index.js');
const { topLevelNames, RESERVED_DECLARATIONS, RESERVED_IMPORTS } = require('./reservedNames');

const file = { filePath: 'Names.wizz' };
const template = '<main>x</main>';
const withScript = (script) => `<script>\n${script}\n</script>${template}`;
const assertReserved = (source, pattern) => {
  for (const build of [compile, compileServer]) {
    assert.throws(() => build(source, file), (error) => {
      assert.equal(error.code, 'WIZZ-G025');
      assert.match(error.message, pattern);
      return true;
    });
  }
};

for (const name of RESERVED_DECLARATIONS) {
  test(`rejects a top-level declaration of ${name}`, () => {
    const pattern = new RegExp(`'${name}' would replace`);
    assertReserved(withScript(`let ${name} = 1;`), pattern);
    assertReserved(withScript(`const ${name} = 1;`), pattern);
    assertReserved(withScript(`function ${name}() {}`), pattern);
    assertReserved(withScript(`class ${name} {}`), pattern);
    assertReserved(withScript(`export let ${name} = 1;`), pattern);
  });
}

for (const name of RESERVED_IMPORTS) {
  test(`rejects an import named ${name}`, () => {
    assert.throws(() => compile(withScript(`import ${name} from "./Kid.wizz";`), file), { code: 'WIZZ-G025' });
  });
}

test('rejects destructured and comma-separated top-level names', () => {
  assertReserved(withScript('let { document } = config;'), /'document' would replace/);
  assertReserved(withScript('const [Map] = pair;'), /'Map' would replace/);
  assertReserved(withScript('let first = 1, console = 2;'), /'console' would replace/);
});

test('rejects the __wizz prefix in every build target', () => {
  assert.throws(() => compile(withScript('const __wizzRoot = 1;'), file), { code: 'WIZZ-G025' });
  assert.throws(() => compile(withScript('function __wizzUpdate() {}'), file), { code: 'WIZZ-G025' });
  // Reactive state keeps its existing, earlier server diagnostic.
  assert.throws(() => compileServer(withScript('let __wizzRoot = 1;'), file), { code: 'WIZZ-G017' });
});

test('allows reserved names that stay inside a nested scope', () => {
  for (const script of [
    'const { document: page } = config;',
    'let { title = Map } = config;',
    'const [first = String(1), second = Object] = pair;',
    'let list = [document, Map];',
    'function read() { let document = 1; return document; }',
    'function read() { function String() {} return String; }',
    'function read(document) { return document; }',
    'if (true) { const Map = 1; }',
    'for (const Set of []) { void Set; }',
    'const read = (console) => console;',
    'const config = { document: 1, onMount: 2 };',
    'const text = `${(() => { const Object = 1; return Object; })()}`;',
    '// let document = 1;\n/* const Map = 2; */',
    'const note = "let document = 1;";'
  ]) {
    assert.doesNotThrow(() => compile(withScript(script), file), script);
    assert.doesNotThrow(() => compileServer(withScript(script), file), script);
  }
});

test('calling the script hooks is not a declaration', () => {
  assert.doesNotThrow(() => compile(withScript('onMount(() => {});\nonDestroy(() => {});'), file));
});

test('a component name that only resembles a reserved one is allowed', () => {
  for (const name of ['Documents', 'StringList', 'onMounted', 'documentTitle', 'MapView']) {
    assert.doesNotThrow(() => compile(withScript(`let ${name} = 1;`), file));
  }
});

test('topLevelNames reports each declaration form once', () => {
  assert.deepEqual(
    topLevelNames('let a = 1, b = { c: 1 };\nconst { d, e: [f] } = g;\nfunction h() { let i; }\nclass J {}\nvar k;'),
    ['a', 'b', 'd', 'f', 'h', 'J', 'k']
  );
  assert.deepEqual(topLevelNames(''), []);
  assert.deepEqual(topLevelNames(undefined), []);
});

// Generated code around author code must stay prefixed. A new local with an
// ordinary name would silently reopen issue #65, so this reads real output.
test('generated code declares no unprefixed names around author code', () => {
  const source = `<script>
import Kid from "./Kid.wizz";
export let label = "x";
let count = persist("k", 0);
let rows = [{ id: 1 }];
function inc() { count += 1; }
</script>
<wizz:head><title>{label}</title></wizz:head>
<wizz:style>p { color: red; }</wizz:style>
<main title={label}>{#if count}<p>{count}</p>{:else}<i>x</i>{/if}<Kid text={label} /><ul>{#each rows as row (row.id)}<li>{row.id}</li>{/each}</ul><button on:click={inc}>+</button></main>
`;
  const options = { ...file, componentServerRenderable: { Kid: true } };
  const author = new Set(['label', 'count', 'rows', 'inc', 'row']);
  const builds = {
    client: [compile(source, options).source, 'export default function mountComponent'],
    hydratable: [compile(source, { ...options, hydratable: true }).source, 'export default function mountComponent'],
    server: [compileServer(source, options).source, 'export function renderComponent']
  };

  for (const [name, [output, factoryStart]] of Object.entries(builds)) {
    const factory = output.slice(output.indexOf(factoryStart));
    const code = factory.replace(/\/\/.*$/gm, '').replace(/'(?:[^'\\\n]|\\.)*'/g, "''").replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
    const declared = [...code.matchAll(/\b(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g)].map((match) => match[1]);
    const unprefixed = declared.filter((id) => !id.startsWith('__wizz') && !author.has(id));

    assert.ok(declared.length > 10, `${name}: the scan found declarations`);
    // The exported entry points are the only exception: authors cannot reach them
    // from a declaration, and imports with these names are rejected.
    assert.deepEqual([...new Set(unprefixed)].filter((id) => !['mountComponent', 'hydrateComponent', 'hydrateRoot', 'renderComponent', 'onMount', 'onDestroy'].includes(id)), [], name);
  }
});

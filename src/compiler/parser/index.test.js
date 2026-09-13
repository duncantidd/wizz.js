const assert = require('node:assert/strict');
const test = require('node:test');
const { parseComponent } = require('./index');

test('returns an integrated template and scanned script declarations', () => {
  const component = parseComponent(
    '<script>let count = 0; const title = "Total"; function increment() {}</script><main><h1>{title}: {count + 1}</h1></main>'
  );

  assert.deepEqual(component.script, [
    {
      type: 'VariableDeclaration',
      kind: 'let',
      name: 'count',
      initialValue: '0',
      isReactive: true
    },
    {
      type: 'VariableDeclaration',
      kind: 'const',
      name: 'title',
      initialValue: '"Total"',
      isReactive: false
    },
    {
      type: 'FunctionDeclaration',
      name: 'increment'
    }
  ]);
  assert.equal(
    component.rawScript,
    'let count = 0; const title = "Total"; function increment() {}'
  );

  assert.equal(component.template.type, 'Root');
  assert.equal(component.template.children.length, 1);
  assert.equal(component.template.children[0].name, 'main');

  const headingExpressions = component.template.children[0].children[0].children
    .filter((node) => node.type === 'Expression');

  assert.deepEqual(headingExpressions[0].expressionAST, {
    type: 'Identifier',
    name: 'title'
  });
  assert.deepEqual(headingExpressions[1].expressionAST, {
    type: 'BinaryExpression',
    operator: '+',
    left: { type: 'Identifier', name: 'count' },
    right: { type: 'Literal', value: 1 }
  });
});

test('returns an empty script handoff when the component has no script block', () => {
  const component = parseComponent('<p>Hello {name}</p>');

  assert.deepEqual(component.script, []);
  assert.equal(component.template.children[0].name, 'p');
  assert.deepEqual(component.template.children[0].children[1].expressionAST, {
    type: 'Identifier',
    name: 'name'
  });
});

test('rejects non-string component source', () => {
  assert.throws(
    () => parseComponent({ template: '<p>Hello</p>' }),
    /Component source must be a string\./
  );
});
test('hands props to the payload as reactive, parent-owned declarations', () => {
  const component = parseComponent(
    "<script>export let name = 'Guest'; export let count; let clicks = 0;</script><p>{name}</p>"
  );

  assert.deepEqual(component.props, [
    { name: 'name', defaultValue: "'Guest'" },
    { name: 'count', defaultValue: null }
  ]);
  // Props join the reactive declaration set so template expressions track them.
  assert.deepEqual(component.script.slice(0, 2), [
    {
      type: 'VariableDeclaration',
      kind: 'let',
      name: 'name',
      initialValue: null,
      isReactive: true,
      isProp: true
    },
    {
      type: 'VariableDeclaration',
      kind: 'let',
      name: 'count',
      initialValue: null,
      isReactive: true,
      isProp: true
    }
  ]);
  // The raw script no longer contains the prop statements; `export` inside a
  // function body would be invalid generated JavaScript.
  assert.equal(component.rawScript.includes('export'), false);
  assert.equal(component.rawScript.includes('let clicks = 0;'), true);
  assert.deepEqual(component.imports, []);
});

test('rejects invalid prop syntax during parsing', () => {
  assert.throws(
    () => parseComponent('<script>export const name = 1;</script><p>Hi</p>'),
    /Unsupported export syntax/
  );
  assert.throws(
    () => parseComponent("<script>export let name = 'a'</script><p>Hi</p>"),
    /must end with a semicolon/
  );
});

test('rejects duplicate prop declarations but keeps legal block-scoped shadowing', () => {
  assert.throws(
    () => parseComponent('<script>export let count = 1; export let count = 2;</script><p>{count}</p>'),
    /declared more than once/
  );
  // The parser cannot distinguish a component-scope redeclaration from a
  // legal block-scoped shadow without a real JavaScript parser, so only the
  // generated factory would surface that error.
  assert.doesNotThrow(() => parseComponent(
    '<script>export let name = "x"; { let name = "local"; }</script><p>{name}</p>'
  ));
});

test('extracts a style block into the payload with a deterministic scope', () => {
  const source = '<main><h2>Titles</h2></main>\n<wizz:style>\n  h2 { font-size: 30px }\n</wizz:style>';
  const component = parseComponent(source);

  assert.equal(component.template.children[0].name, 'main');
  assert.notEqual(component.style, null);
  assert.equal(component.style.css, 'h2 { font-size: 30px }');
  assert.match(component.style.scope, /^s[0-9a-z]+$/);
  assert.equal(component.style.loc.start.line, 2);
  // Same source, same scope — server and client builds must agree.
  assert.equal(parseComponent(source).style.scope, component.style.scope);
});

test('styles stay null and templates stay byte-identical without a style block', () => {
  const component = parseComponent('<main><h2>Title</h2></main>');

  assert.equal(component.style, null);
  assert.equal(component.template.children.length, 1);
});

test('different sources hash to different style scopes', () => {
  const first = parseComponent('<main><h2>A</h2></main><wizz:style>h2 { font-size: 30px }</wizz:style>');
  const second = parseComponent('<main><h2>B</h2></main><wizz:style>h2 { font-size: 24px }</wizz:style>');

  assert.notEqual(first.style.scope, second.style.scope);
});

test('rejects a style block nested inside an element through the full pipeline', () => {
  assert.throws(
    () => parseComponent('<main><wizz:style>h2 {}</wizz:style></main>'),
    /<wizz:style> must be a top-level block/
  );
  assert.throws(
    () => parseComponent('<main><style>h2 { color: red }</style></main>'),
    /Plain <style> blocks are not supported — use <wizz:style>/
  );
});

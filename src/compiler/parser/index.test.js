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

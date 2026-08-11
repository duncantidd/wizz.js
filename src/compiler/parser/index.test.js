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
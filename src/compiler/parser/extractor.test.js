const assert = require('node:assert/strict');
const test = require('node:test');
const { extractScriptBlock } = require('./extractor');
const { integrateExpressions } = require('./integrator');
const { parseTemplate } = require('./templateParser');
const { tokenize } = require('./tokenizer');

test('extracts complete raw script content and removes its element from the AST', () => {
  const source = '<script>console.log("Hello, {user.name}!");</script><h1>Hello, {user.name}!</h1>';
  const ast = integrateExpressions(parseTemplate(tokenize(source)));

  assert.equal(
    extractScriptBlock(ast),
    'console.log("Hello, {user.name}!");'
  );
  assert.equal(ast.children.length, 1);
  assert.equal(ast.children[0].name, 'h1');
  assert.deepEqual(ast.children[0].children[1].expressionAST, {
    type: 'MemberExpression',
    object: { type: 'Identifier', name: 'user' },
    property: { type: 'Identifier', name: 'name' }
  });
});
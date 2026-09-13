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
test('extracts and prunes the top-level head block from the AST', () => {
  const { extractHeadBlock } = require('./extractor');
  const source = '<wizz:head><title>Hi</title></wizz:head><main>Body</main>';
  const ast = integrateExpressions(parseTemplate(tokenize(source)));

  const head = extractHeadBlock(ast);
  assert.equal(head.type, 'HeadBlock');
  assert.equal(head.name, 'wizz:head');
  assert.equal(head.children[0].name, 'title');
  assert.equal(ast.children.length, 1);
  assert.equal(ast.children[0].name, 'main');
});

test('returns null when the component declares no head block', () => {
  const { extractHeadBlock } = require('./extractor');
  const ast = integrateExpressions(parseTemplate(tokenize('<main>Body</main>')));

  assert.equal(extractHeadBlock(ast), null);
  assert.equal(ast.children.length, 1);
});

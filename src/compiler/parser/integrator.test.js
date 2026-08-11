const assert = require('node:assert/strict');
const test = require('node:test');
const { integrateExpressions } = require('./integrator');
const { parseTemplate } = require('./templateParser');
const { tokenize } = require('./tokenizer');

test('adds parsed ASTs to expressions throughout a template AST', () => {
  const ast = parseTemplate(tokenize('<main>{user.name + 1}<p>{total * 2}</p></main>'));
  const integratedAst = integrateExpressions(ast);
  const [outerExpression, paragraph] = integratedAst.children[0].children;

  assert.strictEqual(integratedAst, ast);
  assert.equal(outerExpression.value, 'user.name + 1');
  assert.deepEqual(outerExpression.expressionAST, {
    type: 'BinaryExpression',
    operator: '+',
    left: {
      type: 'MemberExpression',
      object: { type: 'Identifier', name: 'user' },
      property: { type: 'Identifier', name: 'name' }
    },
    right: { type: 'Literal', value: 1 }
  });
  assert.deepEqual(paragraph.children[0].expressionAST, {
    type: 'BinaryExpression',
    operator: '*',
    left: { type: 'Identifier', name: 'total' },
    right: { type: 'Literal', value: 2 }
  });
  assert.deepEqual(outerExpression.loc.start, { offset: 6, line: 1, column: 7 });
});

test('maps expression parser errors to template coordinates', () => {
  const ast = parseTemplate(tokenize('<div>{1 2}</div>'));

  assert.throws(
    () => integrateExpressions(ast),
    /Template Expression Error at 1:9 - Unexpected token Number/
  );
});

test('maps multiline expression errors to the correct template line', () => {
  const ast = parseTemplate(tokenize('<div>{name +\n$}</div>'));

  assert.throws(
    () => integrateExpressions(ast),
    /Template Expression Error at 2:1 - Unexpected character '\$'/
  );
});
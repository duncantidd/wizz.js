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
// Issue #64: quoted attribute values are static, so a `{expression}` inside
// one is a located diagnostic instead of silent literal output.
const integrateSource = (source) => integrateExpressions(parseTemplate(tokenize(source)));

test('rejects an expression inside a quoted class value (WIZZ-P055)', () => {
  assert.throws(
    () => integrateSource('<div class="card {tone}"></div>'),
    (error) => error.code === 'WIZZ-P055'
      && /Attribute 'class' on <div>/.test(error.message)
      && error.message.includes("'{tone}'")
      && error.message.includes('class={"card " + tone}')
  );
});

test('suggests the bare dynamic form when the whole quoted value is one expression', () => {
  assert.throws(
    () => integrateSource("<p title='{tone}'></p>"),
    (error) => error.code === 'WIZZ-P055' && error.message.includes('title={tone}')
  );
});

test('rejects interpolation on component tags and nested elements too', () => {
  assert.throws(() => integrateSource('<main><Card label="{x + 1}" /></main>'), { code: 'WIZZ-P055' });
  assert.throws(() => integrateSource('<main><ul><li data-id="a{id}b"></li></ul></main>'), { code: 'WIZZ-P055' });
});

test('keeps braces that are not expressions as literal static text', () => {
  for (const value of ['{}', '{ }', '{"a":1}', '{', '}', '}{', '{{', 'a { b', '{a b}', '{1 2}']) {
    const ast = integrateSource(`<div data-x='${value}'></div>`);
    assert.equal(ast.children[0].attributes[0].value, value);
  }
});

test('leaves dynamic, boolean, and on: attributes alone', () => {
  const ast = integrateSource('<button class={tone} hidden on:click="{go}">x</button>');
  assert.equal(ast.children[0].attributes[0].dynamic, true);
  assert.equal(ast.children[0].attributes[1].value, null);
});

test('suggestion keeps string concatenation when the value starts with an expression', () => {
  assert.throws(
    () => integrateSource('<i class="{a}{b}"></i>'),
    (error) => error.message.includes('class={"" + a + b}')
  );
});

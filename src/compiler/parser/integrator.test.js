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

// Issue #69: the extended grammar reaches every expression site.
test('integrates conditional, logical, unary, comparison, and call expressions', () => {
  const ast = integrateSource(
    "<ul class={items.length === 0 ? 'entries is-empty' : 'entries'}>"
    + '{#if !busy && items.length > 0}<li>{plural(items.length)}</li>{/if}</ul>'
  );
  const list = ast.children[0];
  assert.equal(list.attributes[0].expressionAST.type, 'ConditionalExpression');
  assert.equal(list.children[0].testAST.type, 'LogicalExpression');
  assert.equal(list.children[0].consequent[0].children[0].expressionAST.type, 'CallExpression');
});

test('dynamic attribute and if-test diagnostics carry the reason without a local location', () => {
  // The reason's own `at L:C` is local to the expression; leaving it in would
  // let errorAugmenter stamp it as the component location.
  assert.throws(
    () => integrateSource('<p class={a ? b}>x</p>'),
    (error) => error.code === 'WIZZ-P032'
      && error.message === "Dynamic attribute 'class' must contain a supported expression: Expected ':' in conditional expression."
  );
  assert.throws(
    () => integrateSource('<main>{#if --count}<b>x</b>{/if}</main>'),
    (error) => error.code === 'WIZZ-P031'
      && /^Conditional expression must contain a supported expression: Update operator '--'/.test(error.message)
      && !/ at \d+:\d+/.test(error.message)
  );
});

test('the quoted-value suggestion groups operands that bind looser than +', () => {
  assert.throws(
    () => integrateSource('<div class="card {active ? \'on\' : \'off\'}"></div>'),
    (error) => error.code === 'WIZZ-P055' && error.message.includes('class={"card " + (active ? \'on\' : \'off\')}')
  );
  assert.throws(
    () => integrateSource('<div data-n="n{x - 1}"></div>'),
    (error) => error.message.includes('data-n={"n" + (x - 1)}')
  );
  // Tighter-binding operands and a whole-value expression stay bare.
  assert.throws(
    () => integrateSource('<div data-n="n{x * 2}{f(y)}"></div>'),
    (error) => error.message.includes('data-n={"n" + x * 2 + f(y)}')
  );
  assert.throws(
    () => integrateSource('<div title="{a || b}"></div>'),
    (error) => error.message.includes('title={a || b}')
  );
});

test('brace groups the extended grammar still rejects stay literal in quoted values', () => {
  // Regex quantifiers, object literals, and update operators are not
  // expressions, so they never trip WIZZ-P055.
  for (const value of ['[a-z]{2,4}', '{a:1}', '{a?}', '{--a}', '{f(a,)}']) {
    const ast = integrateSource(`<input pattern='${value}'>`.replace('>', ' />'));
    assert.equal(ast.children[0].attributes[0].value, value);
  }
});

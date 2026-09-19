const assert = require('node:assert/strict');
const test = require('node:test');
const { CODES, DIAGNOSTIC_CODE_PATTERN, compilerDiagnostic } = require('./diagnostics.js');
const { compile, compileServer } = require('./index.js');
const { lexExpression } = require('./parser/expressionLexer.js');
const { parseExpression } = require('./parser/prattParser.js');

test('the catalog exposes the parser, analyzer, and generator groups', () => {
  assert.deepEqual(Object.keys(CODES).sort(), ['analyzer', 'generator', 'parser']);
});

test('every code matches the stable format', () => {
  for (const group of Object.values(CODES)) {
    for (const code of Object.values(group)) {
      assert.match(code, DIAGNOSTIC_CODE_PATTERN);
    }
  }
});

test('no code is assigned to more than one condition', () => {
  const seen = new Map();
  for (const [group, entries] of Object.entries(CODES)) {
    for (const [name, code] of Object.entries(entries)) {
      assert.equal(seen.has(code), false, `${group}.${name} reuses ${code}`);
      seen.set(code, `${group}.${name}`);
    }
  }
});

test('the analyzer namespace is reserved and empty', () => {
  // Dependency analysis and ID assignment cannot fail on valid parser
  // output, so no author-facing analyze diagnostics exist today. The empty
  // group keeps the stage visible in the catalog.
  assert.deepEqual(CODES.analyzer, {});
});

test('compilerDiagnostic stamps the code without touching message or type', () => {
  const error = compilerDiagnostic(CODES.parser.unclosedTag, 'Unclosed tag <main> starting at 1:1.');
  assert.equal(error.code, 'WIZZ-P022');
  assert.equal(error.message, 'Unclosed tag <main> starting at 1:1.');
  assert.equal(error instanceof SyntaxError, true);

  const guard = compilerDiagnostic(CODES.generator.persistSpanDrift, 'drift', TypeError);
  assert.equal(guard instanceof TypeError, true);
  assert.equal(guard.code, 'WIZZ-G024');
});

// One representative author-facing failure per load-bearing code. Each entry
// pins the exact code a broken component produces, so rewording the prose or
// renumbering the catalog fails here before it can break a downstream
// consumer.
const CORPUS = [
  ['WIZZ-P001', 'tokenizer', '<main a=></main>'],
  ['WIZZ-P002', 'parser', '<main>{#each items as}</main>'],
  ['WIZZ-P003', 'parser', '<main>{/each}</main>'],
  ['WIZZ-P004', 'parser', '<main>{/if}</main>'],
  ['WIZZ-P005', 'parser', '<main>{:else}</main>'],
  ['WIZZ-P006', 'parser', '<wizz:head><title><main>x</main></title></wizz:head>'],
  ['WIZZ-P007', 'parser', '<wizz:head><div>x</div></wizz:head>'],
  ['WIZZ-P009', 'parser', '<wizz:head class="x"><title>t</title></wizz:head>'],
  ['WIZZ-P011', 'parser', '<wizz:style media="x">a{}</wizz:style>'],
  ['WIZZ-P013', 'parser', '<wizz:head><title>a</title></wizz:head><wizz:head><title>b</title></wizz:head>'],
  ['WIZZ-P014', 'parser', '<wizz:style>a{}</wizz:style><wizz:style>b{}</wizz:style>'],
  ['WIZZ-P018', 'parser', '<main></section>'],
  ['WIZZ-P020', 'parser', '<style>a{color: red;}</style>'],
  ['WIZZ-P021', 'parser', '<wizz:head><meta charset="x"></meta></wizz:head>'],
  ['WIZZ-P022', 'parser', '<main><p>hi'],
  ['WIZZ-P023', 'parser', '</main>'],
  ['WIZZ-P032', 'parser', '<main class={a@b}>x</main>'],
  ['WIZZ-P033', 'parser', '<main><p>{@}</p></main>'],
  ['WIZZ-P035', 'parser', "<script>export let __wizzProp = 1;</script><main>x</main>"],
  ['WIZZ-P040', 'parser', "<script>export let name;export let name;</script><main>x</main>"],
  ['WIZZ-P044', 'parser', "<script>export let count = persist('count', 0);</script><main>x</main>"],
  ['WIZZ-P045', 'parser', "<script>const count = persist('count', 0);</script><main>{count}</main>"],
  ['WIZZ-P046', 'parser', "<script>function grow() { let count = persist('count', 0); }</script><main>x</main>"],
  ['WIZZ-P048', 'parser', "<script>let count = persist();</script><main>{count}</main>"],
  ['WIZZ-P049', 'parser', "<script>let count = persist('count', 0, 1);</script><main>{count}</main>"],
  ['WIZZ-P050', 'parser', "<script>let count = persist(count, 0);</script><main>{count}</main>"],
  ['WIZZ-P051', 'parser', "<script>let a = persist('a', persist('b', 1));</script><main>{a}</main>"],
  ['WIZZ-G012', 'generator', '<main on:click></main>'],
  ['WIZZ-G015', 'generator', "<script>export let title = 'a';\ntitle = 'b';</script><main>{title}</main>"],
  ['WIZZ-G017', 'server', "<script>let __wizzCount = 0;</script><main>{__wizzCount}</main>"],
  ['WIZZ-G020', 'server', "<script>import Card from '../components/Card.wizz';</script><main><Card /></main>"],
  ['WIZZ-G021', 'server', '<main><img src="a.png">text</img></main>']
];

for (const [expectedCode, target, source] of CORPUS) {
  test(`diagnostic corpus: ${expectedCode} (${target})`, () => {
    const compileCall = () => (target === 'server' ? compileServer(source) : compile(source));
    assert.throws(compileCall, (error) => {
      assert.equal(error.code, expectedCode);
      assert.equal(typeof error.message, 'string');
      return true;
    });
  });
}

// The integrator wraps every expression-lexer and pratt-parser failure in
// its own templateExpressionError diagnostic (WIZZ-P033), so P025-P030 are
// only reachable by calling the expression modules directly — as editor
// integrations and dev tooling do. One representative failure per code.
const EXPRESSION_CORPUS = [
  ['WIZZ-P025', () => lexExpression("'unclosed")],
  ['WIZZ-P026', () => lexExpression('@')],
  ['WIZZ-P027', () => parseExpression(lexExpression('*'))],
  ['WIZZ-P028', () => parseExpression(lexExpression('(a'))],
  ['WIZZ-P029', () => parseExpression(lexExpression('a.'))],
  ['WIZZ-P030', () => parseExpression(lexExpression('a)'))]
];

for (const [expectedCode, call] of EXPRESSION_CORPUS) {
  test(`diagnostic corpus: ${expectedCode} (expression modules)`, () => {
    assert.throws(call, (error) => {
      assert.equal(error.code, expectedCode);
      assert.equal(typeof error.message, 'string');
      return true;
    });
  });
}

test('a compile()-thrown diagnostic carries its code through the entry point', () => {
  assert.throws(() => compile('<main></section>'), (error) => error.code === 'WIZZ-P018');
});

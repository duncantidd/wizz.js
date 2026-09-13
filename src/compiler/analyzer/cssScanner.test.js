const assert = require('node:assert/strict');
const test = require('node:test');
const { scopeCss } = require('./cssScanner');

test('scopes terminal type selectors after the type token', () => {
  assert.equal(
    scopeCss('h2 { font-size: 30px }', 's1'),
    'h2[data-wizz-s="s1"] { font-size: 30px }'
  );
});

test('prepends the scope to class, id, and pseudo terminals', () => {
  assert.equal(scopeCss('.card { color: red }', 's1'), '[data-wizz-s="s1"].card { color: red }');
  assert.equal(scopeCss('#main { color: red }', 's1'), '[data-wizz-s="s1"]#main { color: red }');
  assert.equal(scopeCss(':hover { color: red }', 's1'), '[data-wizz-s="s1"]:hover { color: red }');
});

test('scopes only the terminal compound of combinator selectors', () => {
  assert.equal(scopeCss('.nav a { color: red }', 's1'), '.nav a[data-wizz-s="s1"] { color: red }');
  assert.equal(scopeCss('.nav .item { color: red }', 's1'), '.nav [data-wizz-s="s1"].item { color: red }');
  assert.equal(scopeCss('ul > li + li ~ p { color: red }', 's1'), 'ul > li + li ~ p[data-wizz-s="s1"] { color: red }');
});

test('keeps pseudo-classes after the inserted attribute', () => {
  assert.equal(scopeCss('a:hover { color: red }', 's1'), 'a[data-wizz-s="s1"]:hover { color: red }');
  assert.equal(scopeCss('h2::before { content: ">" }', 's1'), 'h2[data-wizz-s="s1"]::before { content: ">" }');
});

test('inserts before attribute selectors on type terminals', () => {
  assert.equal(
    scopeCss('input[type="text"] { color: red }', 's1'),
    'input[data-wizz-s="s1"][type="text"] { color: red }'
  );
});

test('scopes universal selectors after the star', () => {
  assert.equal(scopeCss('* { box-sizing: border-box }', 's1'), '*[data-wizz-s="s1"] { box-sizing: border-box }');
});

test('scopes each comma-separated selector without splitting :is() parens', () => {
  assert.equal(
    scopeCss('h2, p { margin: 0 }', 's1'),
    'h2[data-wizz-s="s1"], p[data-wizz-s="s1"] { margin: 0 }'
  );
  assert.equal(
    scopeCss(':is(h2, h3) { margin: 0 }', 's1'),
    '[data-wizz-s="s1"]:is(h2, h3) { margin: 0 }'
  );
});

test('string braces, colons, and quotes never break the scan', () => {
  assert.equal(
    scopeCss('h2::after { content: "a } b { c"; font-family: "x, y" }', 's1'),
    'h2[data-wizz-s="s1"]::after { content: "a } b { c"; font-family: "x, y" }'
  );
});

test('comments are preserved and never confused with structure', () => {
  assert.equal(
    scopeCss('/* header: { */\nh2 /* why */ { /* inner: } */ color: red; }\n/* tail */', 's1'),
    '/* header: { */\nh2[data-wizz-s="s1"] /* why */ { /* inner: } */ color: red; }\n/* tail */'
  );
});

test('descends into @media and @supports blocks', () => {
  assert.equal(
    scopeCss('@media (min-width: 40em) {\n  h2 { font-size: 30px }\n}', 's1'),
    '@media (min-width: 40em) {\n  h2[data-wizz-s="s1"] { font-size: 30px }\n}'
  );
  assert.equal(
    scopeCss('@supports (display: grid) { .grid { display: grid } }', 's1'),
    '@supports (display: grid) { [data-wizz-s="s1"].grid { display: grid } }'
  );
});

test('passes non-descended at-rules through verbatim', () => {
  const css = '@font-face {\n  font-family: "Body";\n  src: url(body.woff) format("woff");\n}';
  assert.equal(scopeCss(css, 's1'), css);
  const page = '@page { margin: 1in }';
  assert.equal(scopeCss(page, 's1'), page);
});

test('suffixes @keyframes names and leaves keyframe bodies verbatim', () => {
  assert.equal(
    scopeCss('@keyframes spin {\n  from { transform: rotate(0deg) }\n  to { transform: rotate(360deg) }\n}', 's1'),
    '@keyframes spin-s1 {\n  from { transform: rotate(0deg) }\n  to { transform: rotate(360deg) }\n}'
  );
});

test('suffixes vendor-prefixed keyframes names', () => {
  assert.equal(
    scopeCss('@-webkit-keyframes spin { from { opacity: 0 } }', 's1'),
    '@-webkit-keyframes spin-s1 { from { opacity: 0 } }'
  );
});

test('rewrites animation declarations that reference declared keyframe names', () => {
  const css = '@keyframes spin { to { transform: rotate(1turn) } }\n'
    + '.spinner { animation: spin 2s linear infinite; animation-name: spin; }';
  assert.equal(
    scopeCss(css, 's1'),
    '@keyframes spin-s1 { to { transform: rotate(1turn) } }\n'
    + '[data-wizz-s="s1"].spinner { animation: spin-s1 2s linear infinite; animation-name: spin-s1; }'
  );
});

test('rewrites references to keyframes declared after the usage', () => {
  const css = '.spinner { animation: spin 2s linear infinite; }\n@keyframes spin { to { opacity: 1 } }';
  assert.equal(
    scopeCss(css, 's1'),
    '[data-wizz-s="s1"].spinner { animation: spin-s1 2s linear infinite; }\n@keyframes spin-s1 { to { opacity: 1 } }'
  );
});

test('animation shorthand keywords are left alone when undeclared', () => {
  // The selector is still scoped; only the shorthand's idents are compared.
  assert.equal(
    scopeCss('.spinner { animation: 2s linear infinite; }', 's1'),
    '[data-wizz-s="s1"].spinner { animation: 2s linear infinite; }'
  );
});

test('non-shorthand animation properties are untouched', () => {
  assert.equal(
    scopeCss('.spinner { animation-duration: 2s; animation-fill-mode: both; }', 's1'),
    '[data-wizz-s="s1"].spinner { animation-duration: 2s; animation-fill-mode: both; }'
  );
});

test('tolerates unclosed braces without crashing', () => {
  assert.equal(
    scopeCss('h2 { color: red', 's1'),
    'h2[data-wizz-s="s1"] { color: red'
  );
});

test('returns empty and whitespace-only stylesheets unchanged', () => {
  assert.equal(scopeCss('', 's1'), '');
  assert.equal(scopeCss('   \n  ', 's1'), '   \n  ');
});

test('rejects non-string CSS and empty scope values', () => {
  assert.throws(() => scopeCss(null, 's1'), /CSS input must be a string/);
  assert.throws(() => scopeCss('h2 {}', ''), /scope value is required/);
  assert.throws(() => scopeCss('h2 {}', 7), /scope value is required/);
});

test('scopes a realistic two-rule stylesheet end to end', () => {
  const css = [
    '/* Counter styles */',
    'h2 {',
    '  font-size: 30px;',
    '  content: "{count}";',
    '}',
    '',
    '@media (min-width: 40em) {',
    '  h2 { font-size: 36px }',
    '}',
    '',
    '@keyframes pop {',
    '  from { transform: scale(1) }',
    '  to { transform: scale(1.2) }',
    '}',
    '',
    '.count { animation: pop 0.2s ease-out; }'
  ].join('\n');
  const scoped = scopeCss(css, 'abc123');
  assert.match(scoped, /h2\[data-wizz-s="abc123"\] \{\n  font-size: 30px;/);
  assert.match(scoped, /@media \(min-width: 40em\) \{\n  h2\[data-wizz-s="abc123"\] \{ font-size: 36px \}/);
  assert.match(scoped, /@keyframes pop-abc123 \{/);
  assert.match(scoped, /animation: pop-abc123 0\.2s ease-out;/);
  // The string literal survives verbatim.
  assert.match(scoped, /content: "\{count\}";/);
});

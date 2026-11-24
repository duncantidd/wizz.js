const assert = require('node:assert/strict');
const test = require('node:test');
const { compactCss } = require('./cssCompactor');
const { scopeCss } = require('../analyzer/cssScanner');

test('removes comments and whitespace around structural punctuation', () => {
  assert.equal(
    compactCss('/* header */\n.a ,\n.b {\n  color : red ;\n  margin: 0 auto;\n}\n'),
    '.a,.b{color :red;margin:0 auto}'
  );
});

test('drops the final semicolon of a block, and only that one', () => {
  assert.equal(compactCss('a { color: red; }'), 'a{color:red}');
  assert.equal(compactCss('a { color: red; ; }'), 'a{color:red;}');
  assert.equal(compactCss('@import "x.css";'), '@import "x.css";');
  assert.equal(compactCss('a{b:c;} d{e:f;}'), 'a{b:c}d{e:f}');
});

test('keeps whitespace that changes selector meaning', () => {
  // Descendant pseudo-class vs compound pseudo-class.
  assert.equal(compactCss('.a :hover {}'), '.a :hover{}');
  assert.equal(compactCss('.a:hover {}'), '.a:hover{}');
  // Descendant combinators collapse to one space but never disappear.
  assert.equal(compactCss('main   section\n\tp {}'), 'main section p{}');
  // After a closing parenthesis, a space is still a combinator.
  assert.equal(compactCss(':not(.a) .b {}'), ':not(.a) .b{}');
  assert.equal(compactCss(':is( .a , .b ) {}'), ':is(.a,.b){}');
});

test('keeps whitespace that changes value or at-rule meaning', () => {
  // calc() requires spaces around + and -.
  assert.equal(compactCss('a { width: calc( 100% - 2 * 8px ) }'), 'a{width:calc(100% - 2 * 8px)}');
  // `and (` is not the function `and(`.
  assert.equal(compactCss('@media screen and (min-width : 600px) { a { b: c } }'), '@media screen and (min-width :600px){a{b:c}}');
  assert.equal(compactCss('a { margin: 1px  2px\n3px }'), 'a{margin:1px 2px 3px}');
  assert.equal(compactCss('a { color: red !important }'), 'a{color:red !important}');
});

test('strings are copied byte for byte, content strings included', () => {
  assert.equal(compactCss('a::before { content: "  a ; } b  " }'), 'a::before{content:"  a ; } b  "}');
  assert.equal(compactCss("[title='x  y'] { content: 'it\\'s  /* not a comment */' }"), "[title='x  y']{content:'it\\'s  /* not a comment */'}");
  assert.equal(compactCss('a { content: "\\201C  " }'), 'a{content:"\\201C  "}');
});

test('unquoted url() bodies are kept; surrounding padding goes', () => {
  assert.equal(compactCss('a { background: url( img/a b.png ) }'), 'a{background:url(img/a b.png)}');
  assert.equal(compactCss('a { background: URL(data:image/svg+xml;utf8,<svg/>) }'), 'a{background:URL(data:image/svg+xml;utf8,<svg/>)}');
  assert.equal(compactCss('a { background: url( "x y.png" ) }'), 'a{background:url("x y.png")}');
  assert.equal(compactCss('a { background: url(a\\)b.png) }'), 'a{background:url(a\\)b.png)}');
  // `myurl(` is not url().
  assert.equal(compactCss('a { b: myurl( x  y ) }'), 'a{b:myurl(x y)}');
  // Comment syntax inside url() is not a comment.
  assert.equal(compactCss('a { b: url(//cdn/x/*y*/.png) }'), 'a{b:url(//cdn/x/*y*/.png)}');
});

test('escapes, including the whitespace that terminates a hex escape', () => {
  // One space ends the escape; a second space is a descendant combinator.
  assert.equal(compactCss('.a\\26  b {}'), '.a\\26  b{}');
  // A single terminating space belongs to the escape and stays.
  assert.equal(compactCss('.a\\26 b {}'), '.a\\26 b{}');
  // An escaped structural character is not structural.
  assert.equal(compactCss('.a\\{ b {}'), '.a\\{ b{}');
  // An escaped `;` before `}` is part of the value, never the dropped one.
  assert.equal(compactCss('.x { --v: a\\; }'), '.x{--v:a\\;}');
  assert.equal(compactCss('.x\\; {color:red;}'), '.x\\;{color:red}');
  assert.equal(compactCss('.a\\:hover {}'), '.a\\:hover{}');
});

test('a comment between two tokens keeps the boundary as an empty comment', () => {
  assert.equal(compactCss('a/**/b {}'), 'a/**/b{}');
  assert.equal(compactCss('a /**/ b {}'), 'a b{}');
  assert.equal(compactCss('a{/**/color:red}'), 'a{color:red}');
});

test('an empty custom property keeps its space', () => {
  assert.equal(compactCss('a { --x: ; --y:  1px  }'), 'a{--x: ;--y:1px}');
  assert.equal(compactCss('a { --x: }'), 'a{--x: }');
});

test('scoped component CSS compacts and keeps its scope attribute selectors', () => {
  const scoped = scopeCss('.card > p  span { color: red; }\n@keyframes spin { from { x: 0 } }', 'sabc');
  const compacted = compactCss(scoped);
  assert.ok(compacted.length < scoped.length);
  assert.ok(compacted.includes('[data-wizz-s="sabc"]'));
  assert.doesNotMatch(compacted, /\n/);
});

test('compaction is idempotent', () => {
  const source = '.a :hover , .b { content: " x " ; background: url( a.png ) }\n/* c */ .c\\26  d { --e: ; }';
  const once = compactCss(source);
  assert.equal(compactCss(once), once);
});

test('empty, whitespace-only, and comment-only sheets compact to nothing', () => {
  assert.equal(compactCss(''), '');
  assert.equal(compactCss('  \n /* only */ \n'), '');
});

test('malformed input fails with a located SyntaxError', () => {
  const cases = [
    ['a { color: red }\n/* never closed', 'Unterminated comment', 2, 1],
    ['a {\n  content: "open\n}', 'Unterminated string', 2, 12],
    ['a { b: url(x.png }', 'Unterminated url()', 1, 8]
  ];
  for (const [source, message, line, column] of cases) {
    assert.throws(() => compactCss(source), (error) => {
      assert.ok(error instanceof SyntaxError);
      assert.ok(error.message.startsWith(message), error.message);
      assert.equal(error.line, line, source);
      assert.equal(error.column, column, source);
      return true;
    });
  }
  assert.throws(() => compactCss(null), TypeError);
});

test('compaction time stays linear on a large sheet', () => {
  const unit = '.a :hover , .b > c { content: " x " ; background: url( a.png ); margin: 1px 2px }\n';
  const time = (source) => {
    const start = process.hrtime.bigint();
    compactCss(source);
    return Number(process.hrtime.bigint() - start) / 1e6;
  };
  time(unit.repeat(500));
  const smallMs = Math.max(time(unit.repeat(500)), 1);
  const largeMs = time(unit.repeat(5000));
  assert.ok(largeMs < smallMs * 40, `small ${smallMs.toFixed(1)} ms, large ${largeMs.toFixed(1)} ms`);
});

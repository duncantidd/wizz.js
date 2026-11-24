const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { compactJs, validateJs, locate } = require('./jsCompactor');
const { tokenizeScript } = require('../scriptLexer');

// Runs a script in a fresh context and returns its completion value as JSON,
// so the original and compacted forms can be compared by behavior.
function run(source) {
  return JSON.stringify(vm.runInNewContext(source, {}, { timeout: 1000 }));
}

// The core contract: the compacted form behaves identically and is no longer.
function assertEquivalent(source, expectedValue) {
  const compacted = compactJs(source);
  assert.ok(compacted.length <= source.length, `grew: ${JSON.stringify(compacted)}`);
  assert.equal(run(compacted), run(source), `behavior changed:\n${source}\n---\n${compacted}`);
  if (expectedValue !== undefined) assert.equal(run(compacted), JSON.stringify(expectedValue));
  return compacted;
}

const significant = (source) => tokenizeScript(source)
  .filter((token) => token.type !== 'comment')
  .map((token) => `${token.type}:${token.value}`);

test('removes comments and insignificant whitespace', () => {
  const compacted = assertEquivalent([
    '// leading comment',
    'function add ( a , b ) {',
    '  /* inline */ return a + b ; // trailing',
    '}',
    'add( 1 , 2 )'
  ].join('\n'), 3);
  assert.equal(compacted, 'function add(a,b){return a+b;}\nadd(1,2)');
});

test('keeps the space words need and nothing else', () => {
  assert.equal(compactJs('const  x = typeof   y ;'), 'const x=typeof y;');
  assert.equal(compactJs('return   "x"'), 'return"x"');
  assert.equal(compactJs('x = a   instanceof   B'), 'x=a instanceof B');
});

test('a token pair that would merge keeps one space', () => {
  // Evaluated left to right: --b makes b 1, then ++b makes it 2 again.
  assertEquivalent('var a = 5, b = 2; [a - -b, a + +b, a - --b, a + ++b]', [7, 7, 4, 7]);
  assert.equal(compactJs('a - -b'), 'a- -b');
  assert.equal(compactJs('a + +b'), 'a+ +b');
  assert.equal(compactJs('a + ++b'), 'a+ ++b');
  assert.equal(compactJs('a-- > b'), 'a-- >b');
  assert.equal(compactJs('a < !b'), 'a< !b');
  // A number before `.` would become a decimal point.
  assertEquivalent('1 .toString() + 2 .toFixed(1)', '12.0');
  assert.equal(compactJs('1 .toString()'), '1 .toString()');
  // Two slashes would start a comment; slash-star a block comment.
  assert.equal(compactJs('x = a / /re/.source.length'), 'x=a/ /re/.source.length');
  assertEquivalent('var a = 6; a / /ab/.source.length', 3);
  // `? .5` must not become optional chaining.
  assertEquivalent('var c = true; c ? .5 : 1', 0.5);
});

test('tokens that were adjacent stay adjacent', () => {
  assert.equal(compactJs('class A { #x = 1; get() { return this.#x } }'), 'class A{#x=1;get(){return this.#x}}');
  assertEquivalent('class A { #x = 1; has(o) { return #x in o } } new A().has(new A())', true);
});

test('ASI hazard: return/throw/break/continue keep the line break', () => {
  assertEquivalent('(function () { return\n  42 })()', undefined);
  const compacted = compactJs('function f() {\n  return\n  42\n}');
  assert.match(compacted, /return\n42/);
  assertEquivalent('(function () { try { throw new Error("x") } catch (e) { return e.message } })()', 'x');
  // `break\nouter` is `break; outer;` (an unlabeled break of the inner
  // loop); joined, `break outer` would leave both loops after one pass.
  assertEquivalent('var n = 0, outer = 0; outer: for (;;) { for (;;) { n++; break\nouter } if (n > 3) break } n', 4);
  assertEquivalent('var s = 0; for (var i = 0; i < 3; i++) { if (i === 1) continue\ns += i } s', 2);
  assertEquivalent('function* g() { yield\n1 } [...g()]', [undefined]);
});

test('ASI hazard: postfix ++/-- never joins the previous line', () => {
  const source = 'var x = 1, y = 1\nx\n++y\n;[x, y]';
  assertEquivalent(source, [1, 2]);
  assert.match(compactJs(source), /x\n\+\+y/);
  assertEquivalent('var a = 3, b = 3\na\n--b\n;[a, b]', [3, 2]);
});

test('ASI hazard: lines starting with ( [ ` + - / keep the line break', () => {
  // These lines continue the previous statement in the original, and must
  // keep doing exactly that.
  assertEquivalent('var f = function () { return [1, 2] }\nvar r = f\n(function () { return 0 })\nr', [1, 2]);
  assertEquivalent('var a = [[5, 6]]\nvar b = a\n[0]\nb', [5, 6]);
  assertEquivalent('var tag = (s) => s.raw[0]\nvar t = tag\n`raw`\nt', 'raw');
  assertEquivalent('var p = 1\nvar q = p\n+ 1\nq', 2);
  assertEquivalent('var m = 10\nvar d = m\n/ 2\nd', 5);
  for (const line of ['(b)', '[0]', '`t`', '+1', '-1']) {
    assert.match(compactJs(`a\n${line}`), /^a\n/);
  }
});

test('ASI hazard: async and arrow restrictions survive', () => {
  assertEquivalent('var async = 1\nasync\nfunction f() { return 2 }\n[async, typeof f]', [1, 'function']);
});

test('a dropped block comment that held a line break still counts as one', () => {
  assertEquivalent('(function () { return /*\n*/ 42 })()', undefined);
  assert.match(compactJs('return /*\n*/ 42'), /return\n42/);
  // A single-line block comment between tokens is simply removed.
  assert.equal(compactJs('a /* x */ + /* y */ b'), 'a+b');
});

test('line breaks after operators and before closers are dropped', () => {
  assert.equal(compactJs('x = a +\n  b'), 'x=a+b');
  assert.equal(compactJs('f(\n  a,\n  b\n)'), 'f(a,b)');
  assert.equal(compactJs('const o = {\n  a: 1,\n  b: 2\n}'), 'const o={a:1,b:2}');
  assert.equal(compactJs('a\n.b()\n.c()'), 'a.b().c()');
});

test('regex vs division: both readings round-trip', () => {
  assertEquivalent('var a = 10, b = 2, g = 1; a / b / g', 5);
  assertEquivalent('var s = "a/b"; s.split(/\\//g).length', 2);
  assertEquivalent('var x = 4; x /= 2; x', 2);
  assertEquivalent('[/[/]/.test("/"), /a b/.test("a b"), /\\s+/g.source]', [true, true, '\\s+']);
  assertEquivalent('(function () { return /=  x/.source })()', '=  x');
  assertEquivalent('typeof /x/', 'object');
  // Regex body whitespace is part of the token and survives.
  assert.equal(compactJs('x = /a  b/g'), 'x=/a  b/g');
});

test('regex vs division: known-ambiguous positions are copied verbatim', () => {
  // After `)`, a `/` is a regex when the parentheses closed an if/while head.
  const ifRegex = 'var hit = 0\nif (true) / a b/.test(" a b") && hit++\nhit';
  assert.match(compactJs(ifRegex), /if\(true\)\/ a b\/\.test\(" a b"\) && hit\+\+/);
  assertEquivalent(ifRegex, 1);
  // ...and division when they closed an expression.
  assertEquivalent('var a = 8; (a) / 2 / 2', 2);
  // After `}`, a block statement may be followed by a regex.
  assertEquivalent('var r\n{ }\n/ x /.test(" x ") ? r = 1 : r = 2\nr', 1);
  // A keyword used as a property name is an operand.
  assertEquivalent('var o = { return: 8, in: 4 }; o.return / 2 / 2 + o.in / 2', 4);
  // `of` is contextual: after it, `/` starts a regex.
  assertEquivalent('var out = []; for (const m of / x /.exec(" x ")) out.push(m); out', [' x ']);
});

test('non-ASCII identifiers keep their spacing and division', () => {
  assertEquivalent('var café = 8, naïve = 2; café / naïve / 2', 2);
  assertEquivalent('var π = 3; typeof π', 'number');
});

test('strings are copied byte for byte, escapes and all', () => {
  const source = 'var s = ["a  b", \'c\\\' d\', "\\u00e9  \\x41", "tab\\t", "line\\\ncontinued"]; s';
  const compacted = assertEquivalent(source);
  assert.ok(compacted.includes('"a  b"'));
  assert.ok(compacted.includes('"\\u00e9  \\x41"'));
  assert.ok(compacted.includes('"line\\\ncontinued"'));
  // A literal U+2028 inside a string is legal and must stay inside it.
  const separator = String.fromCharCode(0x2028);
  assertEquivalent(`var u = "a${separator}b"; u.length`, 3);
});

test('unicode escapes in identifiers keep their separating space', () => {
  assertEquivalent('var \\u0061bc = 4; var x = abc; x', 4);
  assert.equal(compactJs('var \\u0061 = 1'), 'var \\u0061=1');
});

test('</script> inside strings and templates is left untouched', () => {
  const source = 'var html = "<script>x</script>" + `</script>`; html';
  const compacted = assertEquivalent(source, '<script>x</script></script>');
  assert.ok(compacted.includes('"<script>x</script>"'));
});

test('template literals: text, nesting, and interpolation spacing', () => {
  const source = [
    'var a = 1, b = 2',
    'var t = `  lead ${ a  +  b }  mid ${ `inner  ${ `deep ${ a }` }  ` }  trail  `',
    't'
  ].join('\n');
  const compacted = assertEquivalent(source, '  lead 3  mid inner  deep 1    trail  ');
  assert.ok(compacted.includes('${a+b}'));
  assertEquivalent('var e = ``; var w = `   `; var n = `\n  x\n`; [e, w, n]', ['', '   ', '\n  x\n']);
  assertEquivalent('var o = { a: 1 }; `${ { ...o }.a }${ (() => { return "}" })() }`', '1}');
  assertEquivalent('var x = 2; `a${x}${x}b${ /* c */ x }`', 'a22b2');
});

test('a hashbang line is kept verbatim', () => {
  assert.equal(compactJs('#!/usr/bin/env node\nconst  a = 1 ;'), '#!/usr/bin/env node\nconst a=1;');
  assert.equal(compactJs('#!/usr/bin/env node'), '#!/usr/bin/env node');
});

test('module syntax compacts and stays tokenized identically', () => {
  const source = [
    "import { a , b } from './x.js';",
    "import * as ns from \"./y.js\";",
    'export default function mount ( target ) { return a ( target ) }',
    'export const  value = await ns . load ( ) ;'
  ].join('\n');
  const compacted = compactJs(source);
  assert.equal(compacted, "import{a,b}from'./x.js';import*as ns from\"./y.js\";export default function mount(target){return a(target)}\nexport const value=await ns.load();");
  assert.deepEqual(significant(compacted), significant(source));
});

test('the framework runtime and generated sources tokenize identically after compaction', () => {
  const runtimeDirectory = path.join(__dirname, '..', '..', 'runtime');
  for (const name of fs.readdirSync(runtimeDirectory).filter((file) => file.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(runtimeDirectory, name), 'utf8');
    const compacted = compactJs(source);
    assert.ok(compacted.length < source.length, name);
    assert.deepEqual(significant(compacted), significant(source), name);
  }
});

test('compaction is idempotent', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'runtime', 'router.js'), 'utf8');
  const once = compactJs(source);
  assert.equal(compactJs(once), once);
});

test('malformed input fails with a located SyntaxError', () => {
  const cases = [
    ['const a = 1;\nconst s = "open', 'Unterminated string literal', 2, 11],
    ["x = 'a\\'", 'Unterminated string literal', 1, 5],
    ['a = 1;\n  /* never closed', 'Unterminated block comment', 2, 3],
    ['const t = `abc ${x}', 'Unterminated template literal', 1, 11],
    ['const t = `a ${ `b ${c}` ', 'Unterminated template literal', 1, 11]
  ];
  for (const [source, message, line, column] of cases) {
    assert.throws(() => compactJs(source), (error) => {
      assert.ok(error instanceof SyntaxError);
      assert.ok(error.message.startsWith(message), error.message);
      assert.equal(error.line, line, source);
      assert.equal(error.column, column, source);
      return true;
    });
    assert.throws(() => validateJs(source), SyntaxError);
  }
});

test('a located error after a hashbang counts the hashbang line', () => {
  assert.throws(() => compactJs('#!/usr/bin/env node\nconst s = "open'), (error) => error.line === 2 && error.column === 11);
});

test('validateJs accepts what compactJs accepts and rejects non-strings', () => {
  validateJs('const a = `x ${ "y" }`; /* ok */');
  assert.throws(() => validateJs(null), TypeError);
  assert.throws(() => compactJs(42), TypeError);
});

test('empty and comment-only inputs compact to nothing', () => {
  assert.equal(compactJs(''), '');
  assert.equal(compactJs('  \n// only\n/* comments */\n'), '');
});

test('locate maps offsets to 1-based lines and columns', () => {
  assert.deepEqual(locate('ab\ncd', 0), { line: 1, column: 1 });
  assert.deepEqual(locate('ab\ncd', 4), { line: 2, column: 2 });
});

test('compaction time stays linear on a large input', () => {
  const unit = fs.readFileSync(path.join(__dirname, '..', '..', 'runtime', 'router.js'), 'utf8');
  const small = unit.repeat(10);
  const large = unit.repeat(100);
  const time = (source) => {
    const start = process.hrtime.bigint();
    compactJs(source);
    return Number(process.hrtime.bigint() - start) / 1e6;
  };
  time(small); // Warm up.
  const smallMs = Math.max(time(small), 1);
  const largeMs = time(large);
  // 10x the input may take 10x the time; a quadratic scan would take ~100x.
  assert.ok(largeMs < smallMs * 40, `small ${smallMs.toFixed(1)} ms, large ${largeMs.toFixed(1)} ms`);
});

// Review findings on milestone 23 (Gemini Carbon, commit 0b3ebbf).

test('code after a line comment ended by CR, U+2028, or U+2029 is kept', () => {
  for (const terminator of ['\r', String.fromCharCode(0x2028), String.fromCharCode(0x2029)]) {
    const source = `// note${terminator}var x = 1; x`;
    assert.equal(compactJs(source), 'var x=1;x', JSON.stringify(terminator));
    assert.equal(run(compactJs(source)), run(source));
  }
});

test('a regex at an ambiguous position may hold quotes, backticks, and comment openers', () => {
  for (const source of [
    "var s = \"don't\", hit = 0; if (true) /don't/.test(s) && hit++; hit",
    'var s = "`", hit = 0; if (true) /`/.test(s) && hit++; hit',
    'var s = "*", hit = 0; if (true) /[/*]/.test(s) && hit++; hit'
  ]) {
    assert.equal(run(compactJs(source)), '1', source);
    validateJs(source); // Valid code: no throw.
  }
});

test('a verbatim span ending in a line comment keeps the following line break', () => {
  assertEquivalent('var x = 8; var a = (x) / 2 + // trailing\n 3; a', 7);
  assertEquivalent('function f(x) {\n return (x) / 2 // half\n}\nf(8)', 4);
  assertEquivalent('var ok = 1; if (true) /[//]/.test("/")\nok', 1);
});

test('CRLF string line continuations compact and run', () => {
  const backslash = String.fromCharCode(0x5c);
  const source = `var s = "hello${backslash}\r\nworld"; s`;
  assert.equal(run(compactJs(source)), '"helloworld"');
});

test('a raw CR inside a string is rejected like a raw LF', () => {
  assert.throws(() => compactJs('const s = "abc\rdef";'), /Unterminated string literal \(line 1, column 11\)/);
});

test('real malformations are still reported when no ambiguous slash exists', () => {
  assert.throws(() => compactJs('const a = (x) * 2;\nconst s = "open'), /Unterminated string literal/);
});

// Second-pass review findings (Gemini Argon, commit e542988).

test('chained division after ) does not mask a real syntax error elsewhere', () => {
  const source = 'const r = (8) / 4 / 2;\nconst broken = "unterminated';
  assert.throws(() => compactJs(source), /Unterminated string literal \(line 2, column 16\)/);
  assert.throws(() => validateJs(source), /Unterminated string literal/);
  // ...and plain chained division still compacts.
  assertEquivalent('var a = 8; (a) / 4 / 2', 1);
});

test('an error before a risky ambiguous slash is still reported', () => {
  const source = 'const broken = "unterminated\nif (true) /don\'t/.test("x");';
  assert.throws(() => compactJs(source), /Unterminated string literal \(line 1, column 16\)/);
  assert.throws(() => validateJs(source), /Unterminated string literal/);
});

test('division after a template literal compacts to valid, equivalent code', () => {
  const source = 'var width = 10, height = 2;\nvar a = (`${width}` / height // divide\n);\na';
  const compacted = assertEquivalent(source, 5);
  new vm.Script(compacted); // Parses.
  assertEquivalent('var x = 8; `${x}` / 2 + "a / b"', '4a / b');
});

test('export default followed by a regex keeps the regex byte for byte', () => {
  assert.equal(compactJs('export default /a   b/;'), 'export default/a   b/;');
  assert.equal(compactJs("export default /don't/;"), "export default/don't/;");
  // As a property name, default is an operand: obj.default / 2 is division.
  assertEquivalent('var o = { default: 8 }; o.default / 2 / 2', 2);
});

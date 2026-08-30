const assert = require('node:assert/strict');
const test = require('node:test');
const { tokenizeScript, matchTemplateTokens } = require('./scriptLexer');

const values = (source) => tokenizeScript(source).map((token) => token.value);
const types = (source) => tokenizeScript(source).map((token) => token.type);

test('tokenizes identifiers, numbers, strings, and punctuators', () => {
  assert.deepEqual(
    types('let count = 1;'),
    ['identifier', 'identifier', 'punctuator', 'number', 'punctuator']
  );
  assert.deepEqual(values('let count = 1;'), ['let', 'count', '=', '1', ';']);
});

test('emits comments as tokens so offsets stay aligned', () => {
  const tokens = tokenizeScript('a; // note\nb;');
  assert.deepEqual(tokens.map((token) => token.type), ['identifier', 'punctuator', 'comment', 'identifier', 'punctuator']);
  assert.equal(tokens[2].value, '// note');
});

test('preserves every character range: token values match their source slices', () => {
  const source = 'const re = /a[/]b/gi; /* c */ let s = `t${x}e` + "q\\"q" + 1.5e-3;';
  for (const token of tokenizeScript(source)) {
    assert.equal(token.value, source.slice(token.start, token.end), `token ${token.type} at ${token.start}`);
  }
});

test('handles string escapes and stops unterminated strings before the newline', () => {
  assert.deepEqual(values("'a\\'b' + \"c\\\"d\""), ["'a\\'b'", '+', '"c\\\"d"']);
  const tokens = tokenizeScript("'unterminated\nnext = 1;");
  assert.equal(tokens[0].type, 'string');
  assert.equal(tokens[0].value, "'unterminated");
  assert.equal(tokens[1].value, 'next');
});

test('distinguishes line comments from a slash inside a string', () => {
  assert.equal(values('const s = "// not a comment";')[3], '"// not a comment"');
  assert.deepEqual(types('// only a comment'), ['comment']);
});

test('block comments span lines and an unterminated block comment reaches EOF', () => {
  assert.deepEqual(values('a /* x = 1; y = 2; */ b').filter((value) => !value.startsWith('/*')), ['a', 'b']);
  assert.deepEqual(values('/* "unclosed quote stays inside'), ['/* "unclosed quote stays inside']);
  assert.deepEqual(types('a; /* trailing'), ['identifier', 'punctuator', 'comment']);
});

test('template literals emit text chunks around interpolation punctuators', () => {
  const tokens = tokenizeScript('`a${b}c`');
  assert.deepEqual(tokens.map((token) => token.type), [
    'punctuator', 'templateText', 'punctuator', 'identifier', 'punctuator', 'templateText', 'punctuator'
  ]);
  assert.deepEqual(tokens.map((token) => token.value), ['`', 'a', '${', 'b', '}', 'c', '`']);
  assert.equal(tokens[4].interpolationClose, true);
});

test('template interpolations nest and contain fully tokenized code', () => {
  const tokens = tokenizeScript('`a${ `b${c}d` }e`');
  const code = values('1 + 2');
  assert.ok(tokens.some((token) => token.value === '${'));
  assert.equal(tokens.filter((token) => token.value === '`').length, 4);
  assert.deepEqual(values('`${ `x${1 + 2}y` }`').filter((value) => ['1', '+', '2'].includes(value)), code);
});

test('template escapes keep backticks and dollar signs inside the text', () => {
  assert.deepEqual(values('`a\\`b`'), ['`', 'a\\`b', '`']);
  assert.deepEqual(values('`\\${not an interpolation}`'), ['`', '\\${not an interpolation}', '`']);
});

test('unterminated templates reach EOF without hanging', () => {
  assert.deepEqual(types('`never closed'), ['punctuator', 'templateText']);
  assert.deepEqual(types('const s = `a${b'), ['identifier', 'identifier', 'punctuator', 'punctuator', 'templateText', 'punctuator', 'identifier']);
});

test('a slash after an assignment starts a regex literal', () => {
  const tokens = tokenizeScript('x = /a;b/gi;');
  assert.equal(tokens[2].type, 'regex');
  assert.equal(tokens[2].value, '/a;b/gi');
});

test('a slash after an operand is division, not a regex', () => {
  for (const source of ['a / b', 'a / b / c', 'x++) / 2', '1 / 2', '"s" / 2', '(a) / 2', 'arr[0] / 2', 'a++ /2/ 3']) {
    const slash = tokenizeScript(source).find((token) => token.value === '/' || token.type === 'regex');
    assert.equal(slash.type, 'punctuator', source);
  }
});

test('a slash after regex-allowing keywords starts a regex', () => {
  for (const keyword of ['return', 'typeof', 'case', 'else', 'do', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'in', 'instanceof']) {
    const tokens = tokenizeScript(`${keyword} /a[/]b/g`);
    assert.equal(tokens[1].type, 'regex', keyword);
  }
});

test('regex character classes may contain slashes and escaped slashes', () => {
  assert.equal(tokenizeScript('= /a[/]b/')[1].value, '/a[/]b/');
  assert.equal(tokenizeScript('= /a\\/b\\\\c/')[1].value, '/a\\/b\\\\c/');
});

test('division followed by a regex tokenizes both correctly', () => {
  const tokens = tokenizeScript('average = total / count;\nconst re = /x = 5/;');
  assert.deepEqual(tokens.filter((token) => token.type === 'regex').map((token) => token.value), ['/x = 5/']);
  assert.equal(tokens.filter((token) => token.value === '/').length, 1);
});

test('an unterminated regex falls back to a division punctuator', () => {
  const tokens = tokenizeScript('= /never closed;');
  assert.equal(tokens[1].type, 'punctuator');
  assert.equal(tokens[1].value, '/');
  assert.deepEqual(values('= /never closed;').slice(2), ['never', 'closed', ';']);
});

test('an empty-comment slash pair is a comment, not an empty regex', () => {
  assert.deepEqual(types('// comment'), ['comment']);
});

test('numbers cover decimals, exponents, radix prefixes, BigInt, and separators', () => {
  for (const literal of ['0', '42', '1_000', '3.14', '.5', '6.02e23', '1e-9', '0x1F', '0b1010', '0o777', '9007199254740993n']) {
    const tokens = tokenizeScript(literal);
    assert.equal(tokens.length, 1, literal);
    assert.equal(tokens[0].type, 'number', literal);
  }
});

test('multi-character punctuators match longest first', () => {
  assert.deepEqual(values('a >>>= b'), ['a', '>>>=', 'b']);
  assert.deepEqual(values('a === b !== c'), ['a', '===', 'b', '!==', 'c']);
  assert.deepEqual(values('a **= b ** c'), ['a', '**=', 'b', '**', 'c']);
  assert.deepEqual(values('a => b; a == b; a = b'), ['a', '=>', 'b', ';', 'a', '==', 'b', ';', 'a', '=', 'b']);
  assert.deepEqual(values('a?.b ?? c'), ['a', '?.', 'b', '??', 'c']);
  assert.deepEqual(values('...args'), ['...', 'args']);
});

test('optional chaining is one token while ternaries stay separate', () => {
  assert.deepEqual(values('a ? b : c'), ['a', '?', 'b', ':', 'c']);
  assert.deepEqual(values('a?.b'), ['a', '?.', 'b']);
});

test('newlineBefore is true exactly when a line break precedes the token', () => {
  const tokens = tokenizeScript('a = 1\n+ 2;\nb;');
  assert.deepEqual(tokens.map((token) => token.newlineBefore), [false, false, false, true, false, false, true, false]);
});

test('a newline inside a string does not leak onto the following token before recovery', () => {
  const tokens = tokenizeScript('"a\nb"');
  assert.equal(tokens[0].newlineBefore, false);
});

test('unknown characters still tokenize so scanning always progresses', () => {
  assert.deepEqual(values('a @ b'), ['a', '@', 'b']);
});

test('matchTemplateTokens pairs backticks across nested interpolations', () => {
  const source = '`a${ `b${c}d` }e`';
  const tokens = tokenizeScript(source);
  const pairs = matchTemplateTokens(tokens);
  const backticks = tokens.reduce((indices, token, index) => (token.value === '`' ? [...indices, index] : indices), []);
  assert.deepEqual(pairs, new Map([[backticks[1], backticks[2]], [backticks[0], backticks[3]]]));
});

test('an unpaired backtick simply produces no pair', () => {
  const pairs = matchTemplateTokens(tokenizeScript('`unterminated'));
  assert.equal(pairs.size, 0);
});

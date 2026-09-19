const assert = require('node:assert/strict');
const test = require('node:test');
const { tokenize } = require('./tokenizer');

const withoutLocations = ({ loc, start, end, ...token }) => token;

test('tokenizes text, tags, attributes, and expressions', () => {
  const input = '<div class="hero" hidden>{user.name}</div>';
  const tokens = tokenize(input);

  assert.deepEqual(tokens.map(withoutLocations), [
    {
      type: 'OpenTag',
      name: 'div',
      attributes: [
        { name: 'class', value: 'hero' },
        { name: 'hidden', value: null }
      ]
    },
    { type: 'Expression', value: 'user.name' },
    { type: 'CloseTag', name: 'div' }
  ]);
  assert.deepEqual(tokens[0].loc.start, { offset: 0, line: 1, column: 1 });
  assert.equal(tokens[2].end, input.length);
});

test('tokenizes self-closing tags and nested braces in expressions', () => {
  const tokens = tokenize('Hi <img src="logo.png" /> {format({ active: true })}!');

  assert.deepEqual(tokens.map(withoutLocations), [
    { type: 'Text', value: 'Hi ' },
    {
      type: 'SelfClosingTag',
      name: 'img',
      attributes: [{ name: 'src', value: 'logo.png' }]
    },
    { type: 'Text', value: ' ' },
    { type: 'Expression', value: 'format({ active: true })' },
    { type: 'Text', value: '!' }
  ]);
});

test('tokenizes brace-delimited event directive values', () => {
  const tokens = tokenize('<button on:click={handleClick}>Click</button>');

  assert.deepEqual(tokens.map(withoutLocations), [
    {
      type: 'OpenTag',
      name: 'button',
      attributes: [{ name: 'on:click', value: 'handleClick' }]
    },
    { type: 'Text', value: 'Click' },
    { type: 'CloseTag', name: 'button' }
  ]);
});

test('marks brace-delimited regular attributes as dynamic', () => {
  const [token] = tokenize('<input value={name} checked={isSelected}>');

  assert.deepEqual(token.attributes, [
    { name: 'value', value: 'name', dynamic: true },
    { name: 'checked', value: 'isSelected', dynamic: true }
  ]);
});

test('reports malformed tags and expressions', () => {
  assert.throws(() => tokenize('<div'), /Unclosed tag at 1:5/);
  assert.throws(() => tokenize('{count'), /Unclosed expression at 1:7/);
  assert.throws(() => tokenize('<div id=main>'), /Expected a quoted or brace-delimited value for attribute 'id'/);
});
test('scans wizz:style content as raw text so CSS braces never reach the expression lexer', () => {
  const source = '<wizz:style>h2 { font-size: 30px; content: "{not an expression}"; }</wizz:style><main>Hi</main>';
  const tokens = tokenize(source);

  assert.deepEqual(tokens.map(withoutLocations), [
    { type: 'OpenTag', name: 'wizz:style', attributes: [] },
    { type: 'Text', value: 'h2 { font-size: 30px; content: "{not an expression}"; }' },
    { type: 'CloseTag', name: 'wizz:style' },
    { type: 'OpenTag', name: 'main', attributes: [] },
    { type: 'Text', value: 'Hi' },
    { type: 'CloseTag', name: 'main' }
  ]);
});

test('scans a plain style element as raw text and keeps its content for the parser to reject', () => {
  const tokens = tokenize('<style>p { color: red; }</style>');

  assert.deepEqual(tokens.map(withoutLocations), [
    { type: 'OpenTag', name: 'style', attributes: [] },
    { type: 'Text', value: 'p { color: red; }' },
    { type: 'CloseTag', name: 'style' }
  ]);
});

test('raw text ends only at the matching end tag', () => {
  const tokens = tokenize('<wizz:style>a { b: c; }</wizz:style>');
  assert.equal(tokens[1].value, 'a { b: c; }');

  // A similar-but-different end tag does not exit the mode.
  assert.throws(() => tokenize('<wizz:style>a { b: c; }</style>'), /Unclosed tag/);
});

test('script and wizz:style with boolean attributes still enter raw text', () => {
  const scriptTokens = tokenize('<script defer>let a = 1;</script>');
  assert.deepEqual(scriptTokens.map(withoutLocations), [
    { type: 'OpenTag', name: 'script', attributes: [{ name: 'defer', value: null }] },
    { type: 'Text', value: 'let a = 1;' },
    { type: 'CloseTag', name: 'script' }
  ]);

  const styleTokens = tokenize('<wizz:style media="all">p {}</wizz:style>');
  assert.equal(styleTokens[1].value, 'p {}');
});

test('reports an unclosed raw text element at the end of input', () => {
  assert.throws(() => tokenize('<main><wizz:style>p { color: red; }</main>'), /Unclosed tag at 1:43/);
});

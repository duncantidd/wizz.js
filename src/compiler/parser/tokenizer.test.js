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

test('reports malformed tags and expressions', () => {
  assert.throws(() => tokenize('<div'), /Unclosed tag at 1:5/);
  assert.throws(() => tokenize('{count'), /Unclosed expression at 1:7/);
  assert.throws(() => tokenize('<div id=main>'), /Expected a quoted or brace-delimited value for attribute 'id'/);
});
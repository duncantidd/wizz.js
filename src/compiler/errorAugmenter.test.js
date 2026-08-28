const assert = require('node:assert/strict');
const test = require('node:test');
const { augmentErrorWithFile } = require('./errorAugmenter');

test('qualifies source locations in the error message with the file path', () => {
  const error = new SyntaxError('Mismatched closing tag. Expected </div>, found </span> at 1:6.');
  const augmented = augmentErrorWithFile(error, 'src/pages/Home.wizz');

  assert.strictEqual(augmented, error);
  assert.strictEqual(augmented.filePath, 'src/pages/Home.wizz');
  assert.equal(
    augmented.message,
    'Mismatched closing tag. Expected </div>, found </span> at src/pages/Home.wizz:1:6.'
  );
});

test('qualifies mid-message expression locations and every occurrence', () => {
  assert.equal(
    augmentErrorWithFile(new SyntaxError('Template Expression Error at 1:7 - Unexpected token Number'), 'App.wizz').message,
    'Template Expression Error at App.wizz:1:7 - Unexpected token Number'
  );
  assert.equal(
    augmentErrorWithFile(new SyntaxError('Broken at 1:2 and again at 3:4.'), 'App.wizz').message,
    'Broken at App.wizz:1:2 and again at App.wizz:3:4.'
  );
});

test('prefixes errors that carry no source location', () => {
  const error = augmentErrorWithFile(new SyntaxError('Component template must contain a root element.'), 'Empty.wizz');

  assert.equal(error.message, 'Empty.wizz: Component template must contain a root element.');
});

test('returns errors untouched without a usable file path', () => {
  assert.equal(augmentErrorWithFile(new SyntaxError('Unclosed tag at 1:1.'), '').filePath, undefined);
  assert.equal(augmentErrorWithFile(new SyntaxError('Unclosed tag at 1:1.'), 42).filePath, undefined);
  assert.equal(
    augmentErrorWithFile(new SyntaxError('Unclosed tag at 1:1.'), null).message,
    'Unclosed tag at 1:1.'
  );
});

test('leaves non-error thrown values alone', () => {
  assert.strictEqual(augmentErrorWithFile('boom', 'App.wizz'), 'boom');
  assert.strictEqual(augmentErrorWithFile(null, 'App.wizz'), null);
});

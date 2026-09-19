const assert = require('node:assert/strict');
const test = require('node:test');
const { augmentErrorWithFile, buildDiagnosticRecord } = require('./errorAugmenter');

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

test('includes the failing source line as a code frame', () => {
  const error = augmentErrorWithFile(
    new SyntaxError('Mismatched closing tag. Expected </div>, found </span> at 2:6.'),
    'src/pages/Home.wizz',
    '<main>\n<div></span>\n</main>'
  );

  assert.equal(error.sourceExcerpt, '<div></span>');
  assert.equal(
    error.codeFrame,
    'src/pages/Home.wizz:2:6\n2 | <div></span>\n  |      ^'
  );
  assert.equal(
    error.message,
    'Mismatched closing tag. Expected </div>, found </span> at src/pages/Home.wizz:2:6.\n\n' +
      'src/pages/Home.wizz:2:6\n2 | <div></span>\n  |      ^'
  );
});

test('does not add a code frame when no source location is available', () => {
  const error = augmentErrorWithFile(
    new SyntaxError('Component template must contain a root element.'),
    'Empty.wizz',
    'Only text'
  );

  assert.equal(error.sourceExcerpt, undefined);
  assert.equal(error.codeFrame, undefined);
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

test('stamps structured line and column beside the prose location', () => {
  const error = augmentErrorWithFile(
    new SyntaxError('Mismatched closing tag. Expected </div>, found </span> at 2:6.'),
    'src/pages/Home.wizz',
    '<main>\n<div></span>\n</main>'
  );

  assert.equal(error.line, 2);
  assert.equal(error.column, 6);
  assert.equal(typeof error.line, 'number');
  assert.equal(typeof error.column, 'number');
});

test('stamps structured line and column even without a file path', () => {
  const error = augmentErrorWithFile(new SyntaxError('Unclosed expression at 3:12.'));

  assert.equal(error.filePath, undefined);
  assert.equal(error.line, 3);
  assert.equal(error.column, 12);
  assert.equal(error.message, 'Unclosed expression at 3:12.');
});

test('leaves errors without a source locator unstamped', () => {
  const error = augmentErrorWithFile(
    new SyntaxError('Component template must contain a root element.'),
    'Empty.wizz'
  );

  assert.equal(error.line, undefined);
  assert.equal(error.column, undefined);
});

test('re-augmentation is a no-op, so the first stamp wins', () => {
  const error = augmentErrorWithFile(new SyntaxError('Unclosed tag at 1:1.'), 'App.wizz');
  const reaugmented = augmentErrorWithFile(error, 'Other.wizz');

  assert.strictEqual(reaugmented, error);
  assert.equal(reaugmented.filePath, 'App.wizz');
  assert.equal(reaugmented.line, 1);
  assert.equal(reaugmented.column, 1);
  assert.equal(reaugmented.message.includes('Other.wizz'), false);
});

test('a diagnostic record carries the code, severity, and location', () => {
  const record = buildDiagnosticRecord(
    Object.assign(new SyntaxError('Unclosed tag <p> starting at 1:7.'), { code: 'WIZZ-P022' }),
    'src/App.wizz',
    '<main><p>hi'
  );

  assert.deepEqual(record, {
    code: 'WIZZ-P022',
    severity: 'error',
    message: 'Unclosed tag <p> starting at src/App.wizz:1:7.',
    file: 'src/App.wizz',
    line: 1,
    column: 7
  });
});

test('a diagnostic record stays single-line and JSON-friendly', () => {
  const record = buildDiagnosticRecord(
    new SyntaxError('Mismatched closing tag. Expected </div>, found </span> at 2:6.'),
    'src/pages/Home.wizz',
    '<main>\n<div></span>\n</main>'
  );

  assert.equal(record.message.includes('\n'), false);
  assert.equal(record.message.includes('^'), false);
  // The thrown error keeps its frame for human output.
  assert.equal(record.message, 'Mismatched closing tag. Expected </div>, found </span> at src/pages/Home.wizz:2:6.');
});

test('a record for an uncoded failure carries a null code', () => {
  const record = buildDiagnosticRecord(new TypeError('Component source must be a string.'));

  assert.equal(record.code, null);
  assert.equal(record.severity, 'error');
  assert.equal(record.file, null);
  assert.equal(record.line, null);
  assert.equal(record.column, null);
});

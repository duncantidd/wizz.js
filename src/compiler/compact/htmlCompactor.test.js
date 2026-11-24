const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { compactHtml } = require('./htmlCompactor');

test('collapses text whitespace and removes comments', () => {
  assert.equal(
    compactHtml('<!DOCTYPE html>\n<html>\n  <head>\n    <!-- a note -->\n    <title>  My   App </title>\n  </head>\n</html>\n'),
    '<!DOCTYPE html>\n<html>\n<head>\n<title> My App </title>\n</head>\n</html>\n'
  );
});

test('whitespace between inline elements is collapsed, never removed', () => {
  assert.equal(compactHtml('<p><b>a</b>   <i>b</i></p>'), '<p><b>a</b> <i>b</i></p>');
  assert.equal(compactHtml('<p><b>a</b><i>b</i></p>'), '<p><b>a</b><i>b</i></p>');
});

test('two whitespace runs around a removed comment merge into one', () => {
  assert.equal(compactHtml('a  <!-- x -->  b'), 'a b');
  assert.equal(compactHtml('a  <!-- x -->\n  b'), 'a\nb');
  assert.equal(compactHtml('a<!-- x -->b'), 'ab');
});

test('tags and attributes are copied byte for byte', () => {
  const source = '<div   id="app"  data-x=\'a  >  b\'  hidden></div>\n<a href=foo/ >x</a>';
  assert.equal(compactHtml(source), source);
  // The SSR hosts replace these exact strings.
  const shell = '<head>\n  <meta charset="utf-8">\n</head>\n<body>\n  <div id="app"></div>\n</body>';
  const compacted = compactHtml(shell);
  assert.ok(compacted.includes('<div id="app"></div>'));
  assert.ok(compacted.includes('</head>'));
});

test('raw-text and whitespace-significant elements are left unchanged', () => {
  const pre = '<pre>  a\n    b  <!-- kept --></pre>';
  assert.equal(compactHtml(`<body>\n  ${pre}\n</body>`), `<body>\n${pre}\n</body>`);
  const textarea = '<textarea name="t">  x\n\n  y  </textarea>';
  assert.equal(compactHtml(textarea), textarea);
  const script = '<script type="module">\n  const a = "</p>";  // <!-- not a comment -->\n  if (a < b) {}\n</script>';
  assert.equal(compactHtml(script), script);
  const style = '<style>\n  a  >  b { color: red }\n</style>';
  assert.equal(compactHtml(style), style);
  for (const name of ['listing', 'xmp', 'iframe', 'noembed', 'noframes']) {
    const element = `<${name}>  a  <b>  </b>  </${name}>`;
    assert.equal(compactHtml(element), element, name);
  }
});

test('application/wizz-state payloads are byte-identical', () => {
  const state = '<script type="application/wizz-state">{"text":"  spaced  <\\/script>","n":1}</script>';
  assert.equal(compactHtml(`<body>\n  <div id="app"></div>\n  ${state}\n</body>`), `<body>\n<div id="app"></div>\n${state}\n</body>`);
});

test('closing-tag matching is case-insensitive and requires a tag boundary', () => {
  assert.equal(compactHtml('<SCRIPT>  a  </SCRIPT>  x'), '<SCRIPT>  a  </SCRIPT> x');
  // `</scripts>` does not close a script.
  assert.equal(compactHtml('<script>  </scripts>  </script>'), '<script>  </scripts>  </script>');
  // A trailing slash does not self-close a raw-text element.
  assert.equal(compactHtml('<script src="x.js" />  a  </script>'), '<script src="x.js" />  a  </script>');
});

test('plaintext runs to the end of the document unchanged', () => {
  assert.equal(compactHtml('<p>  a  </p><plaintext>  <b>  x  '), '<p> a </p><plaintext>  <b>  x  ');
});

test('conditional comments and Wizz markers survive', () => {
  assert.equal(compactHtml('<!--[if IE]><p>x</p><![endif]-->'), '<!--[if IE]><p>x</p><![endif]-->');
  assert.equal(compactHtml('<!--wizz:head-start--><!--wizz:head-end-->'), '<!--wizz:head-start--><!--wizz:head-end-->');
});

test('a bare < in text is text', () => {
  assert.equal(compactHtml('<p>1  <  2</p>'), '<p>1 < 2</p>');
});

test('CDATA sections are copied unchanged', () => {
  assert.equal(compactHtml('<svg><![CDATA[  a  ]]></svg>'), '<svg><![CDATA[  a  ]]></svg>');
});

test('the repository shell compacts and keeps its load-bearing markup', () => {
  const shell = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'index.html'), 'utf8');
  const compacted = compactHtml(shell);
  assert.ok(compacted.length < shell.length);
  assert.ok(compacted.includes('<div id="app"></div>'));
  assert.ok(compacted.includes('</head>'));
  assert.equal(compactHtml(compacted), compacted);
});

test('malformed input fails with a located SyntaxError', () => {
  const cases = [
    ['<p>a</p>\n<!-- open', 'Unterminated comment', 2, 1],
    ['<div\n  class="x"', 'Unterminated tag', 1, 1],
    ['<p>\n  <div class="a>b', 'Unterminated tag', 2, 3],
    ['<body>\n<script>let a = 1;', 'Unterminated <script> element', 2, 1],
    ['<pre>x', 'Unterminated <pre> element', 1, 1],
    ['<svg><![CDATA[ x', 'Unterminated CDATA section', 1, 6]
  ];
  for (const [source, message, line, column] of cases) {
    assert.throws(() => compactHtml(source), (error) => {
      assert.ok(error instanceof SyntaxError);
      assert.ok(error.message.startsWith(message), error.message);
      assert.equal(error.line, line, source);
      assert.equal(error.column, column, source);
      return true;
    });
  }
  assert.throws(() => compactHtml(undefined), TypeError);
});

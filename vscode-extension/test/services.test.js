const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createBuildArguments,
  findComponentImport,
  getPageRoute,
  parseCompilerDiagnostic,
  parseCompilerDiagnostics
} = require('../services');

test('parses file-qualified compiler diagnostics', () => {
  const diagnostic = parseCompilerDiagnostic(
    'Compilation failed for /project/src/App.wizz: /project/src/App.wizz:4:9\n\n4 | <main>\n  |         ^'
  );

  assert.deepEqual(diagnostic, {
    filePath: '/project/src/App.wizz',
    line: 4,
    column: 9,
    message: '/project/src/App.wizz:4:9\n\n4 | <main>\n  |         ^'
  });
});

test('ignores compiler output without a source location', () => {
  assert.equal(parseCompilerDiagnostic('Input directory does not exist.'), null);
});

test('preserves every compiler error and its code frame', () => {
  const diagnostics = parseCompilerDiagnostics([
    'Compilation failed for /project/src/App.wizz: Unexpected token at /project/src/App.wizz:4:9',
    '',
    '/project/src/App.wizz:4:9',
    '4 | <main>',
    '  |         ^',
    'Compilation failed for /project/src/pages/Home.wizz: Unexpected token at /project/src/pages/Home.wizz:2:1'
  ].join('\n'));

  assert.equal(diagnostics.length, 2);
  assert.match(diagnostics[0].message, /4 \| <main>/);
  assert.equal(diagnostics[1].filePath, '/project/src/pages/Home.wizz');
});

test('resolves default Wizz component imports', () => {
  assert.equal(
    findComponentImport("import Counter from '../components/Counter.wizz';", '/project/src/pages/Home.wizz'),
    path.resolve('/project/src/components/Counter.wizz')
  );
  assert.equal(findComponentImport('<Counter />', '/project/src/pages/Home.wizz'), null);
});

test('derives documented routes from Wizz page paths', () => {
  assert.equal(getPageRoute('/project', '/project/src/App.wizz'), '/');
  assert.equal(getPageRoute('/project', '/project/src/pages/index.wizz'), '/');
  assert.equal(getPageRoute('/project', '/project/src/pages/Admin/Users.wizz'), '/admin/users');
  assert.equal(getPageRoute('/project', '/project/src/components/Counter.wizz'), null);
});

test('creates stable CLI command details', () => {
  assert.deepEqual(createBuildArguments('build', '/project'), { command: 'build', arguments: [], cwd: '/project' });
  assert.deepEqual(createBuildArguments('dev', '/project'), { command: 'dev', arguments: [], cwd: '/project' });
  assert.throws(() => createBuildArguments('serve', '/project'), /Unsupported Wizz command/);
});
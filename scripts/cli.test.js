const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { parseCommand, runCli } = require('./cli');

const projectRoot = path.join(__dirname, '..');

function createTemporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-cli-test-'));
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, 'utf8');
}

test('parses build and dev commands', () => {
  assert.deepEqual(parseCommand(['build']), { command: 'build', argumentsList: [], json: false });
  assert.deepEqual(parseCommand(['build', 'components', 'output']), {
    command: 'build',
    argumentsList: ['components', 'output'],
    json: false
  });
  assert.deepEqual(parseCommand(['dev']), { command: 'dev', argumentsList: [], json: false });
});

test('strips the build --json flag from any argument position', () => {
  assert.deepEqual(parseCommand(['build', '--json']), { command: 'build', argumentsList: [], json: true });
  assert.deepEqual(parseCommand(['build', 'src', 'dist', '--json']), {
    command: 'build',
    argumentsList: ['src', 'dist'],
    json: true
  });
  // A build unknown-flag stays positional and fails the directory count.
  assert.throws(() => parseCommand(['build', '--json', 'src']), /both <input-directory> and <output-directory>/);
});

test('rejects unknown commands and incomplete command arguments', () => {
  assert.throws(() => parseCommand([]), /wizz build/);
  assert.throws(() => parseCommand(['preview']), /wizz dev/);
  assert.throws(() => parseCommand(['build', 'src']), /both <input-directory> and <output-directory>/);
  assert.throws(() => parseCommand(['dev', '--port', '3001']), /Dev does not accept arguments/);
});

test('uses src and dist defaults for build', () => {
  const calls = [];

  assert.equal(runCli(['build'], { build(argv, logger) { calls.push({ argv, logger }); return 0; } }), 0);
  assert.deepEqual(calls[0].argv, ['src', 'dist']);
});

test('passes explicit build directories through unchanged', () => {
  const calls = [];

  assert.equal(runCli(['build', 'components', 'public'], { build(argv) { calls.push(argv); return 1; } }), 1);
  assert.deepEqual(calls, [['components', 'public']]);
});

test('starts the existing development server through the dev command', () => {
  const calls = [];
  const logger = { log() {}, error() {} };

  assert.equal(runCli(['dev'], {
    logger,
    startDev(options) {
      calls.push(options);
      return { listen() { calls.push('listen'); return Promise.resolve(); } };
    }
  }), 0);
  assert.deepEqual(calls, [{ projectDirectory: process.cwd(), logger }, 'listen']);
});

test('runs a default project build from the command working directory', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  writeFile(path.join(projectDirectory, 'src', 'App.wizz'), '<main><p>Ready</p></main>');

  const result = spawnSync(process.execPath, [path.join(projectRoot, 'scripts', 'cli.js'), 'build'], {
    cwd: projectDirectory,
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Compiled .*src[/\\]App\.wizz -> .*dist[/\\]App\.js/);
  assert.equal(fs.existsSync(path.join(projectDirectory, 'dist', 'App.js')), true);
});

test('returns a non-zero exit code for build failures through the public command', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  writeFile(path.join(projectDirectory, 'src', 'Broken.wizz'), '<main><p>Broken</main>');

  const result = spawnSync(process.execPath, [path.join(projectRoot, 'scripts', 'cli.js'), 'build'], {
    cwd: projectDirectory,
    encoding: 'utf8'
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Compilation failed for .*Broken\.wizz:/);
});

test('returns an actionable error when dev cannot find the document shell', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  writeFile(path.join(projectDirectory, 'src', 'App.wizz'), '<main><p>Ready</p></main>');

  const result = spawnSync(process.execPath, [path.join(projectRoot, 'scripts', 'cli.js'), 'dev'], {
    cwd: projectDirectory,
    encoding: 'utf8'
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Project document shell is missing: .*dist[/\\]index\.html/);
});

test('the managed installer copies the CLI runtime and installs a wizz launcher', (t) => {
  const homeDirectory = createTemporaryDirectory();
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(homeDirectory, { recursive: true, force: true }));
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  writeFile(path.join(projectDirectory, 'src', 'App.wizz'), '<main><p>Ready</p></main>');

  // --local: the working-tree install. The default (no-argument) mode
  // downloads a release tarball and is exercised by install-cli.test.js
  // against a local tarball, never the network.
  const result = spawnSync('bash', [path.join(projectRoot, 'scripts', 'install-cli.sh'), '--local'], {
    cwd: projectDirectory,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: homeDirectory,
      XDG_DATA_HOME: path.join(homeDirectory, 'data'),
      XDG_BIN_HOME: path.join(homeDirectory, 'bin')
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Installed Wizz \d+\.\d+\.\d+ to/);
  const installedDirectory = path.join(homeDirectory, 'data', 'wizz');
  const launcher = path.join(homeDirectory, 'bin', 'wizz');
  assert.equal(fs.existsSync(path.join(installedDirectory, 'build.js')), true);
  assert.equal(fs.existsSync(path.join(installedDirectory, 'src', 'compiler', 'index.js')), true);
  assert.equal(fs.existsSync(launcher), true);

  const build = spawnSync(launcher, ['build'], { cwd: projectDirectory, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  assert.equal(fs.existsSync(path.join(projectDirectory, 'dist', 'App.js')), true);
});
test('passes the build --json flag through to the build', () => {
  const calls = [];

  assert.equal(runCli(['build', 'components', 'public', '--json'], { build(argv) { calls.push(argv); return 0; } }), 0);
  assert.deepEqual(calls, [['components', 'public', '--json']]);

  calls.length = 0;
  assert.equal(runCli(['build', '--json'], { build(argv) { calls.push(argv); return 0; } }), 0);
  assert.deepEqual(calls, [['src', 'dist', '--json']]);
});

test('prints a machine-parsable envelope and exits non-zero for json build failures', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  writeFile(path.join(projectDirectory, 'src', 'App.wizz'), '<main><p>Ready</p></main>');
  writeFile(path.join(projectDirectory, 'src', 'Broken.wizz'), '<main><p>Broken</main>');

  const result = spawnSync(process.execPath, [path.join(projectRoot, 'scripts', 'cli.js'), 'build', '--json'], {
    cwd: projectDirectory,
    encoding: 'utf8'
  });

  assert.equal(result.status, 1, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.format, 'wizz-build-diagnostics@1');
  assert.equal(envelope.ok, false);
  assert.equal(envelope.diagnostics.length, 1);
  assert.equal(envelope.diagnostics[0].code, 'WIZZ-P018');
  assert.equal(envelope.diagnostics[0].file, 'Broken.wizz');
  assert.equal(envelope.diagnostics[0].line, 1);
  assert.equal(envelope.diagnostics[0].column, 16);
  assert.deepEqual(envelope.files.map((entry) => entry.file), ['App.wizz', 'Broken.wizz']);
  // stdout carries only the envelope: no prose may corrupt machine parsing.
  assert.equal(result.stdout.trim().startsWith('{'), true);
});

test('prints a clean envelope and exits zero for a successful json build', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  writeFile(path.join(projectDirectory, 'src', 'App.wizz'), '<main><p>Ready</p></main>');

  const result = spawnSync(process.execPath, [path.join(projectRoot, 'scripts', 'cli.js'), 'build', 'src', 'dist', '--json'], {
    cwd: projectDirectory,
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true);
  assert.deepEqual(envelope.diagnostics, []);
  assert.deepEqual(envelope.files, [{ file: 'App.wizz', serverRenderable: true }]);
  assert.equal(fs.existsSync(path.join(projectDirectory, 'dist', 'App.js')), true);
});

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
  assert.deepEqual(parseCommand(['build']), { command: 'build', argumentsList: [] });
  assert.deepEqual(parseCommand(['build', 'components', 'output']), {
    command: 'build',
    argumentsList: ['components', 'output']
  });
  assert.deepEqual(parseCommand(['dev']), { command: 'dev', argumentsList: [] });
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

  const result = spawnSync('bash', [path.join(projectRoot, 'scripts', 'install-cli.sh')], {
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
  assert.match(result.stdout, /Installed Wizz to/);
  const installedDirectory = path.join(homeDirectory, 'data', 'wizz');
  const launcher = path.join(homeDirectory, 'bin', 'wizz');
  assert.equal(fs.existsSync(path.join(installedDirectory, 'build.js')), true);
  assert.equal(fs.existsSync(path.join(installedDirectory, 'src', 'compiler', 'index.js')), true);
  assert.equal(fs.existsSync(launcher), true);

  const build = spawnSync(launcher, ['build'], { cwd: projectDirectory, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  assert.equal(fs.existsSync(path.join(projectDirectory, 'dist', 'App.js')), true);
});
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { parseCommand, runCli, USAGE } = require('./cli');

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
  assert.throws(() => parseCommand(['init', 'a', 'b']), /Init accepts at most one \[directory\]/);
  assert.throws(() => parseCommand(['--version', 'extra']), /Version does not accept arguments/);
});

test('parses the init command with its directory and --force flag', () => {
  assert.deepEqual(parseCommand(['init']), { command: 'init', argumentsList: [], json: false, force: false });
  assert.deepEqual(parseCommand(['init', 'my-app']), { command: 'init', argumentsList: ['my-app'], json: false, force: false });
  assert.deepEqual(parseCommand(['init', 'my-app', '--force']), { command: 'init', argumentsList: ['my-app'], json: false, force: true });
  assert.deepEqual(parseCommand(['init', '--force', 'my-app']), { command: 'init', argumentsList: ['my-app'], json: false, force: true });
});

test('parses the update command and rejects any arguments', () => {
  assert.deepEqual(parseCommand(['update']), { command: 'update', argumentsList: [], json: false, force: false });
  assert.throws(() => parseCommand(['update', '--force']), /The update command does not accept arguments/);
  // --json is a build flag: here it is a mistake, not a directory.
  assert.throws(() => parseCommand(['update', '--json']), /The update command does not accept arguments/);
  assert.match(USAGE, /wizz update/);
});

test('the version command prints the compiler and contract version triple', () => {
  const lines = [];
  const logger = { log: (message) => lines.push(message), error() {} };

  assert.equal(runCli(['--version'], { logger }), 0);
  assert.equal(lines.length, 1);
  assert.match(
    lines[0],
    /^wizz \d+\.\d+\.\d+ \(compiler \d+\.\d+\.\d+, syntax \d+\.\d+\.\d+, output \d+\.\d+\.\d+\)$/
  );

  lines.length = 0;
  assert.equal(runCli(['version'], { logger }), 0);
  assert.equal(lines.length, 1);
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

test('the update command resolves through the async command path', async () => {
  const lines = [];
  const logger = { log: (message) => lines.push(message), error() {} };

  const result = runCli(['update'], {
    logger,
    update: async () => ({ status: 'current', fromVersion: '1.10.1', toVersion: '1.10.1', dataDirectory: '/data/wizz' })
  });

  // The release-backed commands return a promise of an exit code.
  assert.equal(typeof result.then, 'function');
  assert.equal(await result, 0);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /Resolving the latest Wizz release from GitHub\.\.\./);
  assert.match(lines[1], /Wizz 1\.10\.1 is already up to date\./);

  lines.length = 0;
  await runCli(['update'], {
    logger,
    update: async () => ({ status: 'updated', fromVersion: '1.10.0', toVersion: '1.10.1', dataDirectory: '/data/wizz' })
  });
  assert.match(lines[1], /Updated Wizz 1\.10\.0 to 1\.10\.1 \(\/data\/wizz\)\./);

  lines.length = 0;
  await runCli(['update'], {
    logger,
    update: async () => ({ status: 'newer-local', fromVersion: '1.11.0', toVersion: '1.11.0', latestVersion: '1.10.1', dataDirectory: '/data/wizz' })
  });
  assert.match(lines[1], /newer than the latest release \(1\.10\.1\); refusing to downgrade\./);
});

test('a rejected async command surfaces its message and a non-zero exit code through runCli', async () => {
  const errors = [];
  const logger = { log() {}, error: (message) => errors.push(message) };

  const result = runCli(['update'], {
    logger,
    update: async () => { throw new Error('the release could not be resolved'); }
  });

  await assert.rejects(result, /could not be resolved/);
  // The rejected promise is what runCli returns; the entry block is what
  // turns it into exit code 1 (covered by the subprocess tests below).
  assert.equal(errors.length, 0);
});

test('e2e: update fails offline-deterministically without a managed installation', (t) => {
  const homeDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(homeDirectory, { recursive: true, force: true }));
  const env = { ...process.env, HOME: homeDirectory };
  delete env.XDG_DATA_HOME;
  delete env.XDG_BIN_HOME;
  delete env.WIZZ_INSTALL_REPOSITORY;

  const result = spawnSync(process.execPath, [path.join(projectRoot, 'scripts', 'cli.js'), 'update'], {
    env,
    encoding: 'utf8'
  });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /No managed Wizz installation/);
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

test('e2e: init scaffolds, serves the version triple, refuses re-init, and builds cleanly', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  const cli = path.join(projectRoot, 'scripts', 'cli.js');

  const initResult = spawnSync(process.execPath, [cli, 'init', '.'], { cwd: projectDirectory, encoding: 'utf8' });
  assert.equal(initResult.status, 0, initResult.stderr);
  assert.match(initResult.stdout, /Created index\.html/);
  assert.match(initResult.stdout, /Created App\.css/);
  assert.match(initResult.stdout, /Created src\/App\.wizz/);
  assert.match(initResult.stdout, /Created src\/pages\/Home\.wizz/);
  assert.match(initResult.stdout, /Created src\/components\/Counter\.wizz/);
  assert.match(initResult.stdout, /Created src\/components\/Card\.wizz/);
  assert.match(initResult.stdout, /Next: run `wizz dev` to start editing\./);

  // Scaffolded projects are never overwritten, even in-place.
  const reinit = spawnSync(process.execPath, [cli, 'init', '--force'], { cwd: projectDirectory, encoding: 'utf8' });
  assert.equal(reinit.status, 1);
  assert.match(reinit.stderr, /Refusing to overwrite existing file\(s\): README\.md, index\.html/);

  const versionResult = spawnSync(process.execPath, [cli, '--version'], { cwd: projectDirectory, encoding: 'utf8' });
  assert.equal(versionResult.status, 0, versionResult.stderr);
  assert.match(versionResult.stdout, /^wizz \d+\.\d+\.\d+ \(compiler \d+\.\d+\.\d+, syntax \d+\.\d+\.\d+, output \d+\.\d+\.\d+\)$/m);

  const buildResult = spawnSync(process.execPath, [cli, 'build'], { cwd: projectDirectory, encoding: 'utf8' });
  assert.equal(buildResult.status, 0, buildResult.stderr);
  assert.equal(fs.existsSync(path.join(projectDirectory, 'dist', 'App.js')), true);
  assert.equal(fs.existsSync(path.join(projectDirectory, 'dist', 'pages', 'Home.js')), true);
});

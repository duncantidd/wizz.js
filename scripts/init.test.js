const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const TEMPLATES = require('./initTemplates.js');
const { initProject } = require('./init.js');

const EXPECTED_PATHS = [
  'index.html',
  'src/App.wizz',
  'src/pages/Home.wizz',
  'src/components/Counter.wizz'
];

function createTemporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-init-test-'));
}

test('scaffolds the complete starter project and reports exactly what it created', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));

  // The target itself does not exist yet: init creates it (and parents).
  const target = path.join(projectDirectory, 'apps', 'my-site');
  const created = initProject(target);

  assert.deepEqual(created, EXPECTED_PATHS);
  for (const templatePath of EXPECTED_PATHS) {
    assert.equal(
      fs.readFileSync(path.join(target, templatePath), 'utf8'),
      TEMPLATES[templatePath]
    );
  }
});

test('scaffolds into an existing empty directory', (t) => {
  const target = createTemporaryDirectory();
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));

  assert.deepEqual(initProject(target), EXPECTED_PATHS);
});

test('refuses a non-empty target directory without --force and writes nothing', (t) => {
  const target = createTemporaryDirectory();
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  fs.writeFileSync(path.join(target, 'notes.txt'), 'keep me', 'utf8');

  assert.throws(() => initProject(target), /Directory is not empty: .* Pass --force to scaffold into it/);
  // The refusal is all-or-nothing: the uninvolved file is untouched and no
  // template was written.
  assert.equal(fs.readFileSync(path.join(target, 'notes.txt'), 'utf8'), 'keep me');
  assert.deepEqual(fs.readdirSync(target), ['notes.txt']);
});

test('--force scaffolds into a non-empty directory without conflicts', (t) => {
  const target = createTemporaryDirectory();
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  fs.writeFileSync(path.join(target, '.gitignore'), 'dist/\n', 'utf8');

  assert.deepEqual(initProject(target, { force: true }), EXPECTED_PATHS);
  assert.equal(fs.readFileSync(path.join(target, '.gitignore'), 'utf8'), 'dist/\n');
});

test('refuses to overwrite an existing template file, even with --force, and writes nothing', (t) => {
  const target = createTemporaryDirectory();
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  const existing = path.join(target, 'src', 'App.wizz');
  fs.mkdirSync(path.dirname(existing), { recursive: true });
  fs.writeFileSync(existing, '// custom work worth keeping', 'utf8');

  for (const force of [false, true]) {
    assert.throws(
      () => initProject(target, { force }),
      force
        ? /Refusing to overwrite existing file\(s\): src\/App\.wizz\./
        : /Directory is not empty: .* Pass --force to scaffold into it/
    );
  }

  // Nothing else was created despite the conflict appearing mid-list.
  assert.equal(fs.readFileSync(existing, 'utf8'), '// custom work worth keeping');
  assert.equal(fs.existsSync(path.join(target, 'index.html')), false);
});

test('refuses a target path that exists and is a file', (t) => {
  const target = createTemporaryDirectory();
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  const filePath = path.join(target, 'a-file');
  fs.writeFileSync(filePath, 'x', 'utf8');

  assert.throws(() => initProject(filePath), /The target path exists and is not a directory/);
});

test('refuses a non-string target', () => {
  assert.throws(() => initProject(undefined), /non-empty string/);
  assert.throws(() => initProject(''), /non-empty string/);
});

// The done-when: a scaffolded project serves both routes with server markup
// and delivered state, and builds cleanly. Client-side hydration itself is
// covered by the hydration suite's DOM tests; this asserts the server side
// of the contract the scaffold promises.
test('the scaffolded project serves / and /home with SSR state and builds cleanly', async (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  initProject(projectDirectory);

  const { startDevelopmentServer } = require('./dev.js');
  const logger = { log() {}, error() {} };
  // Port 0: an OS-assigned port keeps the test collision-free.
  const developmentServer = startDevelopmentServer({ projectDirectory, logger, port: 0 });
  t.after(() => developmentServer.close());
  const url = await developmentServer.listen();

  try {
    const rootResponse = await fetch(`${url}/`);
    assert.match(rootResponse.headers.get('content-type') || '', /text\/html/);
    const rootHtml = await rootResponse.text();
    assert.match(rootHtml, /Hello, Wizz!/);
    // The Counter server-renders its persisted default — the interpolation
    // is delimited by comment nodes so hydration can map the text node. The
    // delivered state script is what hydration adopts instead of falling
    // back.
    assert.match(rootHtml, /Clicked <!-- -->0<!-- --> times/);
    assert.match(rootHtml, /application\/wizz-state/);

    const homeResponse = await fetch(`${url}/home`);
    assert.match(homeResponse.headers.get('content-type') || '', /text\/html/);
    const homeHtml = await homeResponse.text();
    assert.match(homeHtml, /The Home page/);
    assert.match(homeHtml, /application\/wizz-state/);
  } finally {
    await developmentServer.close();
  }

  const { buildProject } = require('../build.js');
  const buildResult = buildProject(
    path.join(projectDirectory, 'src'),
    path.join(projectDirectory, 'dist'),
    logger
  );
  assert.deepEqual(buildResult, { compiledCount: 3, failedCount: 0 });

  const manifest = fs.readFileSync(path.join(projectDirectory, 'dist', 'runtime', 'routes.js'), 'utf8');
  assert.match(manifest, /"routePath": "\/"/);
  assert.match(manifest, /"routePath": "\/home"/);
  assert.match(manifest, /"serverModulePath": "\.\.\/App\.server\.js"/);
  assert.match(manifest, /"serverModulePath": "\.\.\/pages\/Home\.server\.js"/);

  // Component styles were extracted and linked from the copied shell.
  const stylesheet = fs.readFileSync(path.join(projectDirectory, 'dist', 'app.css'), 'utf8');
  assert.match(stylesheet, /\/\* App\.wizz \*\//);
  assert.match(stylesheet, /\/\* pages\/Home\.wizz \*\//);
  assert.match(stylesheet, /\/\* components\/Counter\.wizz \*\//);
  const shell = fs.readFileSync(path.join(projectDirectory, 'dist', 'index.html'), 'utf8');
  assert.match(shell, /href="\/app\.css"/);
});

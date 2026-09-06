const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createSourceSnapshot, startDevelopmentServer, watchSourceFiles } = require('../scripts/dev');

function createTemporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-dev-test-'));
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, 'utf8');
}

function createLogger() {
  return {
    errors: [],
    messages: [],
    error(message) { this.errors.push(message); },
    log(message) { this.messages.push(message); }
  };
}

test('builds before serving generated output and supplies SPA fallback', async (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  writeFile(path.join(projectDirectory, 'index.html'), '<div id="app"></div>');
  fs.mkdirSync(path.join(projectDirectory, 'src'), { recursive: true });
  writeFile(path.join(projectDirectory, 'App.css'), 'main { color: red; }');
  writeFile(path.join(projectDirectory, 'src', 'App.wizz'), '<main><p>Ready</p></main>');

  const logger = createLogger();
  const developmentServer = startDevelopmentServer({
    projectDirectory,
    port: 0,
    logger
  });
  t.after(() => developmentServer.close());
  const url = await developmentServer.listen();
  assert.match(url, /^http:\/\/localhost:\d+$/);
  assert.ok(logger.messages.includes(`Wizz development server running at ${url}`));

  const shell = await fetch(`${url}/Home`);
  assert.equal(shell.status, 200);
  assert.equal(await shell.text(), '<div id="app"></div>');

  const component = await fetch(`${url}/App.js`);
  assert.equal(component.status, 200);
  assert.match(await component.text(), /^export default function mountComponent\(target\)/m);

  const stylesheet = await fetch(`${url}/App.css`);
  assert.equal(stylesheet.status, 200);
  assert.equal(await stylesheet.text(), 'main { color: red; }');

  const missingAsset = await fetch(`${url}/missing.js`);
  assert.equal(missingAsset.status, 404);
});

test('rebuilds the project when a .wizz source change is observed', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  writeFile(path.join(projectDirectory, 'index.html'), '<div id="app"></div>');
  fs.mkdirSync(path.join(projectDirectory, 'src'), { recursive: true });
  const listeners = [];
  const builds = [];
  const logger = createLogger();
  const watcher = { close() {} };

  const developmentServer = startDevelopmentServer({
    projectDirectory,
    logger,
    build(inputDirectory, outputDirectory) {
      fs.mkdirSync(outputDirectory, { recursive: true });
      builds.push({ inputDirectory, outputDirectory });
      return { compiledCount: 1, failedCount: 0 };
    },
    watch(directory, options, listener) {
      listeners.push({ directory, options, listener });
      return watcher;
    }
  });

  assert.equal(builds.length, 1);
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0].options.recursive, true);
  listeners[0].listener('change', 'pages/Home.wizz');
  assert.equal(builds.length, 2);
  assert.match(logger.messages[0], /Rebuilding after change: pages\/Home\.wizz/);

  listeners[0].listener('change', 'App.css');
  assert.equal(builds.length, 2);
  return developmentServer.close();
});

test('polling watcher rebuilds after a source file changes without a native watch event', (t) => {
  const inputDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(inputDirectory, { recursive: true, force: true }));
  const sourceFile = path.join(inputDirectory, 'pages', 'Home.wizz');
  writeFile(sourceFile, '<main>Before</main>');
  const callbacks = [];
  const changes = [];
  let clearedTimer;
  const watcher = watchSourceFiles(inputDirectory, (eventType, fileName) => changes.push({ eventType, fileName }), {
    watch(directory, options, listener) {
      callbacks.push({ directory, options, listener });
      return { close() {} };
    },
    setInterval(callback) {
      callbacks.push({ poll: callback });
      return 'poller';
    },
    clearInterval(timer) { clearedTimer = timer; }
  });

  assert.equal(createSourceSnapshot(inputDirectory).includes('Home.wizz'), true);
  writeFile(sourceFile, '<main>After the polling rebuild</main>');
  callbacks[1].poll();
  assert.deepEqual(changes, [{ eventType: 'change', fileName: 'source files' }]);
  watcher.close();
  assert.equal(clearedTimer, 'poller');
});

test('reports component compilation failures while continuing to start the server', async (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  writeFile(path.join(projectDirectory, 'index.html'), '<div id="app"></div>');
  writeFile(path.join(projectDirectory, 'src', 'App.wizz'), '<main><p>Broken</main>');
  const logger = createLogger();

  const developmentServer = startDevelopmentServer({ projectDirectory, port: 0, logger });
  t.after(() => developmentServer.close());
  await developmentServer.listen();

  assert.equal(logger.errors.length, 2);
  assert.match(logger.errors[0], /Compilation failed for .*App\.wizz:/);
  assert.equal(logger.errors[1], 'Build completed with 1 failed component(s).');
});

test('rejects a project without an index.html document shell before serving', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  writeFile(path.join(projectDirectory, 'src', 'App.wizz'), '<main><p>Ready</p></main>');

  assert.throws(
    () => startDevelopmentServer({ projectDirectory, logger: createLogger() }),
    new RegExp(`Project document shell is missing: ${path.join(projectDirectory, 'dist', 'index.html').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
  );
});
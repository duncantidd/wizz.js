const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { buildProject } = require('../build');

function createTemporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-runtime-test-'));
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, 'utf8');
}

function createDocument(target) {
  return {
    getElementById(id) {
      return id === 'app' ? target : null;
    },
    createElement(name) {
      return { name, childNodes: [], appendChild(node) { this.childNodes.push(node); } };
    },
    createTextNode(nodeValue) {
      return { nodeValue };
    }
  };
}

async function waitFor(condition, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(condition(), 'expected condition was not met before the timeout');
}

function createWindow(pathname = '/') {
  const listeners = new Map();

  const window = {
    history: {
      entries: [],
      pushState(state, title, path) {
        this.entries.push({ state, title, path });
        window.location.pathname = path;
      }
    },
    location: { pathname },
    addEventListener(eventName, listener) {
      listeners.set(eventName, listener);
    },
    removeEventListener(eventName, listener) {
      if (listeners.get(eventName) === listener) listeners.delete(eventName);
    },
    dispatchPopState(path) {
      this.location.pathname = path;
      listeners.get('popstate')?.();
    }
  };

  return window;
}

async function loadRouter(outputDirectory) {
  const routerPath = path.join(outputDirectory, 'runtime', 'router.js');
  return import(`${pathToFileURL(routerPath).href}?test=${Date.now()}-${Math.random()}`);
}

test('the document shell supplies #app and loads only the emitted runtime entry', () => {
  const documentShell = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

  assert.match(documentShell, /<div id="app"><\/div>/);
  assert.match(documentShell, /<script type="module" src="\/runtime\/main\.js"><\/script>/);
  assert.doesNotMatch(documentShell, /import mountComponent/);
});

test('runtime entry builds lazy routes from the generated page manifest', () => {
  const runtimeEntry = fs.readFileSync(path.join(__dirname, '..', 'src', 'runtime', 'main.js'), 'utf8');

  assert.match(runtimeEntry, /import \{ pageModules \} from '\.\/routes\.js';/);
  assert.match(runtimeEntry, /pageModules\.map\(\(\{ routePath, modulePath \}.*import\(modulePath\)/);
  assert.doesNotMatch(runtimeEntry, /import\('\.\.\/pages\/Home\.js'\)/);
});

test('emitted runtime mounts the compiled App component into #app', async (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));

  const inputDirectory = path.join(projectDirectory, 'src');
  const outputDirectory = path.join(projectDirectory, 'dist');
  writeFile(path.join(inputDirectory, 'App.wizz'), '<main><p>Ready</p></main>');
  buildProject(inputDirectory, outputDirectory, { log() {}, error() {} });
  writeFile(path.join(outputDirectory, 'package.json'), '{"type":"module"}');

  const target = { childNodes: [], appendChild(node) { this.childNodes.push(node); } };
  const originalDocument = global.document;
  const originalWindow = global.window;
  global.document = createDocument(target);
  global.window = createWindow();
  t.after(() => { global.document = originalDocument; });
  t.after(() => { global.window = originalWindow; });

  await import(`${pathToFileURL(path.join(outputDirectory, 'runtime', 'main.js')).href}?test=${Date.now()}`);
  await waitFor(() => target.childNodes.length === 1);

  assert.equal(target.childNodes.length, 1);
  assert.equal(target.childNodes[0].name, 'main');
});

test('generated routes load only the page selected by the current path', async (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));

  const inputDirectory = path.join(projectDirectory, 'src');
  const outputDirectory = path.join(projectDirectory, 'dist');
  writeFile(path.join(inputDirectory, 'App.wizz'), '<main><p>Home</p></main>');
  writeFile(
    path.join(inputDirectory, 'pages', 'Deferred.wizz'),
    '<script>document.loadedDeferredPage = true;</script><main><p>Deferred</p></main>'
  );
  buildProject(inputDirectory, outputDirectory, { log() {}, error() {} });
  writeFile(path.join(outputDirectory, 'package.json'), '{"type":"module"}');

  const target = { childNodes: [], appendChild(node) { this.childNodes.push(node); }, removeChild() {} };
  const originalDocument = global.document;
  const originalWindow = global.window;
  global.document = createDocument(target);
  global.window = createWindow('/');
  t.after(() => { global.document = originalDocument; });
  t.after(() => { global.window = originalWindow; });

  await import(`${pathToFileURL(path.join(outputDirectory, 'runtime', 'main.js')).href}?test=${Date.now()}`);
  await waitFor(() => target.childNodes.length === 1);
  assert.equal(global.document.loadedDeferredPage, undefined);

  global.window.dispatchPopState('/deferred');
  await waitFor(() => global.document.loadedDeferredPage === true);
  assert.equal(target.childNodes[0].name, 'main');
});

test('generated nested routes mount on a direct browser load', async (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));

  const inputDirectory = path.join(projectDirectory, 'src');
  const outputDirectory = path.join(projectDirectory, 'dist');
  writeFile(path.join(inputDirectory, 'App.wizz'), '<main><p>App</p></main>');
  writeFile(path.join(inputDirectory, 'pages', 'Admin', 'Users.wizz'), '<main><p>Users</p></main>');
  buildProject(inputDirectory, outputDirectory, { log() {}, error() {} });
  writeFile(path.join(outputDirectory, 'package.json'), '{"type":"module"}');

  const target = { childNodes: [], appendChild(node) { this.childNodes.push(node); }, removeChild() {} };
  const originalDocument = global.document;
  const originalWindow = global.window;
  global.document = createDocument(target);
  global.window = createWindow('/admin/users');
  t.after(() => { global.document = originalDocument; });
  t.after(() => { global.window = originalWindow; });

  await import(`${pathToFileURL(path.join(outputDirectory, 'runtime', 'main.js')).href}?test=${Date.now()}`);
  await waitFor(() => target.childNodes.length === 1);

  assert.equal(target.childNodes[0].name, 'main');
  assert.equal(target.childNodes[0].childNodes[0].childNodes[0].nodeValue, 'Users');
});

test('emitted runtime reports a missing #app mount target', async (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));

  const inputDirectory = path.join(projectDirectory, 'src');
  const outputDirectory = path.join(projectDirectory, 'dist');
  writeFile(path.join(inputDirectory, 'App.wizz'), '<main><p>Ready</p></main>');
  buildProject(inputDirectory, outputDirectory, { log() {}, error() {} });
  writeFile(path.join(outputDirectory, 'package.json'), '{"type":"module"}');

  const originalDocument = global.document;
  const originalWindow = global.window;
  global.document = createDocument(null);
  global.window = createWindow();
  t.after(() => { global.document = originalDocument; });
  t.after(() => { global.window = originalWindow; });

  await assert.rejects(
    import(`${pathToFileURL(path.join(outputDirectory, 'runtime', 'main.js')).href}?test=${Date.now()}`),
    /Wizz could not find mount target "#app"\./
  );
});

test('router resolves the current path and destroys the prior component before mounting another', async (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));

  const outputDirectory = path.join(projectDirectory, 'dist');
  buildProject(path.join(__dirname, '..', 'src'), outputDirectory, { log() {}, error() {} });
  writeFile(path.join(outputDirectory, 'package.json'), '{"type":"module"}');

  const mounted = [];
  const destroyed = [];
  const target = { appendChild() {}, removeChild() {} };
  const document = createDocument(target);
  const window = createWindow('/');
  const { createRouter } = await loadRouter(outputDirectory);
  const router = createRouter({
    routes: {
      '/': async () => ({ default: () => {
        mounted.push('home');
        return { destroy() { destroyed.push('home'); } };
      } }),
      '/about': async () => ({ default: () => {
        mounted.push('about');
        return { destroy() { destroyed.push('about'); } };
      } })
    },
    target,
    window,
    document
  });

  await router.render();
  await router.navigate('/about');

  assert.deepEqual(mounted, ['home', 'about']);
  assert.deepEqual(destroyed, ['home']);
  assert.deepEqual(window.history.entries, [{ state: {}, title: '', path: '/about' }]);
  router.destroy();
  assert.deepEqual(destroyed, ['home', 'about']);
});

test('router renders a not-found view and rerenders through browser history', async (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));

  const outputDirectory = path.join(projectDirectory, 'dist');
  buildProject(path.join(__dirname, '..', 'src'), outputDirectory, { log() {}, error() {} });
  writeFile(path.join(outputDirectory, 'package.json'), '{"type":"module"}');

  const target = {
    childNodes: [],
    appendChild(node) { this.childNodes.push(node); },
    removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); }
  };
  const document = createDocument(target);
  const window = createWindow('/missing');
  const { createRouter } = await loadRouter(outputDirectory);
  let aboutMountedCount = 0;
  let aboutDestroyedCount = 0;
  const router = createRouter({
    routes: {
      '/': async () => ({ default: () => ({ destroy() {} }) }),
      '/about': async () => ({ default: () => {
        aboutMountedCount++;
        return { destroy() { aboutDestroyedCount++; } };
      } })
    },
    target,
    window,
    document
  });

  await router.render();
  assert.equal(target.childNodes[0].name, 'main');
  assert.equal(target.childNodes[0].textContent, 'Not found');

  window.dispatchPopState('/about');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(target.childNodes, []);
  assert.equal(aboutMountedCount, 1);

  router.destroy();
  assert.equal(aboutDestroyedCount, 1);
});
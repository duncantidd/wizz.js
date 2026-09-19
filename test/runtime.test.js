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

function createDocument(target, options = {}) {
  // Optional wizz-state delivery script, exactly as the dev server places it
  // beside the mount point; remove() marks it consumed.
  const stateScript = options.stateScriptText === undefined ? null : {
    textContent: options.stateScriptText,
    removed: false,
    remove() { this.removed = true; }
  };

  // The document head with the surface the generated head helpers use:
  // parentNode-tracked insertion/removal and the title[data-wizz-head]
  // ownership probe. appendChild moves an already-attached node, matching
  // real DOM behaviour when a claim relocates a delivered node.
  const head = {
    childNodes: [],
    get firstChild() { return this.childNodes[0] ?? null; },
    appendChild(node) {
      const existing = this.childNodes.indexOf(node);
      if (existing !== -1) this.childNodes.splice(existing, 1);
      this.childNodes.push(node);
      node.parentNode = this;
      return node;
    },
    insertBefore(node, referenceNode) {
      const existing = this.childNodes.indexOf(node);
      if (existing !== -1) this.childNodes.splice(existing, 1);
      if (referenceNode == null) {
        this.childNodes.push(node);
        node.parentNode = this;
        return node;
      }
      const index = this.childNodes.indexOf(referenceNode);
      if (index === -1) throw new Error('insertBefore reference node not found');
      this.childNodes.splice(index, 0, node);
      node.parentNode = this;
      return node;
    },
    removeChild(node) {
      const index = this.childNodes.indexOf(node);
      if (index !== -1) this.childNodes.splice(index, 1);
      node.parentNode = null;
      return node;
    },
    querySelectorAll(selector) {
      const match = /^([a-zA-Z]+)\[([a-zA-Z-]+)\]$/.exec(selector);
      if (!match) throw new Error(`Unsupported test selector: ${selector}`);
      return this.childNodes.filter(
        (node) => node.nodeType === 1
          && node.nodeName === match[1].toUpperCase()
          && node.attributes?.[match[2]] !== undefined
      );
    }
  };

  return {
    stateScript,
    head,
    getElementById(id) {
      return id === 'app' ? target : null;
    },
    createElement(name) {
      return {
        name,
        nodeName: name.toUpperCase(),
        nodeType: 1,
        attributes: {},
        childNodes: [],
        setAttribute(attributeName, value) { this.attributes[attributeName] = String(value); },
        removeAttribute(attributeName) { delete this.attributes[attributeName]; },
        getAttribute(attributeName) { return this.attributes[attributeName] ?? null; },
        get textContent() {
          if (this.childNodes.some((node) => node.nodeType === 1)) return '';
          return this.childNodes.map((node) => (node.nodeType === 3 ? node.nodeValue : '')).join('');
        },
        set textContent(value) { this.childNodes.length = 0; this.childNodes.push({ nodeType: 3, nodeValue: value }); },
        appendChild(node) { this.childNodes.push(node); },
        addEventListener() {},
        removeEventListener() {}
      };
    },
    createTextNode(nodeValue) {
      return { nodeType: 3, nodeValue };
    },
    createComment(nodeValue) {
      return { nodeType: 8, nodeValue };
    },
    querySelector(selector) {
      if (selector === 'script[type="application/wizz-state"]') {
        return stateScript && !stateScript.removed ? stateScript : null;
      }
      return null;
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
  assert.match(runtimeEntry, /pageModules\s*\n\s*\.filter\(\(\{ hydratableModulePath \}\) => hydratableModulePath\)/);
  assert.match(runtimeEntry, /createRouter\(\{ routes, hydratableRoutes, target, window, document \}\)/);
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

function createSplicingTarget() {
  return {
    childNodes: [],
    appendChild(node) { this.childNodes.push(node); },
    removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); }
  };
}

async function loadRouterForTest(t) {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  const outputDirectory = path.join(projectDirectory, 'dist');
  buildProject(path.join(__dirname, '..', 'src'), outputDirectory, { log() {}, error() {} });
  // The emitted modules are ESM while the repo package is CommonJS: Node 18
  // has no module-syntax detection, so the output directory needs its own
  // module type before any dynamic import (the same line pins every other
  // buildProject call in this file).
  writeFile(path.join(outputDirectory, 'package.json'), '{"type":"module"}');
  return loadRouter(outputDirectory);
}

test('router hydrates delivered markup on the first render and mounts fresh afterwards', async (t) => {
  const { createRouter } = await loadRouterForTest(t);

  const serverNode = { name: 'server-main' };
  const target = createSplicingTarget();
  target.appendChild(serverNode);
  const document = createDocument(target, { stateScriptText: '{"count":5}' });
  const window = createWindow('/');

  const mountCalls = [];
  const destroyed = [];
  let hydration = null;
  const router = createRouter({
    routes: {
      '/': async () => ({ default: (mountTarget) => {
        mountCalls.push('home');
        mountTarget.appendChild({ name: 'client-main' });
        return { destroy() { destroyed.push('client'); } };
      } }),
      '/about': async () => ({ default: () => {
        mountCalls.push('about');
        return { destroy() { destroyed.push('about'); } };
      } })
    },
    hydratableRoutes: {
      '/': async () => ({
        hydrateComponent(hydrateTarget, props, state) {
          hydration = { props, state, adoptedNodes: [...hydrateTarget.childNodes] };
          return { destroy() { destroyed.push('hydrated'); } };
        }
      })
    },
    target,
    window,
    document
  });

  await router.render();

  // The hydratable build adopted the delivered markup; the standard client
  // module never mounted, the state reached the hydrator, and the delivery
  // script was consumed.
  assert.ok(hydration, 'the router hydrated instead of mounting');
  assert.deepEqual(hydration.props, {});
  assert.deepEqual(hydration.state, { count: 5 });
  assert.deepEqual(hydration.adoptedNodes, [serverNode]);
  assert.deepEqual(mountCalls, []);
  assert.equal(document.stateScript.removed, true);
  assert.deepEqual(target.childNodes, [serverNode]);

  await router.navigate('/about');
  assert.deepEqual(mountCalls, ['about']);
  assert.deepEqual(destroyed, ['hydrated']);

  router.destroy();
  assert.deepEqual(destroyed, ['hydrated', 'about']);
});

test('router clears server markup and mounts when no hydratable build exists', async (t) => {
  const { createRouter } = await loadRouterForTest(t);

  const target = createSplicingTarget();
  const serverNode = { name: 'server-main' };
  target.appendChild(serverNode);
  const document = createDocument(target, { stateScriptText: '{"count":5}' });
  const window = createWindow('/');

  const router = createRouter({
    routes: {
      '/': async () => ({ default: (mountTarget) => {
        mountTarget.appendChild({ name: 'client-main' });
        return { destroy() {} };
      } })
    },
    target,
    window,
    document
  });

  await router.render();

  // The fresh client root would otherwise appear beside the delivered markup.
  assert.deepEqual(target.childNodes.map((node) => node.name), ['client-main']);
  assert.equal(document.stateScript.removed, true);
});

test('router drops markup for an unreadable state payload and mounts fresh', async (t) => {
  const { createRouter } = await loadRouterForTest(t);

  const target = createSplicingTarget();
  target.appendChild({ name: 'server-main' });
  const document = createDocument(target, { stateScriptText: 'not-json{{' });
  const window = createWindow('/');

  let hydrateCalls = 0;
  const router = createRouter({
    routes: {
      '/': async () => ({ default: (mountTarget) => {
        mountTarget.appendChild({ name: 'client-main' });
        return { destroy() {} };
      } })
    },
    hydratableRoutes: {
      '/': async () => ({
        hydrateComponent() {
          hydrateCalls++;
          return { destroy() {} };
        }
      })
    },
    target,
    window,
    document
  });

  await router.render();

  assert.deepEqual(target.childNodes.map((node) => node.name), ['client-main']);
  assert.equal(hydrateCalls, 0);
  assert.equal(document.stateScript.removed, true);
});

test('router drops unclaimed server markup before rendering not-found', async (t) => {
  const { createRouter } = await loadRouterForTest(t);

  const target = createSplicingTarget();
  target.appendChild({ name: 'server-main' });
  const document = createDocument(target, { stateScriptText: '{"count":5}' });
  const window = createWindow('/missing');

  const router = createRouter({
    routes: {
      '/': async () => ({ default: () => ({ destroy() {} }) })
    },
    target,
    window,
    document
  });

  await router.render();

  // The delivered markup must not sit beside the not-found message.
  assert.equal(target.childNodes.length, 1);
  assert.equal(target.childNodes[0].textContent, 'Not found');
  assert.equal(document.stateScript.removed, true);
});

test('a hydration render superseded by a newer render abandons instead of double-mounting', async (t) => {
  const { createRouter } = await loadRouterForTest(t);

  const target = createSplicingTarget();
  const document = createDocument(target, { stateScriptText: '{"count":5}' });
  const window = createWindow('/');

  let resolveHydratableImport;
  let hydrateCalls = 0;
  const mountCalls = [];
  const router = createRouter({
    routes: {
      '/': async () => ({ default: () => {
        mountCalls.push('/');
        return { destroy() {} };
      } }),
      '/about': async () => ({ default: () => {
        mountCalls.push('/about');
        return { destroy() {} };
      } })
    },
    hydratableRoutes: {
      '/': () => new Promise((resolve) => { resolveHydratableImport = resolve; })
    },
    target,
    window,
    document
  });

  // First render stalls inside the hydratable import; a popstate lands and
  // mounts /about before the hydration can proceed.
  const firstRender = router.render();
  await new Promise((resolve) => setImmediate(resolve));
  window.dispatchPopState('/about');
  await new Promise((resolve) => setImmediate(resolve));

  resolveHydratableImport({
    hydrateComponent() {
      hydrateCalls++;
      return { destroy() {} };
    }
  });
  await firstRender;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(hydrateCalls, 0);
  assert.deepEqual(mountCalls, ['/about']);
  assert.equal(target.childNodes.length, 0);
});
test('navigation swaps component head titles and removes the previous page head nodes', async (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));

  const inputDirectory = path.join(projectDirectory, 'src');
  const outputDirectory = path.join(projectDirectory, 'dist');
  writeFile(path.join(inputDirectory, 'App.wizz'), '<wizz:head><title>Home</title></wizz:head><main><h1>Home</h1></main>');
  writeFile(
    path.join(inputDirectory, 'pages', 'About.wizz'),
    '<wizz:head><title>About</title><meta name="page" content="about"></wizz:head><main><p>About</p></main>'
  );
  buildProject(inputDirectory, outputDirectory, { log() {}, error() {} });
  writeFile(path.join(outputDirectory, 'package.json'), '{"type":"module"}');

  const target = {
    childNodes: [],
    appendChild(node) { this.childNodes.push(node); },
    removeChild(node) { const index = this.childNodes.indexOf(node); if (index !== -1) this.childNodes.splice(index, 1); }
  };
  const originalDocument = global.document;
  const originalWindow = global.window;
  const document = createDocument(target);
  global.document = document;
  global.window = createWindow('/');
  t.after(() => { global.document = originalDocument; });
  t.after(() => { global.window = originalWindow; });

  await import(`${pathToFileURL(path.join(outputDirectory, 'runtime', 'main.js')).href}?test=${Date.now()}`);
  await waitFor(() => target.childNodes.length === 1);

  // Mounting Home applied its head: one owned title in the document head.
  const headTitles = () => document.head.childNodes
    .filter((node) => node.nodeName === 'TITLE')
    .map((node) => node.textContent);
  assert.deepEqual(headTitles(), ['Home']);
  const homeTitle = document.head.childNodes.find((node) => node.nodeName === 'TITLE');
  assert.equal(homeTitle.attributes['data-wizz-head'], 'h1');
  // buildProject compiles with absolute paths, so the loc is file-qualified.
  assert.match(homeTitle.attributes['data-wizz-loc'], /\/src\/App\.wizz:1:12$/);

  global.window.dispatchPopState('/about');
  await waitFor(() => headTitles()[0] === 'About');

  // The Home title node was removed by the destroy cascade; the About title
  // and its meta now own the head.
  assert.deepEqual(headTitles(), ['About']);
  assert.deepEqual(document.head.childNodes.map((node) => node.nodeName), ['META', 'TITLE']);
  assert.equal(document.head.childNodes.find((node) => node.nodeName === 'META').attributes['content'], 'about');
});

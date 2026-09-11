const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const {
  createRequestHandler,
  createSourceSnapshot,
  readRouteTable,
  startDevelopmentServer,
  watchSourceFiles
} = require('../scripts/dev');

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

async function flushUpdates() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// The document shell a real project uses, so sibling placement of the state
// script relative to the mount point and the runtime entry is observable.
const DOCUMENT_SHELL = [
  '<!DOCTYPE html>',
  '<html lang="en">',
  '<head>',
  '  <meta charset="UTF-8">',
  '  <title>Dev</title>',
  '  <link rel="stylesheet" href="./App.css">',
  '</head>',
  '<body>',
  '  <div id="app"></div>',
  '  <script type="module" src="/runtime/main.js"></script>',
  '</body>',
  '</html>',
  ''
].join('\n');

// Single-line template: delivered markup preserves template whitespace
// verbatim, so a flattened fixture keeps string and child-index assertions
// free of inter-element whitespace text nodes.
const COUNTER_PAGE = '<script>let count = 0; function increment() { count += 1; }</script><main><h1>Home</h1><p>Count: {count}</p><button on:click={increment}>Add</button></main>';

// Compact counting DOM shim (same idiom as test/hydration.test.js) with just
// the surface hydration needs: nodeType, uppercased tagName,
// firstElementChild, comment nodes, element-level removeChild, and counted
// node creation so tests can prove adoption instead of recreation.
function createHydrationDocument() {
  const elements = new Map();
  const metrics = { elements: 0, textNodes: 0, textWrites: 0, addedListeners: 0 };

  function makeTextNode(initialValue) {
    return {
      nodeType: 3,
      _nodeValue: initialValue,
      get nodeValue() { return this._nodeValue; },
      set nodeValue(value) {
        metrics.textWrites++;
        this._nodeValue = value;
      }
    };
  }

  function makeElement(name) {
    return {
      nodeType: 1,
      name,
      tagName: name.toUpperCase(),
      attributes: {},
      childNodes: [],
      listeners: {},
      setAttribute(attributeName, value) {
        this.attributes[attributeName] = String(value);
        if (attributeName === 'data-wizz-id') {
          elements.set(`[data-wizz-id="${value}"]`, this);
        }
      },
      getAttribute(attributeName) {
        return this.attributes[attributeName] ?? null;
      },
      querySelector(selector) {
        return elements.get(selector) || null;
      },
      get firstElementChild() {
        return this.childNodes.find((node) => node.nodeType === 1) ?? null;
      },
      appendChild(node) { this.childNodes.push(node); },
      removeChild(node) {
        const index = this.childNodes.indexOf(node);
        if (index !== -1) this.childNodes.splice(index, 1);
      },
      addEventListener(eventName, listener) {
        this.listeners[eventName] = listener;
        metrics.addedListeners++;
      },
      removeEventListener(eventName, listener) {
        if (this.listeners[eventName] === listener) {
          delete this.listeners[eventName];
        }
      },
      dispatchEvent(eventName) {
        this.listeners[eventName]?.({ type: eventName, target: this });
      }
    };
  }

  return {
    metrics,
    makeElement,
    makeTextNode,
    createElement(name) {
      metrics.elements++;
      return makeElement(name);
    },
    createTextNode(initialValue) {
      metrics.textNodes++;
      return makeTextNode(initialValue);
    },
    createComment(nodeValue) {
      return { nodeType: 8, nodeValue };
    },
    querySelector(selector) {
      return elements.get(selector) || null;
    }
  };
}

// Parses delivered markup into shim DOM, mirroring the browser-facing rules
// hydration relies on: preserved whitespace text, decoded entities, comment
// markers kept as nodes, uppercased tagName.
function parseDeliveredMarkup(markup, document) {
  const decodeEntities = (value) => value.replace(
    /&(amp|lt|gt|quot);/g,
    (_, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"' })[entity]
  );
  const voidElements = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const root = { name: null, childNodes: [] };
  const stack = [root];
  let index = 0;

  while (index < markup.length) {
    const parent = stack[stack.length - 1];

    if (markup.startsWith('<!--', index)) {
      const end = markup.indexOf('-->', index + 4);
      if (end === -1) throw new Error('Unterminated comment in delivered markup');
      parent.childNodes.push({ nodeType: 8, nodeValue: markup.slice(index + 4, end) });
      index = end + 3;
      continue;
    }

    if (markup.startsWith('</', index)) {
      const end = markup.indexOf('>', index);
      if (end === -1) throw new Error('Unterminated closing tag in delivered markup');
      const closing = markup.slice(index + 2, end).trim();
      if (parent.name !== closing) throw new Error(`Mismatched closing tag </${closing}> in delivered markup`);
      stack.pop();
      index = end + 1;
      continue;
    }

    if (markup[index] === '<') {
      const end = markup.indexOf('>', index);
      if (end === -1) throw new Error('Unterminated tag in delivered markup');
      const rawTag = markup.slice(index + 1, end);
      const name = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(rawTag)[1];
      const selfClosing = rawTag.endsWith('/');
      const element = document.makeElement(name);
      const attributeSource = rawTag.slice(name.length).replace(/\/$/, '');
      const attributePattern = /([^\s=/]+)(?:="([^"]*)")?/g;
      let match;
      while ((match = attributePattern.exec(attributeSource)) !== null) {
        if (match[0] === '') break;
        element.setAttribute(match[1], decodeEntities(match[2] ?? ''));
      }
      parent.childNodes.push(element);
      if (!selfClosing && !voidElements.has(name.toLowerCase())) stack.push(element);
      index = end + 1;
      continue;
    }

    const nextTag = markup.indexOf('<', index);
    const text = markup.slice(index, nextTag === -1 ? markup.length : nextTag);
    parent.childNodes.push(document.makeTextNode(decodeEntities(text)));
    index = nextTag === -1 ? markup.length : nextTag;
  }

  if (stack.length > 1) throw new Error(`Unclosed tag <${stack[stack.length - 1].name}> in delivered markup`);
  return root.childNodes;
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
  assert.match(await component.text(), /^export default function mountComponent\(target, props = \{\}\)/m);

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

test('serves server-rendered route documents with the state script as a sibling', async (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  writeFile(path.join(projectDirectory, 'index.html'), DOCUMENT_SHELL);
  fs.mkdirSync(path.join(projectDirectory, 'src'), { recursive: true });
  writeFile(path.join(projectDirectory, 'src', 'App.wizz'), COUNTER_PAGE);

  const developmentServer = startDevelopmentServer({ projectDirectory, port: 0, logger: createLogger() });
  t.after(() => developmentServer.close());
  const url = await developmentServer.listen();

  const response = await fetch(`${url}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html; charset=utf-8$/);
  const document = await response.text();

  // The mount point already contains the rendered markup — a browser sees the
  // page without executing any component code. The reactive <p> carries its
  // data-wizz-id, and the event directive is skipped entirely.
  assert.match(document, /<div id="app"><main><h1>Home<\/h1><p data-wizz-id="1">Count: <!-- -->0<\/p><button>Add<\/button><\/main><\/div>/);
  // The state script is a sibling of the mount point, ahead of the runtime
  // entry the document boots through.
  assert.match(document, /<\/div>\n  <script type="application\/wizz-state">\{"count":0\}<\/script>\n  <script type="module" src="\/runtime\/main\.js"><\/script>/);

  const hydrateBuild = await fetch(`${url}/App.hydrate.js`);
  assert.equal(hydrateBuild.status, 200);
  assert.match(hydrateBuild.headers.get('content-type'), /^text\/javascript/);
  assert.match(await hydrateBuild.text(), /^export function hydrateComponent\(target, props = \{\}, state = null\)/m);

  const serverBuild = await fetch(`${url}/App.server.js`);
  assert.equal(serverBuild.status, 200);
  assert.match(await serverBuild.text(), /^export function renderComponent\(props = \{\}\)/m);
});

test('renders fresh server modules after a watch rebuild (no stale cache)', async (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  writeFile(path.join(projectDirectory, 'index.html'), DOCUMENT_SHELL);
  fs.mkdirSync(path.join(projectDirectory, 'src'), { recursive: true });
  writeFile(path.join(projectDirectory, 'src', 'App.wizz'), COUNTER_PAGE);

  const watchListeners = [];
  const developmentServer = startDevelopmentServer({
    projectDirectory,
    port: 0,
    logger: createLogger(),
    watch(directory, options, listener) {
      watchListeners.push(listener);
      return { close() {} };
    }
  });
  t.after(() => developmentServer.close());
  const url = await developmentServer.listen();

  const before = await (await fetch(`${url}/`)).text();
  assert.match(before, /Count: <!-- -->0<\/p>/);

  writeFile(path.join(projectDirectory, 'src', 'App.wizz'), COUNTER_PAGE.replace('let count = 0;', 'let count = 7;'));
  watchListeners[0]('change', 'App.wizz');

  const after = await (await fetch(`${url}/`)).text();
  assert.match(after, /Count: <!-- -->7<\/p>/);
  assert.doesNotMatch(after, /Count: <!-- -->0<\/p>/);
});

test('an eligibility flip stops server rendering despite stale build artifacts', async (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  writeFile(path.join(projectDirectory, 'index.html'), DOCUMENT_SHELL);
  fs.mkdirSync(path.join(projectDirectory, 'src'), { recursive: true });
  writeFile(path.join(projectDirectory, 'src', 'App.wizz'), COUNTER_PAGE);

  const logger = createLogger();
  const watchListeners = [];
  const developmentServer = startDevelopmentServer({
    projectDirectory,
    port: 0,
    logger,
    watch(directory, options, listener) {
      watchListeners.push(listener);
      return { close() {} };
    }
  });
  t.after(() => developmentServer.close());
  const url = await developmentServer.listen();
  assert.match(await (await fetch(`${url}/`)).text(), /<div id="app"><main>/);

  // The edit makes the page ineligible: the imported component has no
  // server-renderable build to vouch for. The rebuild leaves the previous
  // build's server module on disk (builds never clean dist), so the manifest
  // — not the filesystem — must decide whether a route server-renders.
  writeFile(
    path.join(projectDirectory, 'src', 'App.wizz'),
    '<script>\nimport Counter from "./Counter.wizz";\n</script><main><Counter /></main>'
  );
  watchListeners[0]('change', 'App.wizz');
  assert.equal(fs.existsSync(path.join(projectDirectory, 'dist', 'App.server.js')), true);
  assert.match(logger.messages[logger.messages.length - 1], /Note: server rendering skipped for .*App\.wizz/);

  const response = await fetch(`${url}/`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), DOCUMENT_SHELL);
});

test('a render failure falls back to streaming the plain document shell', async (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  // No <div id="app"></div> mount point: the shell check only asserts
  // existence, so the render fails at delivery time and must fall back.
  writeFile(path.join(projectDirectory, 'index.html'), '<div id="root"></div>');
  fs.mkdirSync(path.join(projectDirectory, 'src'), { recursive: true });
  writeFile(path.join(projectDirectory, 'src', 'App.wizz'), COUNTER_PAGE);

  const logger = createLogger();
  const developmentServer = startDevelopmentServer({ projectDirectory, port: 0, logger });
  t.after(() => developmentServer.close());
  const url = await developmentServer.listen();

  const response = await fetch(`${url}/`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '<div id="root"></div>');
  assert.equal(logger.errors.length, 1);
  assert.match(logger.errors[0], /^Server rendering failed for \/:/u);
});

test('readRouteTable parses the generated manifest and tolerates damage', (t) => {
  const dist = createTemporaryDirectory();
  t.after(() => fs.rmSync(dist, { recursive: true, force: true }));

  assert.equal(readRouteTable(dist), null);

  writeFile(path.join(dist, 'runtime', 'routes.js'), '// Generated by Wizz.\nexport const pageModules = [corrupted');
  assert.equal(readRouteTable(dist), null);

  writeFile(path.join(dist, 'runtime', 'routes.js'), [
    '// Generated by Wizz. Edits will be overwritten.',
    'export const pageModules = [',
    '  {',
    '    "filePath": "App.wizz",',
    '    "modulePath": "../App.js",',
    '    "routePath": "/",',
    '    "serverModulePath": "../App.server.js",',
    '    "hydratableModulePath": "../App.hydrate.js"',
    '  },',
    '  {',
    '    "filePath": "pages/About.wizz",',
    '    "modulePath": "../pages/About.js",',
    '    "routePath": "/about",',
    '    "serverModulePath": null,',
    '    "hydratableModulePath": null',
    '  }',
    '];',
    ''
  ].join('\n'));

  const routeTable = readRouteTable(dist);
  assert.ok(routeTable instanceof Map);
  assert.deepEqual(routeTable.get('/'), {
    routePath: '/',
    serverModulePath: path.join(dist, 'App.server.js'),
    hydratableModulePath: path.join(dist, 'App.hydrate.js')
  });
  assert.deepEqual(routeTable.get('/about'), {
    routePath: '/about',
    serverModulePath: null,
    hydratableModulePath: null
  });
});

test('delivers a document whose markup hydrates without recreating DOM', async (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  writeFile(path.join(projectDirectory, 'index.html'), DOCUMENT_SHELL);
  fs.mkdirSync(path.join(projectDirectory, 'src'), { recursive: true });
  writeFile(path.join(projectDirectory, 'src', 'App.wizz'), COUNTER_PAGE);
  // The generated modules are ESM; this marker makes them importable from
  // the CJS test process.
  writeFile(path.join(projectDirectory, 'package.json'), '{"type":"module"}');

  const developmentServer = startDevelopmentServer({ projectDirectory, port: 0, logger: createLogger() });
  t.after(() => developmentServer.close());
  const url = await developmentServer.listen();

  const delivered = await (await fetch(`${url}/`)).text();
  const markupMatch = /<div id="app">([\s\S]*?)<\/div>\n  <script type="application\/wizz-state">/.exec(delivered);
  assert.ok(markupMatch, 'the delivered document contains rendered markup in the mount point');
  const stateMatch = /<script type="application\/wizz-state">(.*)<\/script>/.exec(delivered);
  assert.ok(stateMatch, 'the delivered document carries the wizz-state script');
  const state = JSON.parse(stateMatch[1]);

  const { mtimeMs } = fs.statSync(path.join(projectDirectory, 'dist', 'App.hydrate.js'));
  const document = createHydrationDocument();
  const originalDocument = global.document;
  global.document = document;
  t.after(() => { global.document = originalDocument; });
  const hydrateModule = await import(`${pathToFileURL(path.join(projectDirectory, 'dist', 'App.hydrate.js')).href}?v=${mtimeMs}`);

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  t.after(() => { console.warn = originalWarn; });

  const metricsBefore = { ...document.metrics };
  const target = document.makeElement('div');
  for (const node of parseDeliveredMarkup(markupMatch[1], document)) target.appendChild(node);

  const component = hydrateModule.hydrateComponent(target, {}, state);

  // Adoption, not recreation: zero node creation, listeners deferred until
  // the verifying walk passed, and no mismatch warning.
  assert.deepEqual(
    { elements: document.metrics.elements - metricsBefore.elements, textNodes: document.metrics.textNodes - metricsBefore.textNodes },
    { elements: 0, textNodes: 0 }
  );
  assert.equal(warnings.length, 0);
  assert.equal(target.firstElementChild.tagName, 'MAIN');

  const paragraph = target.childNodes[0].childNodes[1];
  const button = target.childNodes[0].childNodes[2];
  button.dispatchEvent('click');
  await flushUpdates();
  // Hydration stripped the adjacency marker between 'Count: ' and the
  // expression node, so the reactive text sits at index 1.
  assert.equal(paragraph.childNodes[1].nodeValue, '1');

  component.destroy();
  assert.equal(target.childNodes.length, 0);
  assert.equal(document.metrics.addedListeners, 1);
});
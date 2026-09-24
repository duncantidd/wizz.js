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

test('a platform without recursive fs.watch degrades to the poller and keeps rebuilding', (t) => {
  const inputDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(inputDirectory, { recursive: true, force: true }));
  const sourceFile = path.join(inputDirectory, 'pages', 'Home.wizz');
  writeFile(sourceFile, '<main>Before</main>');
  // The exact failure Node 18 on Linux raises for a recursive watch.
  const unavailable = Object.assign(
    new TypeError('The feature watch recursively is unavailable on the current platform, which is being used to run Node.js'),
    { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' }
  );
  const notices = [];
  const callbacks = [];
  const changes = [];
  let clearedTimer;
  const watcher = watchSourceFiles(inputDirectory, (eventType, fileName) => changes.push({ eventType, fileName }), {
    watch() {
      throw unavailable;
    },
    onWatchUnavailable: (error) => notices.push(error),
    setInterval(callback) {
      callbacks.push({ poll: callback });
      return 'poller';
    },
    clearInterval(timer) { clearedTimer = timer; }
  });

  assert.deepEqual(notices, [unavailable]);
  writeFile(sourceFile, '<main>After the fallback rebuild</main>');
  callbacks[0].poll();
  assert.deepEqual(changes, [{ eventType: 'change', fileName: 'source files' }]);
  // Closing without a native watcher only clears the poller.
  watcher.close();
  assert.equal(clearedTimer, 'poller');
});

test('a native watcher that dies mid-session routes through the fallback notice and leaves the poller running', (t) => {
  const inputDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(inputDirectory, { recursive: true, force: true }));
  writeFile(path.join(inputDirectory, 'pages', 'Home.wizz'), '<main>Before</main>');
  const notices = [];
  const callbacks = [];
  const changes = [];
  let watcherErrorListener;
  const watcher = watchSourceFiles(inputDirectory, (eventType, fileName) => changes.push({ eventType, fileName }), {
    watch() {
      return {
        on(eventName, listener) {
          if (eventName === 'error') watcherErrorListener = listener;
        },
        close() {}
      };
    },
    onWatchUnavailable: (error) => notices.push(error),
    setInterval(callback) {
      callbacks.push({ poll: callback });
      return 'poller';
    },
    clearInterval() {}
  });

  // The error listener is wired at creation, before anything can fail.
  assert.equal(typeof watcherErrorListener, 'function');
  const midSession = Object.assign(new Error('watched directory removed'), { code: 'ENOENT' });
  watcherErrorListener(midSession);
  assert.deepEqual(notices, [midSession]);
  writeFile(path.join(inputDirectory, 'pages', 'Home.wizz'), '<main>After the watcher died</main>');
  callbacks[0].poll();
  assert.deepEqual(changes, [{ eventType: 'change', fileName: 'source files' }]);
  watcher.close();
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

test('server-renders component tags and blocks through the import graph', async (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  writeFile(path.join(projectDirectory, 'index.html'), DOCUMENT_SHELL);
  fs.mkdirSync(path.join(projectDirectory, 'src'), { recursive: true });
  // A Contact-style page: an imported prop-driven component plus an {#if}
  // block — both server-renderable since milestone 14.
  writeFile(
    path.join(projectDirectory, 'src', 'App.wizz'),
    '<script>\nimport TestProps from "./components/TestProps.wizz";\nlet myName = "Paul";\nlet ready = false;\n</script><main><TestProps name={myName} />{#if ready}<p>On</p>{:else}<p>Off</p>{/if}</main>'
  );
  writeFile(
    path.join(projectDirectory, 'src', 'components', 'TestProps.wizz'),
    '<script>export let name = "";</script><p>{name}</p>'
  );

  const developmentServer = startDevelopmentServer({ projectDirectory, port: 0, logger: createLogger() });
  t.after(() => developmentServer.close());
  const url = await developmentServer.listen();

  const document = await (await fetch(`${url}/`)).text();
  // The child's rendered root sits at the component-tag position inside #app,
  // and the untaken if branch renders the else content between the block
  // markers.
  assert.match(document, /<div id="app"><main><p data-wizz-id="1">Paul<\/p><!-- --><p>Off<\/p><!-- --><\/main><\/div>/);
  // The child's state slice travels under the reserved __wizz key; a
  // props-only child contributes an empty slice (props are re-applied by the
  // parent, never serialized).
  assert.match(document, /<script type="application\/wizz-state">\{"myName":"Paul","ready":false,"__wizz":\{"components":\{"1":\{\}\}\}\}<\/script>/);

  // Both server-side builds of the imported component are served.
  const childServerBuild = await fetch(`${url}/components/TestProps.server.js`);
  assert.equal(childServerBuild.status, 200);
  assert.match(await childServerBuild.text(), /^export function renderComponent\(props = \{\}\)/m);
  const childHydrateBuild = await fetch(`${url}/components/TestProps.hydrate.js`);
  assert.equal(childHydrateBuild.status, 200);

  // The page's hydratable build imports the child's hydratable module for
  // nested adoption.
  const pageHydrateBuild = await fetch(`${url}/App.hydrate.js`);
  assert.equal(pageHydrateBuild.status, 200);
  assert.match(await pageHydrateBuild.text(), /import \* as __wizzHydrate_TestProps from "\.\/components\/TestProps\.hydrate\.js";/);
});

test('injects the component head run into the document head before </head>', async (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  writeFile(path.join(projectDirectory, 'index.html'), DOCUMENT_SHELL);
  fs.mkdirSync(path.join(projectDirectory, 'src'), { recursive: true });
  // The page declares a head; the child contributes one too (its slice
  // travels with the page's run, tagged with its own owner path).
  writeFile(
    path.join(projectDirectory, 'src', 'App.wizz'),
    '<script>import Kid from "./Kid.wizz";</script><wizz:head><title>Page</title><meta name="viewport" content="w=1"></wizz:head><main><Kid /></main>'
  );
  writeFile(
    path.join(projectDirectory, 'src', 'Kid.wizz'),
    '<wizz:head><title>Kid</title></wizz:head><p>Kid</p>'
  );

  const developmentServer = startDevelopmentServer({ projectDirectory, port: 0, logger: createLogger() });
  t.after(() => developmentServer.close());
  const url = await developmentServer.listen();

  const document = await (await fetch(`${url}/`)).text();
  // The run sits inside <head>, ahead of the closing tag, wrapped in the
  // marker comments the client consumes after a successful adoption.
  assert.match(document, /<!--wizz:head-start-->[\s\S]*<!--wizz:head-end--><\/head>/);
  // Tree order: the page's head precedes the child's, matching render order;
  // every delivered node is tagged with its owner path for slice adoption.
  const run = document.slice(document.indexOf('wizz:head-start'), document.indexOf('wizz:head-end'));
  const titleOrder = [...run.matchAll(/<title([^>]*)>([^<]*)<\/title>/g)].map((match) => [match[1], match[2]]);
  assert.deepEqual(
    titleOrder.map(([attrs, text]) => [attrs.replace(/ data-wizz-loc="[^"]*"/, ''), text]),
    [
      [' data-wizz-head-id="r"', 'Page'],
      [' data-wizz-head-id="r/1"', 'Kid']
    ]
  );
  // Each location attribute names the declaring file (dev compiles with the
  // absolute source path), so conflicts can be pinned to their origins.
  assert.match(run, /<title data-wizz-head-id="r" data-wizz-loc="[^"]*\/src\/App\.wizz:1:\d+">/);
  assert.match(run, /<title data-wizz-head-id="r\/1" data-wizz-loc="[^"]*\/src\/Kid\.wizz:1:\d+">/);
});

test('delivers scoped component styles with their own h2 rules from the first load', async (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  writeFile(path.join(projectDirectory, 'index.html'), DOCUMENT_SHELL);
  fs.mkdirSync(path.join(projectDirectory, 'src'), { recursive: true });
  // The motivating case: two styled components with conflicting h2 rules on
  // one page, plus the page's own unscoped h2 that must match neither rule.
  writeFile(
    path.join(projectDirectory, 'src', 'Card.wizz'),
    '<div><h2>Card</h2></div><wizz:style>h2 { font-size: 24px }</wizz:style>'
  );
  writeFile(
    path.join(projectDirectory, 'src', 'Panel.wizz'),
    '<div><h2>Panel</h2></div><wizz:style>h2 { font-size: 30px }</wizz:style>'
  );
  writeFile(
    path.join(projectDirectory, 'src', 'App.wizz'),
    '<script>import Card from "./Card.wizz";\nimport Panel from "./Panel.wizz";</script><main><Card /><Panel /><h2>Page</h2></main>'
  );

  const developmentServer = startDevelopmentServer({ projectDirectory, port: 0, logger: createLogger() });
  t.after(() => developmentServer.close());
  const url = await developmentServer.listen();

  const document = await (await fetch(`${url}/`)).text();
  // Exactly one <style> per component, riding the head run inside <head>.
  assert.equal((document.match(/<style data-wizz-style=/g) || []).length, 2);
  const run = document.slice(document.indexOf('wizz:head-start'), document.indexOf('wizz:head-end'));
  assert.match(run, /<style data-wizz-style="[a-z0-9]+"[^>]*>h2\[data-wizz-s="[a-z0-9]+"\] \{ font-size: 24px \}<\/style>/);
  assert.match(run, /<style data-wizz-style="[a-z0-9]+"[^>]*>h2\[data-wizz-s="[a-z0-9]+"\] \{ font-size: 30px \}<\/style>/);
  // The two rules scope to different attributes, so the page's own h2 —
  // carrying no scope attribute — matches neither.
  const scopeValues = [...run.matchAll(/data-wizz-style="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(scopeValues).size, 2);
  // The page's own h2 carries no scope attribute (component h2s do).
  assert.match(document, /<h2>Page<\/h2>/);
});

test('a styled component rendered twice on one page injects its stylesheet once', async (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  writeFile(path.join(projectDirectory, 'index.html'), DOCUMENT_SHELL);
  fs.mkdirSync(path.join(projectDirectory, 'src'), { recursive: true });
  writeFile(
    path.join(projectDirectory, 'src', 'Badge.wizz'),
    '<span><em>!</em></span><wizz:style>em { color: red } span { padding: 2px }</wizz:style>'
  );
  // The page renders the styled component twice and also pulls it in
  // transitively through a child — the document still carries one style tag.
  writeFile(
    path.join(projectDirectory, 'src', 'Kid.wizz'),
    '<script>import Badge from "./Badge.wizz";</script><p><Badge /></p>'
  );
  writeFile(
    path.join(projectDirectory, 'src', 'App.wizz'),
    '<script>import Badge from "./Badge.wizz";\nimport Kid from "./Kid.wizz";</script><main><Badge /><Badge /><Kid /></main>'
  );

  const developmentServer = startDevelopmentServer({ projectDirectory, port: 0, logger: createLogger() });
  t.after(() => developmentServer.close());
  const url = await developmentServer.listen();

  const document = await (await fetch(`${url}/`)).text();
  assert.equal((document.match(/<style data-wizz-style=/g) || []).length, 1);
  // All three rendered instances (two direct, one nested) carry the scope;
  // each Badge renders two scoped elements (span + em), so 3 × 2 = 6.
  const markup = /<div id="app">([\s\S]*?)<\/main><\/div>/.exec(document)[1];
  assert.equal((markup.match(/data-wizz-s=/g) || []).length, 6);
});

test('a component edit reaches the served document without restarting the dev server', async (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  writeFile(path.join(projectDirectory, 'index.html'), DOCUMENT_SHELL);
  fs.mkdirSync(path.join(projectDirectory, 'src'), { recursive: true });
  writeFile(
    path.join(projectDirectory, 'src', 'Card.wizz'),
    '<article><h2>Card</h2></article><wizz:style>h2 { color: black }</wizz:style>'
  );
  writeFile(
    path.join(projectDirectory, 'src', 'App.wizz'),
    '<script>import Card from "./Card.wizz";</script><main><Card /></main>'
  );

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
  assert.match(before, /h2\[data-wizz-s="[a-z0-9]+"\] \{ color: black \}/);

  // Edit the CHILD component (not the page) and rebuild through the watcher.
  // Node's module cache keys on the full URL and queries never propagate
  // through static imports, so the rebuild stamps child `.server.js`
  // specifiers with a fresh query — without it, every rebuild kept serving
  // the first build's stale child markup and styles until restart.
  writeFile(
    path.join(projectDirectory, 'src', 'Card.wizz'),
    '<article><h2 class="card-heading">Card v2</h2></article><wizz:style>h2 { color: black } .card-heading { color: pink }</wizz:style>'
  );
  watchListeners[0]('change', 'Card.wizz');
  await flushUpdates();

  const after = await (await fetch(`${url}/`)).text();
  assert.match(after, /Card v2/);
  assert.match(after, /class="card-heading"/);
  // Class terminals take the scope attribute prepended (scanner contract).
  assert.match(after, /\[data-wizz-s="[a-z0-9]+"\]\.card-heading \{ color: pink \}/);
  // The fresh scope hash must appear identically in the markup and the style.
  const scopeMatch = /<h2 class="card-heading" data-wizz-s="([a-z0-9]+)"/.exec(after);
  assert.ok(scopeMatch, 'the delivered h2 carries the new scope');
  assert.match(after, new RegExp(`h2\\[data-wizz-s="${scopeMatch[1]}"\\] \\{ font-size|color`));
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
// ---------------------------------------------------------------------------
// Milestone 21: server API routes
// ---------------------------------------------------------------------------

const { loadServerEnv } = require('../scripts/apiRoutes');

function createApiProject(projectDirectory, handlers) {
  writeFile(path.join(projectDirectory, 'index.html'), DOCUMENT_SHELL);
  fs.mkdirSync(path.join(projectDirectory, 'src'), { recursive: true });
  writeFile(path.join(projectDirectory, 'src', 'App.wizz'), '<main><h1>Home</h1></main>');
  for (const [handlerPath, contents] of Object.entries(handlers)) {
    writeFile(path.join(projectDirectory, 'src', handlerPath), contents);
  }
}

const ECHO_HANDLER = `export default async function handler(request) {
  return {
    method: request.method,
    path: request.path,
    query: Object.fromEntries(request.query),
    body: request.body
  };
};
`;

test('serves server API routes from src/server/api inside the dev server', async (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  createApiProject(projectDirectory, {
    ['server/api/health.js']: 'export default async function handler() { return { ok: true }; };\n',
    ['server/api/echo.js']: ECHO_HANDLER
  });

  const developmentServer = startDevelopmentServer({ projectDirectory, port: 0, logger: createLogger() });
  t.after(() => developmentServer.close());
  const url = await developmentServer.listen();

  const health = await fetch(`${url}/api/health`);
  assert.equal(health.status, 200);
  assert.match(health.headers.get('content-type'), /^application\/json/);
  assert.equal(await health.text(), '{"ok":true}');

  const echoed = await fetch(`${url}/api/echo?x=1&x=2`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hello: 'world' })
  });
  assert.equal(echoed.status, 200);
  assert.deepEqual(await echoed.json(), {
    method: 'POST',
    path: '/api/echo',
    query: { x: '2' },
    body: '{"hello":"world"}'
  });

  const unnamed = await fetch(`${url}/api/echo?x=1&x=2`, { method: 'GET' });
  assert.deepEqual(await unnamed.json(), { method: 'GET', path: '/api/echo', query: { x: '2' }, body: null });
});

test('nested and index api routes resolve, private modules stay unroutable', async (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  createApiProject(projectDirectory, {
    ['server/api/index.js']: 'export default async function handler(request) { return request.path; };\n',
    ['server/api/v1/users.js']: 'export default async function handler() { return "users"; };\n',
    ['server/api/_shared.js']: 'export const shared = true;\n'
  });

  const developmentServer = startDevelopmentServer({ projectDirectory, port: 0, logger: createLogger() });
  t.after(() => developmentServer.close());
  const url = await developmentServer.listen();

  assert.equal(await (await fetch(`${url}/api`)).text(), '/api');
  assert.equal(await (await fetch(`${url}/api/v1/users`)).text(), 'users');
  assert.equal((await fetch(`${url}/api/_shared`)).status, 404);
});

test('an api handler edit takes effect on the next request without a rebuild', async (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  const handlerPath = path.join(projectDirectory, 'src', 'server', 'api', 'version.js');
  createApiProject(projectDirectory, {
    ['server/api/version.js']: 'export default async function handler() { return { version: 1 }; };\n'
  });

  const logger = createLogger();
  const developmentServer = startDevelopmentServer({ projectDirectory, port: 0, logger });
  t.after(() => developmentServer.close());
  const url = await developmentServer.listen();

  assert.equal(await (await fetch(`${url}/api/version`)).text(), '{"version":1}');

  writeFile(handlerPath, 'export default async function handler() { return { version: 2 }; };\n');
  // mtime cache-busting needs a distinct timestamp; force one on filesystems
  // with coarse mtime resolution.
  const later = new Date(Date.now() + 2000);
  fs.utimesSync(handlerPath, later, later);

  assert.equal(await (await fetch(`${url}/api/version`)).text(), '{"version":2}');
});

test('.env.server secrets reach handlers but never the served output', async (t) => {
  const projectDirectory = createTemporaryDirectory();
  const envKey = 'WIZZ_DEV_TEST_SECRET';
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  t.after(() => { delete process.env[envKey]; });
  writeFile(path.join(projectDirectory, '.env.server'), `${envKey}=sk-e2e-12345\n`);
  createApiProject(projectDirectory, {
    ['server/api/secret.js']: `export default async function handler() { return { secret: process.env.${envKey} ?? null }; };\n`
  });

  const developmentServer = startDevelopmentServer({
    projectDirectory,
    port: 0,
    logger: createLogger(),
    // The real wiring: the dev server calls options.loadEnv(projectDirectory),
    // and the default reads .env.server into process.env.
    loadEnv: (directory) => loadServerEnv(directory, process.env)
  });
  t.after(() => developmentServer.close());
  const url = await developmentServer.listen();

  assert.equal(await (await fetch(`${url}/api/secret`)).text(), `{"secret":"sk-e2e-12345"}`);

  // The secret must not appear in any file under the served output — handler
  // copies, manifests, compiled modules, or the shell.
  const outputDirectory = path.join(projectDirectory, 'dist');
  const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(entryPath) : [entryPath];
  });
  for (const outputPath of walk(outputDirectory)) {
    assert.equal(fs.readFileSync(outputPath, 'utf8').includes('sk-e2e-12345'), false, `secret leaked into ${outputPath}`);
  }
});

test('handler source, production output paths, and unmatched api paths are unreachable', async (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  createApiProject(projectDirectory, { ['server/api/echo.js']: ECHO_HANDLER });

  const logger = createLogger();
  const developmentServer = startDevelopmentServer({ projectDirectory, port: 0, logger });
  t.after(() => developmentServer.close());
  const url = await developmentServer.listen();

  // The build copied the handler to dist/server/api/echo.js, but the /server/
  // guard refuses it as a static file: source code is never web-served.
  assert.equal(fs.existsSync(path.join(projectDirectory, 'dist', 'server', 'api', 'echo.js')), true);
  const guarded = await fetch(`${url}/server/api/echo.js`);
  assert.equal(guarded.status, 404);

  // A .js suffix never resolves to the handler — routes are exact table hits.
  const sourcePath = await fetch(`${url}/api/echo.js`);
  assert.equal(sourcePath.status, 404);

  // Unmatched API paths answer 404 JSON, never the SPA shell.
  const missing = await fetch(`${url}/api/absent`);
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get('content-type'), /^application\/json/);
  assert.equal(await missing.text(), '{"error":"Not found"}');

  // The same miss on a page path still falls back to the shell.
  const shell = await fetch(`${url}/somewhere`);
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get('content-type'), /^text\/html/);
});

test('a handler throw answers a generic 500 and logs the detail server-side', async (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  createApiProject(projectDirectory, {
    ['server/api/explode.js']: 'export default async function handler() { throw new Error("Bearer sk-boom leaked"); };\n'
  });

  const logger = createLogger();
  const developmentServer = startDevelopmentServer({ projectDirectory, port: 0, logger });
  t.after(() => developmentServer.close());
  const url = await developmentServer.listen();

  const response = await fetch(`${url}/api/explode`);
  assert.equal(response.status, 500);
  assert.equal(await response.text(), '{"error":"Internal server error"}');

  assert.equal(logger.errors.length, 1);
  assert.match(logger.errors[0], /sk-boom leaked/);
});

test('a module without a default function export answers 500', async (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  createApiProject(projectDirectory, {
    ['server/api/notahandler.js']: 'export const answer = 42;\n'
  });

  const logger = createLogger();
  const developmentServer = startDevelopmentServer({ projectDirectory, port: 0, logger });
  t.after(() => developmentServer.close());
  const url = await developmentServer.listen();

  const response = await fetch(`${url}/api/notahandler`);
  assert.equal(response.status, 500);
  assert.equal(await response.text(), '{"error":"Internal server error"}');
  assert.match(logger.errors[0], /no default export function/);
});

test('malformed JSON bodies answer 400 and oversized bodies answer 413', async (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  createApiProject(projectDirectory, {
    ['server/api/json.js']: 'export default async function handler(request) { return request.json(); };\n'
  });

  const developmentServer = startDevelopmentServer({ projectDirectory, port: 0, logger: createLogger() });
  t.after(() => developmentServer.close());
  const url = await developmentServer.listen();

  const malformed = await fetch(`${url}/api/json`, { method: 'POST', body: '{not json' });
  assert.equal(malformed.status, 400);
  assert.equal(await malformed.text(), '{"error":"Bad request"}');

  const oversized = await fetch(`${url}/api/json`, {
    method: 'POST',
    body: 'x'.repeat(1024 * 1024 + 1)
  });
  assert.equal(oversized.status, 413);

  const exactlyAtTheLimit = await fetch(`${url}/api/json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fill: 'y'.repeat(1024 * 1024 - 20) })
  });
  assert.equal(exactlyAtTheLimit.status, 200);
});

test('colliding api routes disable serving and log the collision', async (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  createApiProject(projectDirectory, {
    ['server/api/Health.js']: 'export default async function handler() { return "upper"; };\n',
    ['server/api/health.js']: 'export default async function handler() { return "lower"; };\n'
  });

  const logger = createLogger();
  const developmentServer = startDevelopmentServer({ projectDirectory, port: 0, logger });
  t.after(() => developmentServer.close());
  const url = await developmentServer.listen();

  const response = await fetch(`${url}/api/health`);
  assert.equal(response.status, 404);
  assert.equal(await response.text(), '{"error":"Not found"}');
  // The build failure, the startup copy failure, and the per-request refusal
  // all log; the collision detail must appear in the server log.
  assert.equal(logger.errors.some((message) => /Ambiguous API route '\/api\/health'/.test(message)), true);
});

test('an api handler with a syntax error answers 500 instead of crashing the server', async (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  createApiProject(projectDirectory, {
    ['server/api/broken.js']: 'export default async function handler( { return 1;\n'
  });

  const logger = createLogger();
  const developmentServer = startDevelopmentServer({ projectDirectory, port: 0, logger });
  t.after(() => developmentServer.close());
  const url = await developmentServer.listen();

  const response = await fetch(`${url}/api/broken`);
  assert.equal(response.status, 500);
  assert.equal(await response.text(), '{"error":"Internal server error"}');

  // The server survives: page routes keep working after the failed import.
  const page = await fetch(`${url}/`);
  assert.equal(page.status, 200);
});

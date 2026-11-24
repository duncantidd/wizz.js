// Milestone 23 equivalence suite: `wizz build --compact` must change the size
// of dist/ and nothing else. The scaffolded sample project is built both
// ways and every observable surface is compared between the two builds:
// SSR markup, head, and state payloads per route; client mounts and
// hydration through a DOM shim, including the DOM after every interaction;
// and the node adapter host's page and API responses.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { buildProject, NODE_ADAPTER_HOST_FILENAME } = require('../build');
const { initProject } = require('../scripts/init');

const silentLogger = { log() {}, error() {}, warn() {} };
const flushUpdates = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// A generic DOM shim: just enough of the browser surface the generated
// modules and runtime touch, with a deterministic serializer for comparison.
// ---------------------------------------------------------------------------

function createDom() {
  class Node {
    constructor(nodeType) {
      this.nodeType = nodeType;
      this.parentNode = null;
      this.childNodes = [];
    }
    get firstChild() { return this.childNodes[0] ?? null; }
    get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; }
    get nextSibling() {
      if (!this.parentNode) return null;
      const siblings = this.parentNode.childNodes;
      return siblings[siblings.indexOf(this) + 1] ?? null;
    }
    get previousSibling() {
      if (!this.parentNode) return null;
      const siblings = this.parentNode.childNodes;
      return siblings[siblings.indexOf(this) - 1] ?? null;
    }
    get firstElementChild() { return this.childNodes.find((node) => node.nodeType === 1) ?? null; }
    get children() { return this.childNodes.filter((node) => node.nodeType === 1); }
    get isConnected() { return true; }
    appendChild(node) { return this.insertBefore(node, null); }
    insertBefore(node, reference) {
      if (node.parentNode) node.parentNode.removeChild(node);
      const index = reference == null ? -1 : this.childNodes.indexOf(reference);
      if (reference != null && index === -1) throw new Error('insertBefore: reference is not a child');
      this.childNodes.splice(index === -1 ? this.childNodes.length : index, 0, node);
      node.parentNode = this;
      return node;
    }
    removeChild(node) {
      const index = this.childNodes.indexOf(node);
      if (index === -1) throw new Error('removeChild: not a child');
      this.childNodes.splice(index, 1);
      node.parentNode = null;
      return node;
    }
    replaceChild(node, old) {
      this.insertBefore(node, old);
      return this.removeChild(old);
    }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    get textContent() {
      if (this.nodeType === 3 || this.nodeType === 8) return this.nodeValue;
      return this.childNodes.map((node) => (node.nodeType === 8 ? '' : node.textContent)).join('');
    }
    set textContent(value) {
      if (this.nodeType === 3 || this.nodeType === 8) { this.nodeValue = String(value); return; }
      for (const child of [...this.childNodes]) this.removeChild(child);
      if (String(value) !== '') this.appendChild(new TextNode(String(value)));
    }
  }

  class TextNode extends Node {
    constructor(value) { super(3); this.nodeValue = value; this.nodeName = '#text'; }
    get data() { return this.nodeValue; }
    set data(value) { this.nodeValue = value; }
  }

  class CommentNode extends Node {
    constructor(value) { super(8); this.nodeValue = value; this.nodeName = '#comment'; }
    get data() { return this.nodeValue; }
    set data(value) { this.nodeValue = value; }
  }

  class Element extends Node {
    constructor(name) {
      super(1);
      this.localName = name.toLowerCase();
      this.tagName = name.toUpperCase();
      this.nodeName = this.tagName;
      this.attributes = new Map();
      this.listeners = new Map();
      this.value = '';
      this.checked = false;
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    get id() { return this.getAttribute('id') ?? ''; }
    get className() { return this.getAttribute('class') ?? ''; }
    set className(value) { this.setAttribute('class', value); }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(listener);
    }
    removeEventListener(type, listener) {
      const list = this.listeners.get(type) || [];
      const index = list.indexOf(listener);
      if (index !== -1) list.splice(index, 1);
    }
    dispatchEvent(event) {
      for (const listener of [...(this.listeners.get(event.type) || [])]) listener(event);
      return true;
    }
    matches(selector) { return selector.split(',').some((part) => matchesSimple(this, part.trim())); }
    querySelectorAll(selector) {
      const found = [];
      const visit = (node) => {
        for (const child of node.childNodes) {
          if (child.nodeType !== 1) continue;
          if (child.matches(selector)) found.push(child);
          visit(child);
        }
      };
      visit(this);
      return found;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    getElementById(id) { return this.querySelector(`#${id}`); }
  }

  // Compound selectors only (tag, #id, .class, [attr], [attr="v"]): the
  // generated modules and runtime query no combinators.
  function matchesSimple(element, selector) {
    const pattern = /^([a-zA-Z][a-zA-Z0-9-]*)?((?:#[\w-]+|\.[\w-]+|\[[^\]]+\])*)$/;
    const match = pattern.exec(selector);
    if (!match) throw new Error(`DOM shim: unsupported selector ${selector}`);
    if (match[1] && match[1].toLowerCase() !== element.localName) return false;
    const parts = match[2].match(/#[\w-]+|\.[\w-]+|\[[^\]]+\]/g) || [];
    return parts.every((part) => {
      if (part[0] === '#') return element.getAttribute('id') === part.slice(1);
      if (part[0] === '.') return (element.getAttribute('class') || '').split(/\s+/).includes(part.slice(1));
      const attribute = /^\[([^=\]]+)(?:=(["']?)(.*)\2)?\]$/.exec(part);
      if (!attribute) throw new Error(`DOM shim: unsupported attribute selector ${part}`);
      if (attribute[3] === undefined) return element.hasAttribute(attribute[1]);
      return element.getAttribute(attribute[1]) === attribute[3];
    });
  }

  const documentElement = new Element('html');
  const head = new Element('head');
  const body = new Element('body');
  documentElement.appendChild(head);
  documentElement.appendChild(body);

  const document = {
    nodeType: 9,
    documentElement,
    head,
    body,
    location: { search: '', pathname: '/', href: 'http://localhost/' },
    createElement: (name) => new Element(name),
    createElementNS: (namespace, name) => new Element(name),
    createTextNode: (value) => new TextNode(String(value)),
    createComment: (value) => new CommentNode(String(value)),
    createDocumentFragment: () => new Element('#fragment'),
    querySelector: (selector) => documentElement.querySelector(selector),
    querySelectorAll: (selector) => documentElement.querySelectorAll(selector),
    getElementById: (id) => documentElement.getElementById(id),
    addEventListener() {},
    removeEventListener() {},
    get title() {
      const title = head.querySelector('title');
      return title ? title.textContent : '';
    },
    set title(value) {
      let title = head.querySelector('title');
      if (!title) { title = new Element('title'); head.appendChild(title); }
      title.textContent = value;
    }
  };

  return { document, Element, TextNode, CommentNode };
}

// Parses server-delivered markup into shim nodes (the generated server
// output only: well-formed, always-closed, double-quoted attributes).
function parseMarkup(markup, dom) {
  const voidElements = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const root = dom.document.createElement('#root');
  const stack = [root];
  let index = 0;
  const decode = (text) => text
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

  while (index < markup.length) {
    const parent = stack[stack.length - 1];
    if (markup.startsWith('<!--', index)) {
      const end = markup.indexOf('-->', index + 4);
      parent.appendChild(dom.document.createComment(markup.slice(index + 4, end)));
      index = end + 3;
    } else if (markup.startsWith('</', index)) {
      stack.pop();
      index = markup.indexOf('>', index) + 1;
    } else if (markup[index] === '<') {
      const end = markup.indexOf('>', index);
      const rawTag = markup.slice(index + 1, end);
      const name = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(rawTag)[1];
      const element = dom.document.createElement(name);
      const attributePattern = /([^\s=/]+)(?:="([^"]*)")?/g;
      let match;
      const attributeSource = rawTag.slice(name.length).replace(/\/$/, '');
      while ((match = attributePattern.exec(attributeSource)) !== null) {
        element.setAttribute(match[1], decode(match[2] ?? ''));
      }
      parent.appendChild(element);
      if (!rawTag.endsWith('/') && !voidElements.has(name.toLowerCase())) stack.push(element);
      index = end + 1;
    } else {
      const next = markup.indexOf('<', index);
      const stop = next === -1 ? markup.length : next;
      parent.appendChild(dom.document.createTextNode(decode(markup.slice(index, stop))));
      index = stop;
    }
  }
  return [...root.childNodes];
}

function serialize(node) {
  if (node.nodeType === 3) return JSON.stringify(node.nodeValue);
  if (node.nodeType === 8) return `<!--${node.nodeValue}-->`;
  const attributes = [...node.attributes.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => ` ${name}=${JSON.stringify(value)}`).join('');
  const listeners = [...node.listeners.entries()].filter(([, list]) => list.length > 0)
    .map(([type, list]) => ` on:${type}×${list.length}`).sort().join('');
  return `<${node.localName}${attributes}${listeners}>${node.childNodes.map(serialize).join('')}</${node.localName}>`;
}

function interactiveElements(root) {
  const found = [];
  const visit = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType !== 1) continue;
      if ([...child.listeners.values()].some((list) => list.length > 0)) found.push(child);
      visit(child);
    }
  };
  visit(root);
  return found;
}

// Installs fresh browser globals for one build's run and returns a restore.
function installGlobals(dom) {
  const saved = {};
  const storage = new Map();
  const replacements = {
    document: dom.document,
    window: { addEventListener() {}, removeEventListener() {}, location: dom.document.location, history: { pushState() {}, replaceState() {} } },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key)
    },
    // Node ships a real BroadcastChannel whose open handle keeps the
    // process alive; the shim's is inert.
    BroadcastChannel: class { postMessage() {} close() {} addEventListener() {} removeEventListener() {} set onmessage(_) {} }
  };
  for (const [name, value] of Object.entries(replacements)) {
    saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  return () => {
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
}

// Everything observable about one build, in a comparable shape.
async function observeBuild(distDirectory, routes) {
  const bust = `?observe=${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const importDist = (relative) => import(pathToFileURL(path.join(distDirectory, relative)).href + bust);
  const observations = {};

  for (const route of routes) {
    const record = {};
    observations[route.routePath] = record;

    // SSR: markup, head, state, and the delivered state script.
    const serverModule = await importDist(path.join('runtime', route.serverModulePath));
    const rendered = serverModule.renderComponent();
    record.ssr = { html: rendered.html, head: rendered.head ?? null, state: rendered.state };
    record.stateScript = serverModule.serializeInitialState(rendered.state);

    // Client mount, then every interaction in document order.
    {
      const dom = createDom();
      const restore = installGlobals(dom);
      const warnings = [];
      const originalWarn = console.warn;
      console.warn = (message) => warnings.push(String(message));
      try {
        const clientModule = await importDist(path.join('runtime', route.modulePath));
        const target = dom.document.createElement('div');
        dom.document.body.appendChild(target);
        const instance = clientModule.default(target, {});
        await flushUpdates();
        const steps = [serialize(dom.document.documentElement)];
        for (const element of interactiveElements(target)) {
          for (const type of [...element.listeners.keys()]) {
            element.value = 'typed';
            element.checked = !element.checked;
            element.dispatchEvent({ type, target: element, currentTarget: element, preventDefault() {}, stopPropagation() {} });
            await flushUpdates();
            steps.push(serialize(dom.document.documentElement));
          }
        }
        instance.destroy();
        steps.push(serialize(dom.document.documentElement));
        record.mount = { steps, warnings };
      } finally {
        console.warn = originalWarn;
        restore();
      }
    }

    // Hydration over the server-delivered markup and state.
    {
      const dom = createDom();
      const restore = installGlobals(dom);
      const warnings = [];
      const originalWarn = console.warn;
      console.warn = (message) => warnings.push(String(message));
      try {
        const hydrateModule = await importDist(path.join('runtime', route.hydratableModulePath));
        if (rendered.head) {
          dom.document.head.appendChild(dom.document.createComment('wizz:head-start'));
          for (const node of parseMarkup(rendered.head, dom)) dom.document.head.appendChild(node);
          dom.document.head.appendChild(dom.document.createComment('wizz:head-end'));
        }
        const target = dom.document.createElement('div');
        dom.document.body.appendChild(target);
        for (const node of parseMarkup(rendered.html, dom)) target.appendChild(node);
        const instance = hydrateModule.hydrateComponent(target, {}, JSON.parse(JSON.stringify(rendered.state)));
        await flushUpdates();
        const steps = [serialize(dom.document.documentElement)];
        for (const element of interactiveElements(target)) {
          for (const type of [...element.listeners.keys()]) {
            element.dispatchEvent({ type, target: element, currentTarget: element, preventDefault() {}, stopPropagation() {} });
            await flushUpdates();
            steps.push(serialize(dom.document.documentElement));
          }
        }
        instance.destroy();
        record.hydrate = { steps, warnings };
      } finally {
        console.warn = originalWarn;
        restore();
      }
    }
  }

  return observations;
}

function createProject(t) {
  const projectDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-compact-'));
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  initProject(projectDirectory, { template: 'sample' });
  return projectDirectory;
}

function buildBoth(projectDirectory, options = {}) {
  const src = path.join(projectDirectory, 'src');
  const readable = path.join(projectDirectory, 'dist');
  const compacted = path.join(projectDirectory, 'dist-compact');
  const readableResult = buildProject(src, readable, silentLogger, { ...options });
  const compactResult = buildProject(src, compacted, silentLogger, { ...options, compact: true });
  assert.deepEqual(readableResult, { compiledCount: 4, failedCount: 0 });
  assert.deepEqual(compactResult, readableResult);
  return { readable, compacted };
}

function listFiles(directory) {
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else files.push(path.relative(directory, entryPath).split(path.sep).join('/'));
    }
  };
  visit(directory);
  return files.sort();
}

async function readRoutes(distDirectory) {
  const manifest = await import(pathToFileURL(path.join(distDirectory, 'runtime', 'routes.js')).href + `?r=${Math.random()}`);
  return manifest.pageModules;
}

test('a compact build emits the same files minus source maps, each smaller or equal', (t) => {
  const projectDirectory = createProject(t);
  const { readable, compacted } = buildBoth(projectDirectory, { adapter: 'node' });

  const readableFiles = listFiles(readable);
  const compactFiles = listFiles(compacted);
  assert.ok(readableFiles.some((file) => file.endsWith('.map')), 'the readable build keeps its source maps');
  assert.deepEqual(compactFiles, readableFiles.filter((file) => !file.endsWith('.map')));

  let readableBytes = 0;
  let compactBytes = 0;
  for (const file of compactFiles) {
    const before = fs.statSync(path.join(readable, file)).size;
    const after = fs.statSync(path.join(compacted, file)).size;
    const contents = fs.readFileSync(path.join(compacted, file), 'utf8');
    assert.ok(after <= before, `${file} grew: ${before} -> ${after}`);
    assert.doesNotMatch(contents, /sourceMappingURL/, `${file} references a source map`);
    readableBytes += before;
    compactBytes += after;
  }
  assert.ok(compactBytes < readableBytes * 0.85, `expected a real reduction, got ${readableBytes} -> ${compactBytes}`);

  // Authored API handlers are copied verbatim in both builds.
  assert.equal(
    fs.readFileSync(path.join(compacted, 'server', 'api', 'health.js'), 'utf8'),
    fs.readFileSync(path.join(readable, 'server', 'api', 'health.js'), 'utf8')
  );
  // Every compacted artifact type actually shrank.
  for (const file of ['App.js', 'App.server.js', 'App.hydrate.js', 'runtime/router.js', 'runtime/routes.js', 'wizz.css', 'App.css', 'index.html', 'server.mjs']) {
    assert.ok(
      fs.statSync(path.join(compacted, file)).size < fs.statSync(path.join(readable, file)).size,
      `${file} was not compacted`
    );
  }
});

test('compacted pages render the same SSR markup, state, client DOM, and hydration', async (t) => {
  const projectDirectory = createProject(t);
  const { readable, compacted } = buildBoth(projectDirectory);

  const routes = await readRoutes(readable);
  assert.deepEqual(await readRoutes(compacted), routes, 'the route manifests agree');
  assert.ok(routes.length >= 2);
  assert.ok(routes.every((route) => route.serverModulePath && route.hydratableModulePath));

  const before = await observeBuild(readable, routes);
  const after = await observeBuild(compacted, routes);

  for (const route of routes) {
    const observed = before[route.routePath];
    // The comparison is only meaningful if the readable build itself ran
    // cleanly and the interactions actually changed something.
    assert.deepEqual(observed.mount.warnings, []);
    assert.deepEqual(observed.hydrate.warnings, []);
  }
  assert.ok(
    Object.values(before).some((record) => new Set(record.mount.steps).size > 2),
    'at least one interaction changed the DOM'
  );
  assert.deepEqual(after, before);
});

function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function startHost(t, distDirectory) {
  return reserveFreePort().then((port) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(distDirectory, NODE_ADAPTER_HOST_FILENAME)], {
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => reject(new Error(`host never started: ${stderr}`)), 10000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('serving')) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${port}`);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`host exited early with code ${code}: ${stderr}`));
    });
    t.after(() => child.kill());
  }));
}

// The rendered region of a served page: the mount point and its state
// script. The surrounding shell is compacted, so it differs by design.
function renderedRegion(html) {
  const match = /<div id="app">[\s\S]*?<script type="application\/wizz-state"[^>]*>[\s\S]*?<\/script>/.exec(html);
  assert.ok(match, `no rendered region in: ${html.slice(0, 200)}`);
  return match[0].replace(/<\/div>\s+<script/, '</div><script');
}

test('the compacted node adapter host serves identical routes and API responses', async (t) => {
  const projectDirectory = createProject(t);
  const { readable, compacted } = buildBoth(projectDirectory, { adapter: 'node' });
  const routes = await readRoutes(readable);

  const [readableUrl, compactUrl] = await Promise.all([startHost(t, readable), startHost(t, compacted)]);

  for (const route of routes) {
    const [a, b] = await Promise.all([fetch(readableUrl + route.routePath), fetch(compactUrl + route.routePath)]);
    assert.equal(b.status, a.status);
    assert.equal(b.headers.get('content-type'), a.headers.get('content-type'));
    const [aText, bText] = await Promise.all([a.text(), b.text()]);
    assert.equal(renderedRegion(bText), renderedRegion(aText));
    const headOf = (html) => /<!--wizz:head-start-->[\s\S]*<!--wizz:head-end-->/.exec(html)?.[0] ?? null;
    assert.equal(headOf(bText), headOf(aText));
  }

  for (const request of [
    { pathname: '/api/health' },
    { pathname: '/api/health', init: { method: 'POST', body: '{"x":1}', headers: { 'content-type': 'application/json' } } },
    { pathname: '/api/missing' },
    { pathname: '/server/api/health.js' }
  ]) {
    const [a, b] = await Promise.all([
      fetch(readableUrl + request.pathname, request.init),
      fetch(compactUrl + request.pathname, request.init)
    ]);
    assert.equal(b.status, a.status, request.pathname);
    assert.equal(await b.text(), await a.text(), request.pathname);
  }
});

test('a compact build over an earlier readable build removes the stale source maps', (t) => {
  const projectDirectory = createProject(t);
  const src = path.join(projectDirectory, 'src');
  const dist = path.join(projectDirectory, 'dist');
  buildProject(src, dist, silentLogger);
  assert.ok(listFiles(dist).some((file) => file.endsWith('.map')));
  buildProject(src, dist, silentLogger, { compact: true });
  assert.deepEqual(listFiles(dist).filter((file) => file.endsWith('.map')), []);
});

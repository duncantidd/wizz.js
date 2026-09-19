const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { buildProject } = require('../build');

// End-to-end coverage for the milestone 14 contract: an eligible page that
// imports components (and uses blocks) builds server and hydratable modules
// for the whole import graph, the generated cross-module imports resolve as
// real ESM, and the delivered document hydrates in place.

async function flushUpdates() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// Compact counting DOM shim (same idiom as test/hydration.test.js) with the
// surface nested hydration needs, including insertBefore with browser move
// semantics for each-block anchors.
function createDocument() {
  const elements = new Map();
  const metrics = { elements: 0, textNodes: 0, textWrites: 0, addedListeners: 0, removedListeners: 0 };

  function makeElement(name) {
    return {
      nodeType: 1,
      name,
      tagName: name.toUpperCase(),
      attributes: {},
      childNodes: [],
      listeners: {},
      _parentNode: null,
      get parentNode() { return this._parentNode; },
      set parentNode(value) { this._parentNode = value; },
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
        const find = (node) => {
          for (const child of node.childNodes || []) {
            if (
              child.nodeType === 1 &&
              child.attributes['data-wizz-id'] !== undefined &&
              selector === `[data-wizz-id="${child.attributes['data-wizz-id']}"]`
            ) return child;
            const match = find(child);
            if (match) return match;
          }
          return null;
        };
        return find(this);
      },
      get firstElementChild() {
        return this.childNodes.find((node) => node.nodeType === 1) ?? null;
      },
      appendChild(node) {
        this.childNodes.push(node);
        node.parentNode = this;
      },
      insertBefore(node, referenceNode) {
        // Browsers move an already-attached node rather than duplicating it.
        const existing = this.childNodes.indexOf(node);
        if (existing !== -1) this.childNodes.splice(existing, 1);
        if (referenceNode == null) {
          this.childNodes.push(node);
        } else {
          const index = this.childNodes.indexOf(referenceNode);
          if (index === -1) throw new Error('insertBefore reference node not found');
          this.childNodes.splice(index, 0, node);
        }
        node.parentNode = this;
      },
      removeChild(node) {
        const index = this.childNodes.indexOf(node);
        if (index !== -1) this.childNodes.splice(index, 1);
        node.parentNode = null;
      },
      addEventListener(eventName, listener) {
        this.listeners[eventName] = listener;
        metrics.addedListeners++;
      },
      removeEventListener(eventName, listener) {
        if (this.listeners[eventName] === listener) {
          delete this.listeners[eventName];
          metrics.removedListeners++;
        }
      },
      dispatchEvent(eventName) {
        this.listeners[eventName]?.({ type: eventName, target: this });
      }
    };
  }

  return {
    metrics,
    makeElement: makeElement,
    createElement(name) {
      metrics.elements++;
      return makeElement(name);
    },
    makeTextNode(initialValue) {
      return {
        nodeType: 3,
        _parentNode: null,
        get parentNode() { return this._parentNode; },
        set parentNode(value) { this._parentNode = value; },
        _nodeValue: initialValue,
        get nodeValue() { return this._nodeValue; },
        set nodeValue(value) {
          metrics.textWrites++;
          this._nodeValue = value;
        }
      };
    },
    createTextNode(initialValue) {
      metrics.textNodes++;
      return this.makeTextNode(initialValue);
    },
    createComment(nodeValue) {
      return { nodeType: 8, nodeValue, _parentNode: null, get parentNode() { return this._parentNode; }, set parentNode(value) { this._parentNode = value; } };
    },
    querySelector(selector) {
      return elements.get(selector) || null;
    }
  };
}

// Parses server-delivered markup into shim DOM the way a browser parser
// would, keeping comment markers as nodes.
function parseDeliveredMarkup(markup, document) {
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
      const closing = markup.slice(index + 2, end).trim();
      if (parent.name !== closing) throw new Error(`Mismatched closing tag </${closing}>`);
      stack.pop();
      index = end + 1;
      continue;
    }
    if (markup[index] === '<') {
      const end = markup.indexOf('>', index);
      const rawTag = markup.slice(index + 1, end);
      const name = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(rawTag)[1];
      const selfClosing = rawTag.endsWith('/');
      const element = document.makeElement(name);
      const attributeSource = rawTag.slice(name.length).replace(/\/$/, '');
      const attributePattern = /([^\s=/]+)(?:="([^"]*)")?/g;
      let match;
      while ((match = attributePattern.exec(attributeSource)) !== null) {
        if (match[0] === '') break;
        element.setAttribute(match[1], match[2] ?? '');
      }
      parent.childNodes.push(element);
      if (!selfClosing && !voidElements.has(name.toLowerCase())) stack.push(element);
      index = end + 1;
      continue;
    }

    const nextTag = markup.indexOf('<', index);
    const text = markup.slice(index, nextTag === -1 ? markup.length : nextTag);
    parent.childNodes.push(document.createTextNode(text));
    index = nextTag === -1 ? markup.length : nextTag;
  }

  return root.childNodes;
}

test('a built component-importing page delivers and hydrates through real generated modules', async (t) => {
  const projectDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-component-imports-'));
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(projectDirectory, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectDirectory, 'src', 'App.wizz'), [
    '<script>',
    'import Counter from "./components/Counter.wizz";',
    'let greeting = "Hi";',
    'let visible = true;',
    '</script><main><h1>{greeting}</h1>{#if visible}<Counter />{/if}</main>'
  ].join('\n'));
  fs.mkdirSync(path.join(projectDirectory, 'src', 'components'), { recursive: true });
  fs.writeFileSync(path.join(projectDirectory, 'src', 'components', 'Counter.wizz'), [
    '<script>',
    'let count = 0;',
    'function increment() { count += 1; }',
    '</script><section><h2>Total</h2><button on:click={increment}>Clicks: {count}</button></section>'
  ].join('\n'));

  const logger = { messages: [], errors: [], log(message) { this.messages.push(message); }, error(message) { this.errors.push(message); } };
  const result = buildProject(path.join(projectDirectory, 'src'), path.join(projectDirectory, 'dist'), logger);
  assert.deepEqual(result, { compiledCount: 2, failedCount: 0 });
  assert.equal(logger.messages.filter((message) => message.startsWith('Note:')).length, 0);
  // The emitted modules are ESM while the repo package is CommonJS: Node 18
  // has no module-syntax detection, so the output directory needs its own
  // module type before any dynamic import (the same line pins every other
  // suite's build output).
  fs.writeFileSync(path.join(projectDirectory, 'dist', 'package.json'), '{"type":"module"}');

  // The route manifest advertises the server builds for the page.
  const manifestSource = fs.readFileSync(path.join(projectDirectory, 'dist', 'runtime', 'routes.js'), 'utf8');
  assert.match(manifestSource, /"serverModulePath": "\.\.\/App\.server\.js"/);

  // Import the generated server module through the real ESM loader: its
  // namespace import of the child's server build must resolve on disk.
  const bust = `?test=${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const serverModule = await import(`${pathToFileURL(path.join(projectDirectory, 'dist', 'App.server.js')).href}${bust}`);
  const { html, state } = serverModule.renderComponent();
  // The child's markup is embedded at the tag position; the taken if branch
  // renders the component between the block markers.
  assert.equal(
    html,
    '<main><h1 data-wizz-id="1">Hi</h1><!-- --><section><h2>Total</h2><button data-wizz-id="1">Clicks: <!-- -->0</button></section><!-- --></main>'
  );
  assert.deepEqual(state, {
    greeting: 'Hi',
    visible: true,
    __wizz: { components: { '1': { count: 0 } } }
  });

  // Import the generated hydratable module: its imports of the child's
  // hydratable build and client build must both resolve on disk.
  const document = createDocument();
  const originalDocument = global.document;
  global.document = document;
  t.after(() => { global.document = originalDocument; });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  t.after(() => { console.warn = originalWarn; });
  const clientModule = await import(`${pathToFileURL(path.join(projectDirectory, 'dist', 'App.hydrate.js')).href}${bust}`);

  const target = document.makeElement('div');
  const delivered = serverModule.serializeInitialState(state);
  assert.match(delivered, /"__wizz":\{"components":\{"1":\{"count":0\}\}\}/);
  for (const node of parseDeliveredMarkup(html, document)) target.appendChild(node);

  // Counters are captured after parseDeliveredMarkup, which itself creates
  // the delivered text nodes; only hydration may add to them from here.
  const metricsBefore = { ...document.metrics };
  const component = clientModule.hydrateComponent(target, {}, state);

  // Zero recreation anywhere in the graph, no mismatch warnings.
  assert.equal(warnings.length, 0);
  assert.ok(component);
  assert.equal(document.metrics.elements, metricsBefore.elements);
  assert.equal(document.metrics.textNodes, metricsBefore.textNodes);
  assert.equal(document.metrics.addedListeners, metricsBefore.addedListeners + 1);

  // The child's adopted button stays reactive through its own module. The
  // walk strips the adjacency markers, so section sits at index 1 of main.
  const button = target.childNodes[0].childNodes[1].childNodes[1];
  assert.equal(button.name, 'button');
  button.dispatchEvent('click');
  await flushUpdates();
  assert.equal(button.childNodes[1].nodeValue, '1');

  // The nested tree tears down as one unit.
  component.destroy();
  assert.deepEqual(target.childNodes, []);
  assert.equal(document.metrics.removedListeners, 1);
});

test('a nested mismatch remounts inside the child root and keeps the parent tree intact', async (t) => {
  const projectDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-nested-mismatch-'));
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(projectDirectory, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectDirectory, 'src', 'App.wizz'), [
    '<script>',
    'import Counter from "./components/Counter.wizz";',
    '</script><main><Counter /></main>'
  ].join('\n'));
  fs.mkdirSync(path.join(projectDirectory, 'src', 'components'), { recursive: true });
  fs.writeFileSync(path.join(projectDirectory, 'src', 'components', 'Counter.wizz'), [
    '<script>',
    'let count = 0;',
    '</script><section><p>Clicks: {count}</p></section>'
  ].join('\n'));

  buildProject(path.join(projectDirectory, 'src'), path.join(projectDirectory, 'dist'), { log() {}, error() {} });
  // Node 18 has no module-syntax detection: pin the ESM type beside the
  // emitted modules before importing them (see the first suite in this file).
  fs.writeFileSync(path.join(projectDirectory, 'dist', 'package.json'), '{"type":"module"}');

  const bust = `?test=${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const document = createDocument();
  const originalDocument = global.document;
  global.document = document;
  t.after(() => { global.document = originalDocument; });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  t.after(() => { console.warn = originalWarn; });

  const serverModule = await import(`${pathToFileURL(path.join(projectDirectory, 'dist', 'App.server.js')).href}${bust}`);
  const clientModule = await import(`${pathToFileURL(path.join(projectDirectory, 'dist', 'App.hydrate.js')).href}${bust}`);

  const { html, state } = serverModule.renderComponent();
  const target = document.makeElement('div');
  for (const node of parseDeliveredMarkup(html, document)) target.appendChild(node);

  // Tamper only the CHILD's delivered text; the parent shell stays intact.
  // The component tag sits directly in <main> (no block boundary markers),
  // but the paragraph's inner marker puts the count text at index 2 of it.
  const section = target.childNodes[0].childNodes[0];
  section.childNodes[0].childNodes[2].nodeValue = '999';

  const parent = clientModule.hydrateComponent(target, {}, state);

  // One warning, from the child's walk; the parent adopted in place.
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^\[wizz\] hydration mismatch: /);
  assert.equal(target.childNodes[0].name, 'main');
  // The child remounted INSIDE its own root: the same section node survives
  // as the mount point, with a fresh component root appended inside it
  // (markers stripped by the walks on both levels).
  assert.equal(target.childNodes[0].childNodes[0], section);
  assert.equal(section.childNodes[0].name, 'section');
  assert.equal(section.childNodes[0].childNodes[0].name, 'p');
  assert.equal(section.childNodes[0].childNodes[0].childNodes[1].nodeValue, '0');

  parent.destroy();
  assert.deepEqual(target.childNodes, []);
});

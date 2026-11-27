const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { compile, compileServer } = require('../src/compiler');

const fixturesDirectory = path.join(__dirname, 'fixtures');
const fixturePath = 'test/fixtures/hydration.wizz';
const loadFixture = () => fs.readFileSync(path.join(fixturesDirectory, 'hydration.wizz'), 'utf8');

async function flushUpdates() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// A DOM shim with the surface a real browser exposes to hydration: nodeType,
// uppercased tagName, firstElementChild, comment nodes, and element-level
// removeChild. createElement/createTextNode/text-write calls are counted so
// tests can prove hydration adopts markup instead of recreating it.
function createEnhancedDocument() {
  const elements = new Map();
  const metrics = { elements: 0, textNodes: 0, textWrites: 0, addedListeners: 0, removedListeners: 0, createdNames: [] };

  // Real DOM sibling lookup through the tracked parent; a component that is
  // an each item's root reads its anchor's previous sibling after mounting.
  function previousSiblingOf(node) {
    const parent = node.parentNode;
    if (!parent) return null;
    const index = parent.childNodes.indexOf(node);
    return index > 0 ? parent.childNodes[index - 1] : null;
  }

  function makeTextNode(initialValue) {
    return {
      nodeType: 3,
      parentNode: null,
      get previousSibling() { return previousSiblingOf(this); },
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
      nodeName: name.toUpperCase(),
      tagName: name.toUpperCase(),
      attributes: {},
      childNodes: [],
      listeners: {},
      parentNode: null,
      get previousSibling() { return previousSiblingOf(this); },
      setAttribute(attributeName, value) {
        this.attributes[attributeName] = String(value);
        if (attributeName === 'data-wizz-id') {
          elements.set(`[data-wizz-id="${value}"]`, this);
        }
      },
      removeAttribute(attributeName) {
        delete this.attributes[attributeName];
      },
      getAttribute(attributeName) {
        return this.attributes[attributeName] ?? null;
      },
      // Real DOM textContent concatenates descendant text; head verification
      // reads it on adopted title nodes, and the fresh-title path writes it.
      get textContent() {
        if (this.childNodes.some((node) => node.nodeType === 1)) return '';
        return this.childNodes.map((node) => (node.nodeType === 3 ? node.nodeValue : '')).join('');
      },
      set textContent(value) {
        this.childNodes.length = 0;
        this.childNodes.push(makeTextNode(value));
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
      // Browsers move an attached node and keep parentNode current; removal
      // checks in list reconciliation compare it.
      appendChild(node) {
        if (node.parentNode) node.parentNode.removeChild(node);
        this.childNodes.push(node);
        node.parentNode = this;
      },
      // Moves a node already in this parent, as list reconciliation relies on.
      insertBefore(node, referenceNode) {
        if (node.parentNode && node.parentNode !== this) node.parentNode.removeChild(node);
        const currentIndex = this.childNodes.indexOf(node);
        if (currentIndex !== -1) this.childNodes.splice(currentIndex, 1);
        const index = referenceNode ? this.childNodes.indexOf(referenceNode) : this.childNodes.length;
        this.childNodes.splice(index, 0, node);
        node.parentNode = this;
      },
      removeChild(node) {
        const index = this.childNodes.indexOf(node);
        if (index === -1) throw new Error('removeChild: the node is not a child of this element');
        this.childNodes.splice(index, 1);
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

  // The document head, with the parentNode-tracking surface the head helpers
  // use: insertBefore/appendChild/removeChild maintain `node.parentNode`
  // (claim/release depend on it), and querySelectorAll answers the
  // `title[data-wizz-head]` ownership probe.
  const headElement = {
    nodeType: 1,
    name: 'head',
    nodeName: 'HEAD',
    tagName: 'HEAD',
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
      // Browsers move an already-attached node rather than duplicating it.
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
    metrics,
    makeElement,
    makeTextNode,
    head: headElement,
    createElement(name) {
      metrics.elements++;
      metrics.createdNames.push(name);
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

// The escaping rules of the server target, replicated so delivered markup can
// be re-serialized and compared byte-for-byte.
const decodeEntities = (value) => value.replace(
  /&(amp|lt|gt|quot);/g,
  (_, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"' })[entity]
);

// Parses delivered markup into shim DOM. Whitespace text is preserved
// verbatim, the entities the server escaped are decoded again, comment
// markers survive as nodes, and data-wizz-id targets are registered for
// update()-time lookups. Real browsers uppercase tagName; so does this.
function parseMarkup(markup, document) {
  const voidElements = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const root = { name: null, childNodes: [] };
  const stack = [root];
  let index = 0;

  while (index < markup.length) {
    const parent = stack[stack.length - 1];

    if (markup.startsWith('<!--', index)) {
      const end = markup.indexOf('-->', index + 4);
      if (end === -1) throw new Error('Unterminated comment in delivered markup');
      parent.childNodes.push({ nodeType: 8, nodeValue: markup.slice(index + 4, end), parentNode: parent.name === null ? null : parent });
      index = end + 3;
      continue;
    }

    if (markup.startsWith('</', index)) {
      const end = markup.indexOf('>', index);
      if (end === -1) throw new Error('Unterminated closing tag in delivered markup');
      const closing = markup.slice(index + 2, end).trim();
      if (parent.name !== closing) {
        throw new Error(`Mismatched closing tag </${closing}> in delivered markup`);
      }
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
      if (parent.name !== null) element.parentNode = parent;
      parent.childNodes.push(element);
      // Void and self-closed elements take no end tag, so they are never
      // pushed onto the open-element stack.
      if (!selfClosing && !voidElements.has(name.toLowerCase())) stack.push(element);
      index = end + 1;
      continue;
    }

    const nextTag = markup.indexOf('<', index);
    const text = markup.slice(index, nextTag === -1 ? markup.length : nextTag);
    // Parsed text nodes share the counting shim's value setter so reactive
    // writes onto adopted markup are observable.
    const textNode = document.makeTextNode(decodeEntities(text));
    if (parent.name !== null) textNode.parentNode = parent;
    parent.childNodes.push(textNode);
    index = nextTag === -1 ? markup.length : nextTag;
  }

  if (stack.length > 1) throw new Error(`Unclosed tag <${stack[stack.length - 1].name}> in delivered markup`);
  return root.childNodes;
}

// Places the delivered markup inside the mount point exactly as a browser
// would have parsed it, and hands back the state payload parsed out of the
// sibling delivery script.
function deliverMarkup(document, markup) {
  const target = document.makeElement('div');
  for (const node of parseMarkup(markup, document)) target.appendChild(node);
  return target;
}

function parseInitialStateScript(scriptTag) {
  const match = /^<script type="application\/wizz-state">(.*)<\/script>$/.exec(scriptTag);
  assert.ok(match, 'the delivery script uses the wizz-state type');
  return JSON.parse(match[1]);
}

// Escaping mirrors of the server target, used to re-serialize the adopted DOM
// and compare it byte-for-byte with the delivered markup (minus markers).
const escapeText = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttribute = (value) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function serializeElement(element) {
  const attributes = Object.entries(element.attributes)
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join('');
  const children = element.childNodes.map((child) => {
    if (child.nodeType === 3) return escapeText(child.nodeValue);
    if (child.nodeType === 1) return serializeElement(child);
    return '';
  }).join('');
  return `<${element.name}${attributes}>${children}</${element.name}>`;
}

// Compiles both targets for the fixture (or an inline source override) into
// a temporary ESM project and imports them (cache-busted) with the shim
// document installed.
async function loadGeneratedModules(t, sourceOverride = null) {
  const source = sourceOverride ?? loadFixture();
  const projectDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-hydration-test-'));
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(projectDirectory, 'package.json'), '{"type":"module"}');

  const { source: serverSource } = compileServer(source, { filePath: fixturePath });
  fs.writeFileSync(path.join(projectDirectory, 'server.js'), serverSource);
  const { source: clientSource } = compile(source, { filePath: fixturePath, hydratable: true });
  fs.writeFileSync(path.join(projectDirectory, 'client.js'), clientSource);

  const bust = `?test=${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const serverModule = await import(`${pathToFileURL(path.join(projectDirectory, 'server.js')).href}${bust}`);

  const document = createEnhancedDocument();
  const originalDocument = global.document;
  global.document = document;
  t.after(() => { global.document = originalDocument; });
  const clientModule = await import(`${pathToFileURL(path.join(projectDirectory, 'client.js')).href}${bust}`);

  const metricsBefore = { ...document.metrics };
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  t.after(() => { console.warn = originalWarn; });

  return {
    document,
    clientModule,
    serverModule,
    metricsBefore,
    warnings,
    render() {
      const { html, state } = serverModule.renderComponent();
      return { html, state, stateScript: serverModule.serializeInitialState(state) };
    }
  };
}

const findSection = (target) => target.firstElementChild;
const findParagraph = (section) => section.childNodes[3];
const findButton = (section) => section.childNodes[5];

test('delivers server HTML and hydrates it without duplicate DOM or divergent state', async (t) => {
  const { document, clientModule, metricsBefore, warnings, render } = await loadGeneratedModules(t);

  // Delivery shape: the mount point receives only markup; the serialized
  // state travels in its own sibling script tag.
  const { html, state, stateScript } = render();
  assert.deepEqual(state, parseInitialStateScript(stateScript), 'the state script round-trips');
  const target = deliverMarkup(document, html);
  assert.equal(findSection(target).name, 'section');

  const component = clientModule.hydrateComponent(target, {}, parseInitialStateScript(stateScript));

  assert.equal(warnings.length, 0);
  assert.ok(component);
  // Nothing was created: every node in the mount point predates hydration.
  assert.equal(document.metrics.elements, metricsBefore.elements);
  assert.equal(document.metrics.textNodes, metricsBefore.textNodes);
  // The initial update converges: exactly the reactive text is rewritten once.
  assert.equal(document.metrics.textWrites, metricsBefore.textWrites + 1);
  assert.equal(document.metrics.addedListeners, metricsBefore.addedListeners + 1);

  // The adopted markup is byte-identical to what the server delivered.
  assert.equal(serializeElement(findSection(target)), html.replace(/<!-- -->/g, ''));

  // Events work on the adopted nodes and drive both reactive outputs.
  findButton(findSection(target)).dispatchEvent('click');
  await flushUpdates();
  assert.equal(findParagraph(findSection(target)).childNodes[1].nodeValue, '1');
  assert.equal(findParagraph(findSection(target)).attributes['data-note'], 'clicked');
  assert.equal(document.metrics.textWrites, metricsBefore.textWrites + 2);

  component.destroy();
  assert.deepEqual(target.childNodes, []);
  assert.equal(document.metrics.removedListeners, 1);
});

test('hydration falls back to a client mount with one warning on tampered text', async (t) => {
  const { document, clientModule, metricsBefore, warnings, render } = await loadGeneratedModules(t);
  const { html, state } = render();

  const target = deliverMarkup(document, html);
  const section = findSection(target);
  // Simulate markup/state drift: the delivered text no longer matches state.
  findParagraph(section).childNodes[2].nodeValue = '999';

  const component = clientModule.hydrateComponent(target, {}, state);

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^\[wizz\] hydration mismatch: /);
  assert.match(warnings[0], /Falling back to client rendering\.$/);
  // The fallback recreated the tree client-side in the same mount point.
  assert.equal(document.metrics.elements, metricsBefore.elements + 4);
  assert.notEqual(findSection(target), section);
  assert.equal(target.childNodes.length, 1);

  // The fallback component is fully reactive on its fresh DOM (which carries
  // no server markers, so the expression text sits at index 1).
  findButton(findSection(target)).dispatchEvent('click');
  await flushUpdates();
  assert.equal(findParagraph(findSection(target)).childNodes[1].nodeValue, '1');

  component.destroy();
  assert.deepEqual(target.childNodes, []);
});

test('hydration falls back when the mount point is empty, mistagged, or has extra nodes', async (t) => {
  const { document, clientModule, metricsBefore, warnings, render } = await loadGeneratedModules(t);
  const { html, state } = render();

  const emptyTarget = document.makeElement('div');
  clientModule.hydrateComponent(emptyTarget, {}, state);
  assert.match(warnings[0], /expected root <section>, found nothing/);
  assert.equal(emptyTarget.childNodes.length, 1, 'the fallback mounted client-side');

  const mistaggedTarget = document.makeElement('div');
  mistaggedTarget.appendChild(document.makeElement('span'));
  clientModule.hydrateComponent(mistaggedTarget, {}, state);
  assert.match(warnings[1], /expected root <section>, found <span>/);
  // Two fallback trees (4 elements each); the mistagged span was mounted as
  // delivered markup, not created by the client fallback.
  assert.equal(document.metrics.elements, metricsBefore.elements + 8, 'one client tree per fallback');

  const crowdedTarget = deliverMarkup(document, html);
  const section = findSection(crowdedTarget);
  section.appendChild(document.createTextNode('\n'));
  clientModule.hydrateComponent(crowdedTarget, {}, state);
  assert.match(warnings[2], /expected 7 child nodes in <section>, found 8/);
  assert.notEqual(findSection(crowdedTarget), section, 'the mistagged tree was replaced client-side');
});

test('a hostile __proto__ state key cannot pollute prototypes while hydrating', async (t) => {
  const { document, clientModule, warnings, render } = await loadGeneratedModules(t);
  const { html } = render();

  const hostileState = JSON.parse('{"__proto__":{"polluted":true},"count":0}');
  const target = deliverMarkup(document, html);
  const component = clientModule.hydrateComponent(target, {}, hostileState);

  assert.equal(warnings.length, 0);
  assert.ok(component);
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.keys(Object.prototype).length, 0);

  // Hydration proceeded normally and stays reactive.
  findButton(findSection(target)).dispatchEvent('click');
  await flushUpdates();
  assert.equal(findParagraph(findSection(target)).childNodes[1].nodeValue, '1');
  component.destroy();
});

// Compiles the parent and child of a nested delivery into one temporary ESM
// project, so the generated cross-module imports (`__wizzServer_*` and
// `__wizzHydrate_*`) resolve through the real module loader exactly as they
// do in a built application.
async function loadNestedModules(t, parentSource, childSource) {
  const projectDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-nested-hydration-'));
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(projectDirectory, 'package.json'), '{"type":"module"}');

  const childPath = path.join(projectDirectory, 'Counter.wizz');

  // Child builds first: the parent's generated modules import them.
  const { source: childServerSource } = compileServer(childSource, { filePath: childPath });
  fs.writeFileSync(path.join(projectDirectory, 'Counter.server.js'), childServerSource);
  const { source: childClientSource } = compile(childSource, { filePath: childPath });
  fs.writeFileSync(path.join(projectDirectory, 'Counter.js'), childClientSource);
  const { source: childHydrateSource } = compile(childSource, { filePath: childPath, hydratable: true });
  fs.writeFileSync(path.join(projectDirectory, 'Counter.hydrate.js'), childHydrateSource);

  const { source: serverSource } = compileServer(parentSource, {
    filePath: 'test/nested/Page.wizz',
    componentServerRenderable: { Counter: true }
  });
  fs.writeFileSync(path.join(projectDirectory, 'server.js'), serverSource);
  const { source: clientSource } = compile(parentSource, {
    filePath: 'test/nested/Page.wizz',
    hydratable: true,
    componentServerRenderable: { Counter: true }
  });
  fs.writeFileSync(path.join(projectDirectory, 'client.js'), clientSource);

  // The plain (non-hydratable) client module gives fresh-mount coverage of the
  // same template: no adoption walk, create() alone captures the update targets.
  const { source: freshClientSource } = compile(parentSource, {
    filePath: 'test/nested/Page.wizz',
    componentServerRenderable: { Counter: true }
  });
  fs.writeFileSync(path.join(projectDirectory, 'fresh-client.js'), freshClientSource);

  const bust = `?test=${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const serverModule = await import(`${pathToFileURL(path.join(projectDirectory, 'server.js')).href}${bust}`);

  const document = createEnhancedDocument();
  const originalDocument = global.document;
  global.document = document;
  t.after(() => { global.document = originalDocument; });
  const clientModule = await import(`${pathToFileURL(path.join(projectDirectory, 'client.js')).href}${bust}`);
  const freshClientModule = await import(`${pathToFileURL(path.join(projectDirectory, 'fresh-client.js')).href}${bust}`);

  const metricsBefore = { ...document.metrics };
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  t.after(() => { console.warn = originalWarn; });

  return {
    document,
    clientModule,
    freshClientModule,
    metricsBefore,
    warnings,
    render() {
      const { html, head, state } = serverModule.renderComponent();
      return { html, head, state, stateScript: serverModule.serializeInitialState(state) };
    }
  };
}

test('nested component delivery hydrates in place with zero recreation', async (t) => {
  // The motivating case: any page importing a component used to go
  // client-only. Now the page server-renders the child's markup and both
  // templates adopt their delivered nodes.
  const parentSource = '<script>\nimport Counter from "./Counter.wizz";\nlet greeting = "Hi";\n</script><main><h1>{greeting}</h1><Counter /></main>';
  const childSource = '<script>let count = 3; function increment() { count += 1; }</script><div><button on:click={increment}>Clicks: {count}</button></div>';
  const { document, clientModule, metricsBefore, warnings, render } = await loadNestedModules(t, parentSource, childSource);

  const { html, state, stateScript } = render();
  // The child's rendered root occupies the component-tag position, and the
  // child's state rides under the reserved __wizz key. Elements holding
  // reactive children carry their analyzer-assigned data-wizz-id in both
  // templates (each template's own counter).
  assert.equal(html, '<main><h1 data-wizz-id="1">Hi</h1><div><button data-wizz-id="1">Clicks: <!-- -->3</button></div></main>');
  assert.deepEqual(state, { greeting: 'Hi', __wizz: { components: { '1': { count: 3 } } } });
  assert.deepEqual(state, JSON.parse(stateScript.match(/^<script type="application\/wizz-state">(.*)<\/script>$/)[1]));

  const target = deliverMarkup(document, html);
  const parent = clientModule.hydrateComponent(target, {}, state);

  assert.equal(warnings.length, 0);
  assert.ok(parent);
  // Zero recreation across BOTH templates: parent shell and child root are
  // all delivered nodes.
  assert.equal(document.metrics.elements, metricsBefore.elements);
  assert.equal(document.metrics.textNodes, metricsBefore.textNodes);
  assert.equal(document.metrics.addedListeners, metricsBefore.addedListeners + 1);

  // The child's handler works on its adopted nodes (the walk stripped the
  // marker, so the expression text sits at index 1).
  const button = target.childNodes[0].childNodes[1].childNodes[0];
  assert.equal(button.name, 'button');
  button.dispatchEvent('click');
  await flushUpdates();
  assert.equal(button.childNodes[1].nodeValue, '4');
  // Exactly three reactive writes so far: the parent's initial greeting
  // convergence, the child's initial count convergence, and the click.
  assert.equal(document.metrics.textWrites, metricsBefore.textWrites + 3);

  // Nested destroy: the child leaves its self-adopted root in place and the
  // parent's teardown removes the whole subtree at once.
  parent.destroy();
  assert.deepEqual(target.childNodes, []);
  assert.equal(document.metrics.removedListeners, 1);
});

test('nested prop updates flow into the adopted child through setProps', async (t) => {
  // The /contact case: a reactive parent binding re-applied to an adopted
  // child flips the child's delivered text without recreating it.
  const parentSource = '<script>\nimport Counter from "./Counter.wizz";\nlet myName = "Paul";\nfunction rename() { myName = "Duncan"; }\n</script><main><button on:click={rename}>Go</button><Counter name={myName} /></main>';
  const childSource = '<script>export let name = "";</script><p>{name}</p>';
  const { document, clientModule, metricsBefore, warnings, render } = await loadNestedModules(t, parentSource, childSource);

  const { html, state } = render();
  assert.equal(html, '<main><button>Go</button><p data-wizz-id="1">Paul</p></main>');

  const target = deliverMarkup(document, html);
  const parent = clientModule.hydrateComponent(target, {}, state);

  assert.equal(warnings.length, 0);
  assert.equal(document.metrics.elements, metricsBefore.elements);
  assert.equal(document.metrics.textNodes, metricsBefore.textNodes);

  const button = target.childNodes[0].childNodes[0];
  button.dispatchEvent('click');
  await flushUpdates();
  // The child's adopted <p> text flipped via setProps, not recreation.
  assert.equal(target.childNodes[0].childNodes[1].childNodes[0].nodeValue, 'Duncan');
  assert.equal(document.metrics.elements, metricsBefore.elements);

  parent.destroy();
  assert.deepEqual(target.childNodes, []);
});

test('escaping survives the full round trip for hostile text and attribute content', () => {
  // Top-level script strings are trusted, but their output still passes
  // through the escaping boundary: markup characters can never escape their
  // text or attribute context.
  const { source: serverSource } = compileServer(
    `<script>const payload = '"<b>&amp;'</script><p title={payload}>{payload}</p>`,
    { filePath: fixturePath }
  );
  const module = new Function(
    `${serverSource
      .replace('export function renderComponent(', 'function renderComponent(')
      .replace('export { __wizzSerializeInitialState as serializeInitialState };', '')
    }\nreturn { renderComponent };`
  )();

  const { html } = module.renderComponent();
  // Quotes stay literal in text context (harmless there) but are escaped
  // inside attributes.
  assert.equal(
    html,
    '<p title="&quot;&lt;b&gt;&amp;amp;">"&lt;b&gt;&amp;amp;</p>'
  );

  // A browser parser decodes the escapes back to exactly the raw values, and
  // no extra element can appear from the injected markup characters.
  const document = createEnhancedDocument();
  const target = deliverMarkup(document, html);
  const paragraph = target.firstElementChild;
  assert.equal(paragraph.name, 'p');
  assert.deepEqual(target.childNodes.length, 1);
  assert.equal(paragraph.attributes.title, '"<b>&amp;');
  assert.equal(paragraph.childNodes.length, 1);
  assert.equal(paragraph.childNodes[0].nodeValue, '"<b>&amp;');
});

// Compiles both targets for an inline head-declaring page into a temporary
// ESM project and imports them (cache-busted) with the shim document and a
// pre-seeded shell title installed.
async function loadHeadModules(t, pageSource, compileOptions = {}) {
  const projectDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-head-test-'));
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(projectDirectory, 'package.json'), '{"type":"module"}');

  const { source: serverSource } = compileServer(pageSource, { filePath: 'src/Page.wizz', ...compileOptions });
  fs.writeFileSync(path.join(projectDirectory, 'server.js'), serverSource);
  const { source: clientSource } = compile(pageSource, { filePath: 'src/Page.wizz', hydratable: true, ...compileOptions });
  fs.writeFileSync(path.join(projectDirectory, 'client.js'), clientSource);

  const bust = `?test=${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const serverModule = await import(`${pathToFileURL(path.join(projectDirectory, 'server.js')).href}${bust}`);

  const document = createEnhancedDocument();
  // A title authored by the static shell (outside any wizz component) — it
  // must survive component mounts and resume as the active title when the
  // component's head is released.
  const shellTitle = document.createElement('title');
  shellTitle.textContent = 'Shell';
  document.head.appendChild(shellTitle);

  const originalDocument = global.document;
  global.document = document;
  t.after(() => { global.document = originalDocument; });
  const clientModule = await import(`${pathToFileURL(path.join(projectDirectory, 'client.js')).href}${bust}`);

  const metricsBefore = { ...document.metrics };
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  t.after(() => { console.warn = originalWarn; });

  const render = () => {
    const { html, head, state } = serverModule.renderComponent();
    return { html, head, state, stateScript: serverModule.serializeInitialState(state) };
  };
  return { document, clientModule, metricsBefore, warnings, render };
}

// Places the delivered head run into document.head exactly as the dev server
// would have emitted it into the page: marker-delimited, after any shell nodes.
function deliverHeadRun(document, headMarkup) {
  document.head.appendChild(document.createComment('wizz:head-start'));
  for (const node of parseMarkup(headMarkup, document)) document.head.appendChild(node);
  document.head.appendChild(document.createComment('wizz:head-end'));
}

test('delivers the component head and adopts it without duplication', async (t) => {
  const { document, clientModule, metricsBefore, warnings, render } = await loadHeadModules(
    t,
    '<wizz:head><title>Page {who}</title><meta name="x" content={tag}></wizz:head><main><h1>{who}</h1></main><script>\nlet who = "A";\nlet tag = "t1";\n</' + 'script>'
  );
  const { html, head, state } = render();

  assert.match(head, /^<title data-wizz-head-id="r" data-wizz-loc="src\/Page\.wizz:1:12">Page A<\/title><meta data-wizz-head-id="r" data-wizz-loc="src\/Page\.wizz:1:37" name="x" content="t1">$/);
  deliverHeadRun(document, head);
  const target = deliverMarkup(document, html);

  const component = clientModule.hydrateComponent(target, {}, state);

  assert.equal(warnings.length, 0);
  assert.ok(component);
  // Adoption created nothing: the delivered head nodes are claimed as-is.
  assert.equal(document.metrics.elements, metricsBefore.elements);
  assert.equal(document.metrics.textNodes, metricsBefore.textNodes);

  // Claimed ownership is re-tagged, the delivery tags consumed, and the
  // component title now leads the head (the one document.title reads).
  const titleNode = document.head.childNodes.find((node) => node.nodeName === 'TITLE' && node.textContent === 'Page A');
  const metaNode = document.head.childNodes.find((node) => node.nodeName === 'META');
  assert.equal(document.head.childNodes[0], titleNode);
  assert.equal(titleNode.attributes['data-wizz-head'], 'h1');
  assert.ok(!('data-wizz-head-id' in titleNode.attributes));
  assert.equal(metaNode.attributes['data-wizz-head'], 'h1');
  assert.ok(!('data-wizz-head-id' in metaNode.attributes));
  assert.deepEqual(
    document.head.childNodes.map((node) => node.nodeName),
    ['TITLE', 'TITLE', 'META'],
    'component title leads the head; the shell title and claimed meta follow'
  );
  // The marker-delimited run is fully consumed.
  assert.ok(!document.head.childNodes.some((node) => node.nodeValue === 'wizz:head-start' || node.nodeValue === 'wizz:head-end'));

  component.destroy();
  assert.deepEqual(
    document.head.childNodes.map((node) => node.nodeName),
    ['TITLE'],
    'release removes the adopted head and the shell title resumes'
  );
  assert.equal(document.head.childNodes[0].textContent, 'Shell');
});

test('a tampered delivered title falls back to a fresh head with no duplicates', async (t) => {
  const { document, clientModule, metricsBefore, warnings, render } = await loadHeadModules(
    t,
    '<wizz:head><title>Page {who}</title></wizz:head><main><h1>{who}</h1></main><script>\nlet who = "A";\n</' + 'script>'
  );
  const { html, head, state } = render();
  deliverHeadRun(document, head);

  // Simulate head drift: someone edited the delivered title between delivery
  // and hydration. The compile-time expectation no longer matches.
  const deliveredTitle = document.head.childNodes.find((node) => node.nodeName === 'TITLE' && node.textContent === 'Page A');
  deliveredTitle.childNodes[0].nodeValue = 'Tampered';

  const target = deliverMarkup(document, html);
  const component = clientModule.hydrateComponent(target, {}, state);

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^\[wizz\] hydration mismatch: /);
  assert.match(warnings[0], /head node 0 text mismatch/);
  assert.ok(component);

  // The stale run is stripped entirely and the fresh mount applied its own
  // head: exactly one wizz title with the correct evaluated text remains,
  // ahead of the shell title.
  const titles = document.head.childNodes.filter((node) => node.nodeName === 'TITLE');
  assert.deepEqual(titles.map((node) => node.textContent), ['Page A', 'Shell']);
  assert.ok(!document.head.childNodes.some((node) => node.nodeValue === 'wizz:head-start' || node.nodeValue === 'wizz:head-end'));
  assert.ok(!document.head.childNodes.some((node) => node.getAttribute('data-wizz-head-id') !== null));
  // The fallback remount recreates the body tree (main + h1) plus the fresh
  // title element — but nothing else in the head.
  assert.equal(document.metrics.elements, metricsBefore.elements + 3);
  // (createdNames indices align with the elements count, which the snapshot
  // predates.)
  assert.deepEqual(document.metrics.createdNames.slice(metricsBefore.elements), ['main', 'h1', 'title']);

  component.destroy();
  assert.deepEqual(document.head.childNodes.map((node) => node.nodeName), ['TITLE']);
});

test('extracted-style modules hydrate with no style node and no mismatch', async (t) => {
  const { document, clientModule, metricsBefore, warnings, render } = await loadHeadModules(
    t,
    '<main><h1>{who}</h1></main><wizz:style>h1 { color: red }</wizz:style><script>\nlet who = "A";\n</' + 'script>',
    { extractedStyles: true }
  );
  const { html, head, state } = render();

  assert.equal(head, undefined);
  const target = deliverMarkup(document, html);
  const main = target.childNodes[0];

  const component = clientModule.hydrateComponent(target, {}, state);

  assert.equal(warnings.length, 0);
  assert.equal(target.childNodes[0], main, 'the delivered root is adopted, not recreated');
  assert.equal(document.metrics.elements, metricsBefore.elements);
  assert.equal(document.head.childNodes.filter((node) => node.nodeName === 'STYLE').length, 0);
  component.destroy();
});

test('extracted-style modules still adopt a delivered head block', async (t) => {
  const { document, clientModule, warnings, render } = await loadHeadModules(
    t,
    '<main><h1>T</h1></main><wizz:head><title>Page</title></wizz:head><wizz:style>h1 { color: red }</wizz:style>',
    { extractedStyles: true }
  );
  const { html, head, state } = render();

  deliverHeadRun(document, head);
  const target = deliverMarkup(document, html);
  const component = clientModule.hydrateComponent(target, {}, state);

  assert.equal(warnings.length, 0);
  assert.equal(document.head.childNodes.filter((node) => node.nodeName === 'TITLE' && node.textContent === 'Page').length, 1);
  component.destroy();
});

test('delivered styles are adopted without duplication and refcounted', async (t) => {
  const { document, clientModule, metricsBefore, warnings, render } = await loadHeadModules(
    t,
    '<main><h1>{who}</h1></main><wizz:style>h1 { color: red }</wizz:style><script>\nlet who = "A";\n</' + 'script>'
  );
  const { html, head, state } = render();

  // The stylesheet rides the head run with no delivery tag of its own:
  // runtime scope dedup makes compile-time slice expectations impossible.
  assert.match(
    head,
    /^<style data-wizz-style="[a-z0-9]+" data-wizz-loc="src\/Page\.wizz:1:\d+">h1\[data-wizz-s="[a-z0-9]+"\] \{ color: red \}<\/style>$/
  );
  deliverHeadRun(document, head);
  const target = deliverMarkup(document, html);

  const component = clientModule.hydrateComponent(target, {}, state);

  assert.equal(warnings.length, 0);
  assert.ok(component);
  // The hydrate apply materializes a probe style node that adoption then
  // discards (never inserted) when the delivered copy is found by scope, so
  // exactly one stylesheet for the scope exists after hydration.
  assert.equal(document.metrics.elements, metricsBefore.elements + 1);
  assert.deepEqual(document.metrics.createdNames.slice(metricsBefore.elements), ['style']);
  const styles = document.head.childNodes.filter((node) => node.nodeName === 'STYLE');
  assert.equal(styles.length, 1);
  // The adopted copy is the delivered one, refcounted at 1.
  assert.equal(styles[0].attributes['data-wizz-refs'], '1');

  // Releasing on destroy drops the refcount to zero and removes the
  // stylesheet; the shell title resumes.
  component.destroy();
  assert.equal(document.head.childNodes.filter((node) => node.nodeName === 'STYLE').length, 0);
  assert.equal(document.head.childNodes[0].textContent, 'Shell');
});

test('a hydration fallback adopts the delivered style instead of duplicating it', async (t) => {
  const { document, clientModule, metricsBefore, warnings, render } = await loadHeadModules(
    t,
    '<main><h1>{who}</h1></main><wizz:style>h1 { color: red }</wizz:style><script>\nlet who = "A";\n</' + 'script>'
  );
  const { html, head, state } = render();
  deliverHeadRun(document, head);
  const target = deliverMarkup(document, html);

  // Simulate body drift between delivery and hydration so the adopt fails
  // and the mount falls back to a fresh client mount.
  const deliveredHeading = target.childNodes.find((node) => node.nodeName === 'MAIN')
    .childNodes.find((node) => node.nodeName === 'H1');
  deliveredHeading.childNodes[0].nodeValue = 'Tampered';

  const component = clientModule.hydrateComponent(target, {}, state);

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^\[wizz\] hydration mismatch: /);
  assert.ok(component);

  // The fallback's fresh apply found the delivered stylesheet in the head by
  // scope and adopted it — still exactly one style tag, now refcounted.
  const styles = document.head.childNodes.filter((node) => node.nodeName === 'STYLE');
  assert.equal(styles.length, 1);
  assert.equal(styles[0].attributes['data-wizz-refs'], '1');
  // The fallback remount recreated the body tree (main + h1) plus the
  // discarded probe style node.
  assert.deepEqual(document.metrics.createdNames.slice(metricsBefore.elements), ['main', 'h1', 'style']);

  component.destroy();
  assert.equal(document.head.childNodes.filter((node) => node.nodeName === 'STYLE').length, 0);
});

test('Card-shaped markup with pre-family and empty elements adopts without fallback', async (t) => {
  // The showcase regression: an empty `<path></path>` inside an svg and an
  // empty `<code></code>` inside a pre once delivered without end tags, so
  // the browser kept them open and swallowed the following markup (svg's
  // trailing text became the path's child; pre's became the code's child) —
  // the walk fell back behind a mismatch warning. The pre's authoring
  // newline is the second half: the browser drops it from the delivered
  // markup, so the AST must not carry it either. The test shim parses
  // delivered markup literally, which only agrees with a real browser when
  // the delivery is balanced and pre-normalized — exactly the contract the
  // two compiler fixes establish.
  const source = [
    '<div class="terminal">',
    '  <svg width="16px" viewBox="0 0 24 24"><path d="M7 15L10 12L7 9"></path></svg>',
    '  <pre>',
    '    <code>- </code>',
    '    <code>wizz </code>',
    '    <code class="cmd"></code>',
    '  </pre>',
    '  <span></span>',
    '</div>'
  ].join('\n');
  const { document, clientModule, metricsBefore, warnings, render } = await loadGeneratedModules(t, source);

  const { html } = render();
  // Balanced delivery: every non-void element closes, and the pre's
  // authoring newline is absent while interior newlines survive.
  assert.equal(
    html,
    '<div class="terminal">\n'
    + '  <svg width="16px" viewBox="0 0 24 24"><path d="M7 15L10 12L7 9"></path></svg>\n'
    + '  <pre>    <code>- </code>\n    <code>wizz </code>\n    <code class="cmd"></code>\n  </pre>  <span></span>\n'
    + '</div>'
  );

  const target = deliverMarkup(document, html);
  const deliveredRoot = findSection(target);
  const component = clientModule.hydrateComponent(target, {}, {});

  assert.equal(warnings.length, 0);
  assert.ok(component);
  // Full adoption: nothing was recreated.
  assert.equal(document.metrics.elements, metricsBefore.elements);
  assert.equal(document.metrics.textNodes, metricsBefore.textNodes);

  // The svg's trailing structure stayed outside the path: the closed path
  // holds no children and the svg's shape is exactly the template's.
  const svg = deliveredRoot.childNodes[1];
  const deliveredPath = svg.childNodes[0];
  assert.equal(deliveredPath.name, 'path');
  assert.deepEqual(deliveredPath.childNodes, []);

  // The empty code stayed empty and pre's trailing text remained its
  // sibling, not its child: seven child positions, text last.
  const pre = deliveredRoot.childNodes[3];
  assert.equal(pre.name, 'pre');
  assert.equal(pre.childNodes.length, 7);
  assert.equal(pre.childNodes[5].name, 'code');
  assert.deepEqual(pre.childNodes[5].childNodes, []);
  assert.equal(pre.childNodes[6].nodeType, 3);
  assert.equal(pre.childNodes[6].nodeValue, '\n  ');

  // The empty span between pre and the root's close kept its position.
  assert.equal(deliveredRoot.childNodes[5].name, 'span');
  assert.deepEqual(deliveredRoot.childNodes[5].childNodes, []);

  component.destroy();
  assert.deepEqual(target.childNodes, []);
});

// --- Update targets (issue #63) ---
// update() writes through references captured by create() or the adoption
// walk. It used to look targets up with querySelector('[data-wizz-id="N"]') and
// childNodes[templateIndex]: the first crossed into child components, which
// number their own elements from 1 too, and the second assumed template
// positions match DOM positions, which fails beside late-mounted children,
// untaken branches, and list items.
const labelChildSource = '<script>\n  export let text = "child";\n</script>\n\n<span class="label">{text}</span>\n';
const noChildSource = '<script>\n  let label = "child";\n</script>\n\n<span>{label}</span>\n';

const mountBothWays = {
  'fresh mount': async (t, parentSource, childSource = noChildSource) => {
    const modules = await loadNestedModules(t, parentSource, childSource);
    const target = modules.document.makeElement('div');
    const component = modules.freshClientModule.default(target);
    return { ...modules, target, component };
  },
  hydration: async (t, parentSource, childSource = noChildSource) => {
    const modules = await loadNestedModules(t, parentSource, childSource);
    const { html, state } = modules.render();
    const target = deliverMarkup(modules.document, html);
    const component = modules.clientModule.hydrateComponent(target, {}, state);
    assert.deepEqual(modules.warnings, [], 'the delivered tree adopts cleanly');
    return { ...modules, target, component, html };
  }
};

const elementsNamed = (root, name, found = []) => {
  for (const child of root.childNodes || []) {
    if (typeof child.tagName === 'string' && child.tagName.toLowerCase() === name) found.push(child);
    elementsNamed(child, name, found);
  }
  return found;
};
const textOf = (node) => (node.childNodes || []).filter((child) => child.nodeType === 3).map((child) => child.nodeValue).join('');

test('issue #63 repro: a hydrated parent writes to its own input, not the child span', async (t) => {
  const parentSource = '<script>\n  import Counter from "./Counter.wizz";\n  let draft = "typed";\n  function clear() {\n    draft = "";\n  }\n</script>\n\n'
    + '<main class="repro">\n  <Counter text="child" />\n  <input value={draft} aria-label="draft" />\n  <button on:click={clear}>Clear</button>\n</main>\n';
  const { target, component } = await mountBothWays.hydration(t, parentSource, labelChildSource);

  const [input] = elementsNamed(target, 'input');
  const [span] = elementsNamed(target, 'span');
  const [button] = elementsNamed(target, 'button');
  assert.equal(span.attributes['data-wizz-id'], input.attributes['data-wizz-id'], 'both templates stamp the same id');
  button.dispatchEvent('click');
  await flushUpdates();

  assert.equal(input.value, '');
  assert.equal('value' in span, false, 'the child span never receives the parent write');
  component.destroy();
});

for (const [mode, mount] of Object.entries(mountBothWays)) {
  test(`${mode}: a nested child with colliding ids never captures parent writes`, async (t) => {
    const parentSource = '<script>\nimport Counter from "./Counter.wizz";\nlet tab = "Parser";\nfunction pick() { tab = "Analyzer"; }\n</script>'
      + '<main><section><Counter /></section><nav><button on:click={pick}>{tab}</button></nav></main>';
    const { target, component } = await mount(t, parentSource);
    const [span] = elementsNamed(target, 'span');
    const [button] = elementsNamed(target, 'button');
    assert.equal(span.attributes['data-wizz-id'], button.attributes['data-wizz-id'], 'both templates stamp the same id');

    button.dispatchEvent('click');
    await flushUpdates();

    assert.equal(textOf(button), 'Analyzer');
    assert.equal(textOf(span), 'child');
    component.destroy();
    assert.deepEqual(target.childNodes, []);
  });

  test(`${mode}: a parent attribute write skips a colliding nested child`, async (t) => {
    const parentSource = '<script>\nimport Counter from "./Counter.wizz";\nlet tone = "calm";\nfunction heat() { tone = "hot"; }\n</script>'
      + '<main><section><Counter /></section><p title={tone}>x</p><button on:click={heat}>go</button></main>';
    const { target, component } = await mount(t, parentSource);
    const [p] = elementsNamed(target, 'p');
    const [span] = elementsNamed(target, 'span');
    elementsNamed(target, 'button')[0].dispatchEvent('click');
    await flushUpdates();

    assert.equal(p.attributes.title, 'hot');
    assert.equal(span.attributes.title, undefined);
    component.destroy();
  });

  test(`${mode}: reactive text beside a child component updates its own text node`, async (t) => {
    const parentSource = '<script>\nimport Counter from "./Counter.wizz";\nlet count = 0;\nfunction inc() { count += 1; }\n</script>'
      + '<main><Counter />{count}<button on:click={inc}>+</button></main>';
    const { target, component } = await mount(t, parentSource);
    const [main] = elementsNamed(target, 'main');
    const [button] = elementsNamed(target, 'button');

    button.dispatchEvent('click');
    await flushUpdates();
    button.dispatchEvent('click');
    await flushUpdates();

    assert.equal(textOf(main), '2');
    assert.equal(textOf(button), '+');
    component.destroy();
  });

  test(`${mode}: reactive text after an untaken branch updates its own text node`, async (t) => {
    const parentSource = '<script>\nlet show = false;\nlet count = 0;\nfunction inc() { count += 1; }\n</script>'
      + '<main>{#if show}<p>hidden</p>{/if}{count}<button on:click={inc}>+</button></main>';
    const { target, component } = await mount(t, parentSource);
    const [button] = elementsNamed(target, 'button');
    button.dispatchEvent('click');
    await flushUpdates();

    assert.equal(textOf(elementsNamed(target, 'main')[0]), '1');
    assert.equal(textOf(button), '+');
    component.destroy();
  });

  test(`${mode}: reactive text after a list keeps its node as the list resizes`, async (t) => {
    const parentSource = '<script>\nlet rows = ["a"];\nlet count = 0;\nfunction grow() { rows = ["a", "b", "c"]; count += 1; }\nfunction shrink() { rows = []; count += 1; }\n</script>'
      + '<main><ul>{#each rows as row}<li>{row}</li>{/each}{count}</ul><button on:click={grow}>g</button><em on:click={shrink}>s</em></main>';
    const { target, component } = await mount(t, parentSource);
    const [ul] = elementsNamed(target, 'ul');

    elementsNamed(target, 'button')[0].dispatchEvent('click');
    await flushUpdates();
    assert.equal(elementsNamed(ul, 'li').length, 3);
    assert.equal(textOf(ul), '1');

    elementsNamed(target, 'em')[0].dispatchEvent('click');
    await flushUpdates();
    assert.equal(elementsNamed(ul, 'li').length, 0);
    assert.equal(textOf(ul), '2');
    component.destroy();
  });

  test(`${mode}: reactive content in an untaken branch mounts without throwing and stays inert`, async (t) => {
    const parentSource = '<script>\nlet show = false;\nlet count = 0;\nfunction inc() { count += 1; }\n</script>'
      + '<main>{#if show}<p title={count}>{count}</p>{:else}<i>none</i>{/if}<button on:click={inc}>{count}</button></main>';
    const { target, component } = await mount(t, parentSource);
    const [button] = elementsNamed(target, 'button');
    button.dispatchEvent('click');
    await flushUpdates();

    assert.equal(textOf(button), '1', 'a skipped branch write must not abort the rest of the pass');
    assert.equal(elementsNamed(target, 'p').length, 0);
    component.destroy();
  });

  test(`${mode}: a reactive expression placed directly in a taken branch updates`, async (t) => {
    const parentSource = '<script>\nlet show = true;\nlet count = 0;\nfunction inc() { count += 1; }\n</script>'
      + '<main><p>{#if show}{count}{:else}off{/if}</p><button on:click={inc}>+</button></main>';
    const { target, component } = await mount(t, parentSource);
    elementsNamed(target, 'button')[0].dispatchEvent('click');
    await flushUpdates();

    assert.equal(textOf(elementsNamed(target, 'p')[0]), '1');
    component.destroy();
  });

  test(`${mode}: an author variable cannot collide with the generated target names`, async (t) => {
    const parentSource = '<script>\nlet target_1 = "a";\nfunction change() { target_1 = "c"; }\n</script>'
      + '<main title={target_1}>{target_1}<button on:click={change}>go</button></main>';
    const { target, component } = await mount(t, parentSource);
    const [main] = elementsNamed(target, 'main');
    elementsNamed(target, 'button')[0].dispatchEvent('click');
    await flushUpdates();

    assert.equal(main.attributes.title, 'c');
    assert.equal(textOf(main), 'c');
    component.destroy();
  });

  test(`${mode}: a write queued before destroy never reaches the torn-down nodes`, async (t) => {
    const parentSource = '<script>\nlet count = 0;\nfunction inc() { count += 1; }\n</script>'
      + '<main><p>{count}</p><button on:click={inc}>+</button></main>';
    const { target, component } = await mount(t, parentSource);
    const [p] = elementsNamed(target, 'p');
    elementsNamed(target, 'button')[0].dispatchEvent('click');
    component.destroy();
    await flushUpdates();

    assert.equal(textOf(p), '0');
    assert.deepEqual(target.childNodes, []);
  });
}

test('two mounts of one component keep separate update targets', async (t) => {
  const parentSource = '<script>\nlet count = 0;\nfunction inc() { count += 1; }\n</script>'
    + '<main><p>{count}</p><button on:click={inc}>+</button></main>';
  const { document, freshClientModule } = await loadNestedModules(t, parentSource, noChildSource);
  const firstTarget = document.makeElement('div');
  const secondTarget = document.makeElement('div');
  const first = freshClientModule.default(firstTarget);
  const second = freshClientModule.default(secondTarget);

  elementsNamed(firstTarget, 'button')[0].dispatchEvent('click');
  await flushUpdates();
  assert.equal(textOf(elementsNamed(firstTarget, 'p')[0]), '1');
  assert.equal(textOf(elementsNamed(secondTarget, 'p')[0]), '0');

  first.destroy();
  elementsNamed(secondTarget, 'button')[0].dispatchEvent('click');
  await flushUpdates();
  assert.equal(textOf(elementsNamed(secondTarget, 'p')[0]), '1');
  second.destroy();
});

test('a failed adoption discards captured targets and the fallback captures its own', async (t) => {
  const parentSource = '<script>\nimport Counter from "./Counter.wizz";\nlet tab = "Parser";\nfunction pick() { tab = "Analyzer"; }\n</script>'
    + '<main><section><Counter /></section><nav><button on:click={pick}>{tab}</button></nav></main>';
  const { document, clientModule, warnings, render } = await loadNestedModules(t, parentSource, noChildSource);
  const { html, state } = render();
  const target = deliverMarkup(document, html);
  const [staleMain] = elementsNamed(target, 'main');
  const [staleButton] = elementsNamed(target, 'button');
  staleButton.setAttribute('data-wizz-id', '999');

  const component = clientModule.hydrateComponent(target, {}, state);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /expected data-wizz-id="1" on <button>/);
  assert.notEqual(target.childNodes[0], staleMain, 'the fallback recreated the tree');

  const [freshButton] = elementsNamed(target, 'button');
  freshButton.dispatchEvent('click');
  await flushUpdates();
  assert.equal(textOf(freshButton), 'Analyzer');
  assert.equal(textOf(staleButton), 'Parser');
  component.destroy();
  assert.deepEqual(target.childNodes, []);
});

// --- List locals ---
// The emitted list machinery runs beside author expressions, so its own locals
// must not share a name with a collection, an item, or a variable a row reads.
const listSource = (collection, item, keyed) => `<script>
let ${collection} = [{ id: 1, text: "a" }];
function grow() { ${collection} = [{ id: 1, text: "b" }, { id: 2, text: "c" }]; }
</script><main><ul>{#each ${collection} as ${item}${keyed ? ` (${item}.id)` : ''}}<li>{${item}.text}</li>{/each}</ul><button on:click={grow}>g</button></main>`;

const collidingNames = ['items', 'key', 'record', 'index', 'parentRef', 'startIndex', 'nextRecords', 'seenKeys'];

for (const [mode, mount] of Object.entries(mountBothWays)) {
  for (const keyed of [true, false]) {
    const flavour = keyed ? 'keyed' : 'keyless';

    for (const name of collidingNames) {
      test(`${mode}: a ${flavour} collection named ${name} renders and updates`, async (t) => {
        const { target, component } = await mount(t, listSource(name, 'row', keyed));
        assert.deepEqual(elementsNamed(target, 'li').map(textOf), ['a']);

        elementsNamed(target, 'button')[0].dispatchEvent('click');
        await flushUpdates();

        assert.deepEqual(elementsNamed(target, 'li').map(textOf), ['b', 'c']);
        component.destroy();
      });

      test(`${mode}: a ${flavour} list item named ${name} renders and updates`, async (t) => {
        const { target, component } = await mount(t, listSource('rows', name, keyed));
        assert.deepEqual(elementsNamed(target, 'li').map(textOf), ['a']);

        elementsNamed(target, 'button')[0].dispatchEvent('click');
        await flushUpdates();

        assert.deepEqual(elementsNamed(target, 'li').map(textOf), ['b', 'c']);
        component.destroy();
      });
    }
  }

  for (const name of ['index', 'parentRef']) {
    test(`${mode}: a row body reads the author's ${name}, not a generated local`, async (t) => {
      const parentSource = `<script>\nlet ${name} = "outer";\nlet rows = [1, 2];\n</script>`
        + `<main><ul>{#each rows as row}<li>{${name}}</li>{/each}</ul></main>`;
      const { target, component } = await mount(t, parentSource);

      assert.deepEqual(elementsNamed(target, 'li').map(textOf), ['outer', 'outer']);
      component.destroy();
    });
  }
}

// --- Child position (issue #66) ---
// Children mount after their parent is attached, so create() holds each tag's
// place with a text node the child inserts before. A fresh mount must end up
// with the same DOM hydration adopts from the server.
const describeNode = (node) => (node.nodeType === 3
  ? `text:${node.nodeValue}`
  : { [node.tagName.toLowerCase()]: node.childNodes.map(describeNode) });

const importCounter = 'import Counter from "./Counter.wizz";';

test('issue #66 repro: a fresh-mounted child stays at its template position', async (t) => {
  const parentSource = `<script>\n  ${importCounter}\n  let draft = "typed";\n</script>\n\n`
    + '<main class="repro">\n  <Counter text="child" />\n  <input value={draft} aria-label="draft" />\n  <button>Clear</button>\n</main>\n';
  const { target, component } = await mountBothWays['fresh mount'](t, parentSource, labelChildSource);
  const [main] = elementsNamed(target, 'main');

  assert.deepEqual(main.childNodes.filter((node) => node.nodeType === 1).map((node) => node.tagName), ['SPAN', 'INPUT', 'BUTTON']);
  component.destroy();
  assert.deepEqual(target.childNodes, []);
});

const orderTemplates = {
  'a child first': `<script>\n${importCounter}\n</script><main><Counter /><p>after</p></main>`,
  'a child last': `<script>\n${importCounter}\n</script><main><p>before</p><Counter /></main>`,
  'a child between siblings': `<script>\n${importCounter}\n</script><main><p>a</p><Counter /><p>b</p></main>`,
  'a child between text': `<script>\n${importCounter}\nlet count = 1;\n</script><main>before <Counter /> after {count}</main>`,
  'adjacent children': `<script>\n${importCounter}\n</script><main><Counter /><Counter /><Counter /></main>`,
  'a child with reactive props': `<script>\n${importCounter}\nlet text = "live";\n</script><main><Counter text={text} /><p>after</p></main>`,
  'a child inside a taken branch': `<script>\n${importCounter}\nlet open = true;\n</script><main>{#if open}<Counter /><p>in</p>{/if}<p>out</p></main>`,
  'a child in the else branch': `<script>\n${importCounter}\nlet open = false;\n</script><main>{#if open}<p>no</p>{:else}<Counter />{/if}<p>out</p></main>`,
  'a child before a list': `<script>\n${importCounter}\nlet rows = [1, 2];\n</script><main><Counter /><ul>{#each rows as row}<li>{row}</li>{/each}</ul></main>`,
  'a child beside list items': `<script>\n${importCounter}\nlet rows = [1, 2];\n</script><main><Counter />{#each rows as row}<li>{row}</li>{/each}<Counter /></main>`,
  'a child nested in an element': `<script>\n${importCounter}\n</script><main><section><Counter /><i>x</i></section><p>y</p></main>`,
  'children as keyed item roots': `<script>\n${importCounter}\nlet rows = [{ id: 1, t: "a" }, { id: 2, t: "b" }];\n</script><main><ul>{#each rows as row (row.id)}<Counter text={row.t} />{/each}</ul><p>after</p></main>`,
  'children between keyless item siblings': `<script>\n${importCounter}\nlet rows = ["a", "b"];\n</script><main><ul>{#each rows as row}<li><b>{row}</b><Counter text={row} /><i>x</i></li>{/each}</ul></main>`,
  'a static child beside list children': `<script>\n${importCounter}\nlet rows = ["a"];\n</script><main><Counter text="top" /><ul>{#each rows as row}<Counter text={row} />{/each}</ul></main>`
};

for (const [name, parentSource] of Object.entries(orderTemplates)) {
  test(`a fresh mount matches the hydrated DOM with ${name}`, async (t) => {
    const child = '<script>\n  export let text = "child";\n</script>\n\n<span>{text}</span>\n';
    const fresh = await mountBothWays['fresh mount'](t, parentSource, child);
    const hydrated = await mountBothWays.hydration(t, parentSource, child);
    // The list anchor is an empty text node on both paths.
    const describeAll = (target) => JSON.stringify(target.childNodes.map(describeNode));

    assert.equal(describeAll(fresh.target), describeAll(hydrated.target));
    fresh.component.destroy();
    hydrated.component.destroy();
    assert.deepEqual(fresh.target.childNodes, []);
  });
}

test('no placeholder stays in the DOM after children mount', async (t) => {
  const { target, component } = await mountBothWays['fresh mount'](t, `<script>\n${importCounter}\n</script><main><Counter /><Counter /></main>`);
  const [main] = elementsNamed(target, 'main');

  assert.deepEqual(main.childNodes.map((node) => node.nodeType), [1, 1]);
  component.destroy();
});

test('a grandchild keeps its position inside a positioned child', async (t) => {
  const { document, freshClientModule } = await loadNestedModules(
    t,
    `<script>\n${importCounter}\n</script><main><Counter /><p>after</p></main>`,
    '<section><h2>title</h2><em>rest</em></section>'
  );
  const target = document.makeElement('div');
  const component = freshClientModule.default(target);

  assert.deepEqual(target.childNodes.map(describeNode), [{
    main: [{ section: [{ h2: ['text:title'] }, { em: ['text:rest'] }] }, { p: ['text:after'] }]
  }]);
  component.destroy();
});

test('reactive updates reach a positioned child and the siblings after it', async (t) => {
  const parentSource = `<script>\n${importCounter}\nlet text = "one";\nfunction change() { text = "two"; }\n</script>`
    + '<main><Counter text={text} /><p>{text}</p><button on:click={change}>go</button></main>';
  const { target, component } = await mountBothWays['fresh mount'](t, parentSource, '<script>\n  export let text = "child";\n</script>\n\n<span>{text}</span>\n');
  const [main] = elementsNamed(target, 'main');
  elementsNamed(target, 'button')[0].dispatchEvent('click');
  await flushUpdates();

  assert.deepEqual(main.childNodes.map(describeNode), [{ span: ['text:two'] }, { p: ['text:two'] }, { button: ['text:go'] }]);
  component.destroy();
  assert.deepEqual(target.childNodes, []);
});

test('a hydration fallback restores template order', async (t) => {
  const parentSource = `<script>\n${importCounter}\n</script><main><Counter /><p data-mark="x">after</p></main>`;
  const { document, clientModule, warnings, render } = await loadNestedModules(t, parentSource, noChildSource);
  const { html, state } = render();
  const target = deliverMarkup(document, html);
  elementsNamed(target, 'p')[0].childNodes[0].nodeValue = 'tampered';

  const component = clientModule.hydrateComponent(target, {}, state);
  assert.equal(warnings.length, 1);

  assert.deepEqual(elementsNamed(target, 'main')[0].childNodes.map((node) => node.tagName), ['SPAN', 'P']);
  component.destroy();
});

test('an author variable cannot collide with the mount position parameter', async (t) => {
  const { target, component } = await mountBothWays['fresh mount'](t, '<script>\nlet anchor = "kept";\n</script><main>{anchor}</main>');

  assert.equal(textOf(elementsNamed(target, 'main')[0]), 'kept');
  component.destroy();
});

test('mounting without a position still appends to the target', async (t) => {
  const { document, freshClientModule } = await loadNestedModules(t, '<main>one</main>', noChildSource);
  const target = document.makeElement('div');
  target.appendChild(document.makeElement('header'));

  const component = freshClientModule.default(target);

  assert.deepEqual(target.childNodes.map((node) => node.tagName), ['HEADER', 'MAIN']);
  component.destroy();
});

test('a position argument inserts the root before that node', async (t) => {
  const { document, freshClientModule } = await loadNestedModules(t, '<main>one</main>', noChildSource);
  const target = document.makeElement('div');
  const footer = document.makeElement('footer');
  target.appendChild(footer);

  const component = freshClientModule.default(target, {}, footer);

  assert.deepEqual(target.childNodes.map((node) => node.tagName), ['MAIN', 'FOOTER']);
  component.destroy();
  assert.deepEqual(target.childNodes, [footer]);
});

// --- Author names (issue #65) ---
// Author scripts run inside the generated factory and author expressions run
// inside its nested functions, so no generated name may be an ordinary word.
// `names` is every unprefixed identifier generated code has used.
const names = [
  'target', 'props', 'hydrate', 'state', 'adoptSelf', 'headOwner', 'isMounted', 'headNodes', 'isDestroyed',
  'batchScheduled', 'pendingChanges', 'mountHooks', 'destroyHooks', 'trackedListeners', 'trackListener',
  'queueUpdate', 'ctx', 'create', 'update', 'rootNode', 'childComponents', 'listUpdates', 'adoptedHydration',
  'createHeadNodes', 'createStyleNodes', 'hydrateCreate', 'mountInstance', 'mountChildren', 'mountComponent',
  'hydrateComponent', 'hydrateRoot', 'changed', 'changes', 'problems', 'pendingListeners', 'nodes', 'node',
  'node_1', 'node_2', 'anchor_1', 'records_1', 'createItem_1', 'updateList_1', 'index_1', 'component_1',
  'hydrateList_1', 'fresh_1_0', 'value', 'next', 'key', 'html', 'head', 'options', 'renderComponent',
  'serializeInitialState', 'styleNode', 'hook', 'handler'
];

const reactiveSource = (name) => `<script>\nlet ${name} = "authored";\nfunction change() { ${name} = "changed"; }\n</script>`
  + `<main title={${name}}>{${name}}<button on:click={change}>go</button></main>`;

for (const [mode, mount] of Object.entries(mountBothWays)) {
  for (const name of names) {
    test(`${mode}: reactive state may be named ${name}`, async (t) => {
      const { target, component } = await mount(t, reactiveSource(name));
      const [main] = elementsNamed(target, 'main');
      assert.equal(main.attributes.title, 'authored');
      assert.equal(textOf(main), 'authored');

      elementsNamed(target, 'button')[0].dispatchEvent('click');
      await flushUpdates();

      assert.equal(main.attributes.title, 'changed');
      assert.equal(textOf(main), 'changed');
      component.destroy();
    });

    test(`${mode}: a const and a function may be named ${name}`, async (t) => {
      const constSource = `<script>\nconst ${name} = "authored";\n</script><main>{${name}}</main>`;
      const constant = await mount(t, constSource);
      assert.equal(textOf(elementsNamed(constant.target, 'main')[0]), 'authored');
      constant.component.destroy();

      const functionSource = `<script>\nlet hits = 0;\nfunction ${name}() { hits += 1; }\n</script><main><button on:click={${name}}>{hits}</button></main>`;
      const { target, component } = await mount(t, functionSource);
      const [button] = elementsNamed(target, 'button');
      button.dispatchEvent('click');
      await flushUpdates();
      assert.equal(textOf(button), '1');
      component.destroy();
    });

    test(`${mode}: a prop may be named ${name}`, async (t) => {
      const source = `<script>\nexport let ${name} = "authored";\n</script><main>{${name}}</main>`;
      const { target, component } = await mount(t, source);
      assert.equal(textOf(elementsNamed(target, 'main')[0]), 'authored');

      component.setProps({ [name]: 'changed' });
      await flushUpdates();

      assert.equal(textOf(elementsNamed(target, 'main')[0]), 'changed');
      component.destroy();
    });

    test(`${mode}: persistent state may be named ${name}`, async (t) => {
      const source = `<script>\nlet ${name} = persist("names-${name}-${mode.length}", "authored");\nfunction change() { ${name} = "changed"; }\n</script>`
        + `<main>{${name}}<button on:click={change}>go</button></main>`;
      const { target, component } = await mount(t, source);
      const [main] = elementsNamed(target, 'main');
      assert.equal(textOf(main), 'authored');

      elementsNamed(target, 'button')[0].dispatchEvent('click');
      await flushUpdates();

      assert.equal(textOf(main), 'changed');
      component.destroy();
    });

    test(`${mode}: a list and its rows may use ${name}`, async (t) => {
      const asCollection = await mount(t, listSource(name, 'row', true));
      elementsNamed(asCollection.target, 'button')[0].dispatchEvent('click');
      await flushUpdates();
      assert.deepEqual(elementsNamed(asCollection.target, 'li').map(textOf), ['b', 'c']);
      asCollection.component.destroy();

      const rowBody = `<script>\nlet ${name} = "outer";\nlet rows = [1, 2];\n</script><main><ul>{#each rows as row}<li>{${name}}</li>{/each}</ul></main>`;
      const { target, component } = await mount(t, rowBody);
      assert.deepEqual(elementsNamed(target, 'li').map(textOf), ['outer', 'outer']);
      component.destroy();
    });

    test(`${mode}: head and child props may read ${name}`, async (t) => {
      const source = `<script>\nimport Counter from "./Counter.wizz";\nlet ${name} = "authored";\n</script>`
        + `<wizz:head><title>{${name}}</title></wizz:head><main><Counter text={${name}} /></main>`;
      const { target, component } = await mount(t, source, labelChildSource);
      assert.equal(textOf(elementsNamed(target, 'span')[0]), 'authored');
      component.destroy();
    });
  }
}

test('a persistent value named value receives another instance\'s write', async (t) => {
  const source = '<script>\nlet value = persist("names-shared", "a");\nfunction change() { value = "b"; }\n</script>'
    + '<main>{value}<button on:click={change}>go</button></main>';
  const { document, freshClientModule } = await loadNestedModules(t, source, noChildSource);
  const firstTarget = document.makeElement('div');
  const secondTarget = document.makeElement('div');
  const first = freshClientModule.default(firstTarget);
  const second = freshClientModule.default(secondTarget);

  elementsNamed(firstTarget, 'button')[0].dispatchEvent('click');
  await flushUpdates();

  assert.equal(textOf(elementsNamed(secondTarget, 'main')[0]), 'b');
  first.destroy();
  second.destroy();
});

test('renderComponent keeps its html, head, and state result fields', async (t) => {
  const source = '<script>\nlet html = "a";\nlet head = "b";\nlet state = "c";\nlet options = "d";\n</script>'
    + '<wizz:head><title>{head}</title></wizz:head><main title={options}>{html}{state}</main>';
  const { render } = await loadNestedModules(t, source, noChildSource);
  const { html, state } = render();

  assert.match(html, /<main title="d"/);
  assert.deepEqual({ ...state }, { html: 'a', head: 'b', state: 'c', options: 'd' });
});

// --- Dynamic attribute policy round trip (issue #72) ---

test('issue #72: server-omitted boolean and nullish attributes hydrate and then toggle', async (t) => {
  const source = '<script>\nlet isValid = false;\nlet tip = null;\nlet expanded = false;\nfunction flip() {\n  isValid = !isValid;\n  tip = isValid ? "ok" : undefined;\n  expanded = isValid;\n}\n</script>'
    + '<form><p hidden={isValid} title={tip} aria-expanded={expanded}>Please enter a food name.</p><button on:click={flip}>Go</button></form>';
  const { document, clientModule, metricsBefore, warnings, render } = await loadGeneratedModules(t, source);

  const { html, stateScript } = render();
  assert.doesNotMatch(html, /hidden|title=/, 'the server omits falsy boolean and null attributes');
  assert.match(html, /aria-expanded="false"/);

  const target = deliverMarkup(document, html);
  const component = clientModule.hydrateComponent(target, {}, parseInitialStateScript(stateScript));
  assert.ok(component);
  assert.deepEqual(warnings, []);
  assert.equal(document.metrics.elements, metricsBefore.elements, 'adoption creates no elements');

  const form = target.firstElementChild;
  const [paragraph, button] = form.childNodes.filter((node) => node.nodeType === 1);
  assert.equal('hidden' in paragraph.attributes, false, 'the adopted paragraph is visible');

  button.dispatchEvent('click');
  await flushUpdates();
  assert.equal(paragraph.attributes.hidden, '');
  assert.equal(paragraph.attributes.title, 'ok');
  assert.equal(paragraph.attributes['aria-expanded'], 'true');

  button.dispatchEvent('click');
  await flushUpdates();
  assert.equal('hidden' in paragraph.attributes, false);
  assert.equal('title' in paragraph.attributes, false);
  assert.equal(paragraph.attributes['aria-expanded'], 'false');

  component.destroy();
  assert.deepEqual(target.childNodes, []);
});

test('issue #72: a truthy server-rendered boolean attribute is adopted bare and removed on update', async (t) => {
  const source = '<script>\nlet busy = true;\nfunction done() { busy = false; }\n</script><main><section inert={busy} hidden={busy}>x</section><button on:click={done}>Done</button></main>';
  const { document, clientModule, warnings, render } = await loadGeneratedModules(t, source);
  const { html, stateScript } = render();
  assert.match(html, /<section inert hidden /);

  const target = deliverMarkup(document, html);
  const component = clientModule.hydrateComponent(target, {}, parseInitialStateScript(stateScript));
  assert.deepEqual(warnings, []);
  const [section, button] = target.firstElementChild.childNodes.filter((node) => node.nodeType === 1);
  assert.equal(section.attributes.inert, '');
  button.dispatchEvent('click');
  await flushUpdates();
  assert.equal('inert' in section.attributes, false);
  assert.equal('hidden' in section.attributes, false);
  component.destroy();
});

// --- Reactive {#if} (issue #71) and on: inside {#each} (issue #70) ---
// Every behavior is asserted on a fresh mount and on adopted server markup:
// hydration must hand the same block machinery the same ownership create()
// builds, so the two can never drift apart.
const outline = (node) => (node.nodeType === 3
  ? JSON.stringify(node.nodeValue)
  : `${node.tagName.toLowerCase()}[${node.childNodes.filter((child) => child.nodeType !== 8).map(outline).join(' ')}]`);
const fireEvent = async (node, eventName = 'click') => {
  node.dispatchEvent(eventName);
  await flushUpdates();
};
const liveListeners = (document) => document.metrics.addedListeners - document.metrics.removedListeners;

for (const [mode, mount] of Object.entries(mountBothWays)) {
  test(`${mode}: issue #71: a reactive if block swaps branches and keeps its place`, async (t) => {
    const source = '<script>\nlet open = true;\nlet label = "a";\nfunction toggle() { open = !open; }\nfunction rename() { label = label + "!"; }\n</script>'
      + '<main><button on:click={toggle}>t</button>{#if open}<p on:click={rename}>{label}</p>{:else}<i>closed</i>{/if}<footer>end</footer></main>';
    const { target, component, document } = await mount(t, source);
    const main = target.childNodes[0];
    const [button] = elementsNamed(target, 'button');
    assert.equal(outline(main), 'main[button["t"] p["a"] "" footer["end"]]');

    // Reactive content inside the live branch, through its own listener.
    const paragraph = elementsNamed(target, 'p')[0];
    await fireEvent(paragraph);
    assert.equal(outline(main), 'main[button["t"] p["a!"] "" footer["end"]]');

    await fireEvent(button);
    assert.equal(outline(main), 'main[button["t"] i["closed"] "" footer["end"]]');
    assert.equal(paragraph.listeners.click, undefined, 'the replaced branch released its listener');
    assert.equal(liveListeners(document), 1, 'only the toggle listener is left');

    await fireEvent(button);
    assert.equal(outline(main), 'main[button["t"] p["a!"] "" footer["end"]]');
    assert.notEqual(elementsNamed(target, 'p')[0], paragraph, 'the branch is rebuilt from current state');
    await fireEvent(elementsNamed(target, 'p')[0]);
    assert.equal(outline(main), 'main[button["t"] p["a!!"] "" footer["end"]]');

    component.destroy();
    assert.deepEqual(target.childNodes, []);
    assert.equal(liveListeners(document), 0, 'every listener was released');
  });

  test(`${mode}: issue #71: an initially untaken block without an else appears later`, async (t) => {
    const source = '<script>\nlet error = "";\nfunction fail() { error = "Required"; }\nfunction clear() { error = ""; }\n</script>'
      + '<form on:submit={fail} on:reset={clear}><input />{#if error}<p class="error">{error}</p>{/if}</form>';
    const { target, component } = await mount(t, source);
    const form = target.childNodes[0];
    assert.equal(outline(form), 'form[input[] ""]');
    await fireEvent(form, 'submit');
    assert.equal(outline(form), 'form[input[] p["Required"] ""]');
    await fireEvent(form, 'reset');
    assert.equal(outline(form), 'form[input[] ""]');
    component.destroy();
  });

  test(`${mode}: issue #71: nested blocks and a list directly in a branch tear down together`, async (t) => {
    const source = '<script>\nlet outer = true;\nlet inner = false;\nlet xs = ["a", "b"];\nfunction a() { outer = !outer; }\nfunction b() { inner = !inner; }\nfunction add() { xs = [...xs, "c"]; }\n</script>'
      + '<ul on:click={a} on:keydown={b} on:keyup={add}>{#if outer}{#each xs as x}<li>{x}</li>{/each}{#if inner}<li class="deep">deep</li>{/if}{:else}<li>none</li>{/if}</ul>';
    const { target, component } = await mount(t, source);
    const list = target.childNodes[0];
    // Two items, the list anchor, the inner block anchor, the outer anchor.
    assert.equal(outline(list), 'ul[li["a"] li["b"] "" "" ""]');

    await fireEvent(list, 'keydown');
    assert.equal(outline(list), 'ul[li["a"] li["b"] "" li["deep"] "" ""]');
    await fireEvent(list, 'keyup');
    assert.equal(outline(list), 'ul[li["a"] li["b"] li["c"] "" li["deep"] "" ""]');

    await fireEvent(list);
    assert.equal(outline(list), 'ul[li["none"] ""]', 'items, both inner anchors, and the nested branch all left');

    // State the dropped blocks read keeps changing without effect.
    await fireEvent(list, 'keyup');
    await fireEvent(list, 'keydown');
    assert.equal(outline(list), 'ul[li["none"] ""]');

    await fireEvent(list);
    assert.equal(outline(list), 'ul[li["a"] li["b"] li["c"] li["c"] "" "" ""]');
    component.destroy();
    assert.deepEqual(target.childNodes, []);
  });

  test(`${mode}: issue #71: a child component is destroyed and remounted with its branch`, async (t) => {
    const parentSource = '<script>\nimport Counter from "./Counter.wizz";\nlet open = true;\nfunction toggle() { open = !open; }\n</script>'
      + '<main><h1 on:click={toggle}>t</h1>{#if open}<Counter />{/if}<p>end</p></main>';
    const childSource = '<script>\nlet count = 0;\nfunction increment() { count += 1; }\n</script><section><button on:click={increment}>Clicks: {count}</button></section>';
    const { target, component, document } = await mount(t, parentSource, childSource);
    const main = target.childNodes[0];
    const [heading] = elementsNamed(target, 'h1');
    assert.equal(outline(main), 'main[h1["t"] section[button["Clicks: " "0"]] "" p["end"]]');

    const firstButton = elementsNamed(target, 'button')[0];
    await fireEvent(firstButton);
    assert.equal(textOf(firstButton), 'Clicks: 1');

    // Dropping the branch destroys the child: its root leaves the parent
    // (also when the child had adopted that root) and its listener goes.
    await fireEvent(heading);
    assert.equal(outline(main), 'main[h1["t"] "" p["end"]]');
    assert.equal(firstButton.listeners.click, undefined);
    assert.equal(liveListeners(document), 1);

    // The branch comes back with a brand-new child instance, in place.
    await fireEvent(heading);
    assert.equal(outline(main), 'main[h1["t"] section[button["Clicks: " "0"]] "" p["end"]]');
    const secondButton = elementsNamed(target, 'button')[0];
    assert.notEqual(secondButton, firstButton);
    await fireEvent(secondButton);
    assert.equal(textOf(secondButton), 'Clicks: 1');

    component.destroy();
    assert.deepEqual(target.childNodes, []);
    assert.equal(liveListeners(document), 0);
  });

  test(`${mode}: issue #71: a child in an untaken branch mounts when the branch is first taken`, async (t) => {
    const parentSource = '<script>\nimport Counter from "./Counter.wizz";\nlet open = false;\nlet label = "x";\nfunction toggle() { open = !open; }\nfunction rename() { label = "y"; }\n</script>'
      + '<main on:click={toggle} on:keydown={rename}>{#if open}<div><Counter text={label} /></div>{:else}<i>none</i>{/if}</main>';
    const { target, component } = await mount(t, parentSource, labelChildSource);
    const main = target.childNodes[0];
    assert.equal(outline(main), 'main[i["none"] ""]');

    // A prop dependency changes while the child does not exist.
    await fireEvent(main, 'keydown');
    assert.equal(outline(main), 'main[i["none"] ""]');

    await fireEvent(main);
    assert.equal(textOf(elementsNamed(target, 'span')[0]), 'y', 'the child mounts with the current prop value');
    await fireEvent(main);
    assert.equal(outline(main), 'main[i["none"] ""]');
    component.destroy();
    assert.deepEqual(target.childNodes, []);
  });

  test(`${mode}: issue #70: a row's on: handler removes that row`, async (t) => {
    const source = '<script>\nlet entries = [{ id: 1, name: "Egg" }, { id: 2, name: "Tea" }, { id: 3, name: "Rice" }];\nfunction remove(id) { entries = entries.filter((entry) => entry.id !== id); }\nfunction add() { entries = [...entries, { id: 9, name: "Fig" }]; }\n</script>'
      + '<main on:keydown={add}><ul>{#each entries as entry (entry.id)}<li>{entry.name}<button on:click={() => remove(entry.id)}>Delete</button></li>{/each}</ul></main>';
    const { target, component, document } = await mount(t, source);
    const main = target.childNodes[0];
    const names = () => elementsNamed(target, 'li').map((item) => item.childNodes[0].nodeValue);
    assert.deepEqual(names(), ['Egg', 'Tea', 'Rice']);
    assert.equal(liveListeners(document), 4, 'one per row plus the root');

    const teaButton = elementsNamed(target, 'button')[1];
    await fireEvent(teaButton);
    assert.deepEqual(names(), ['Egg', 'Rice']);
    assert.equal(teaButton.listeners.click, undefined, 'the removed row released its listener');
    assert.equal(liveListeners(document), 3);

    // A row created after mount gets a working listener of its own.
    await fireEvent(main, 'keydown');
    assert.deepEqual(names(), ['Egg', 'Rice', 'Fig']);
    await fireEvent(elementsNamed(target, 'button')[2]);
    assert.deepEqual(names(), ['Egg', 'Rice']);

    await fireEvent(elementsNamed(target, 'button')[0]);
    await fireEvent(elementsNamed(target, 'button')[0]);
    assert.deepEqual(names(), []);
    assert.equal(liveListeners(document), 1);

    component.destroy();
    assert.equal(liveListeners(document), 0);
  });

  test(`${mode}: issue #70: handlers read the item's replacement after a keyed update`, async (t) => {
    const source = '<script>\nlet rows = [{ id: 1, qty: 1 }, { id: 2, qty: 5 }];\nlet seen = "none";\nfunction read(row) { seen = String(row.qty); }\nfunction bump() { rows = rows.map((row) => ({ id: row.id, qty: row.qty + 1 })); }\n</script>'
      + '<main on:keydown={bump}><ul>{#each rows as row (row.id)}<li on:click={() => read(row)}>{row.qty}</li>{/each}</ul><p>{seen}</p></main>';
    const { target, component } = await mount(t, source);
    const main = target.childNodes[0];
    const items = elementsNamed(target, 'li');
    await fireEvent(main, 'keydown');
    await fireEvent(main, 'keydown');
    assert.deepEqual(elementsNamed(target, 'li'), items, 'keyed nodes are retained across updates');
    await fireEvent(items[1]);
    assert.equal(textOf(elementsNamed(target, 'p')[0]), '7');
    await fireEvent(items[0]);
    assert.equal(textOf(elementsNamed(target, 'p')[0]), '3');
    component.destroy();
  });

  test(`${mode}: issue #70: item listeners inside a reactive branch leave with the branch`, async (t) => {
    const source = '<script>\nlet open = true;\nlet picked = "none";\nlet tags = ["a", "b"];\nfunction toggle() { open = !open; }\nfunction pick(tag) { picked = tag; }\n</script>'
      + '<main on:keydown={toggle}><p>{picked}</p>{#if open}<ul>{#each tags as tag}<li on:click={() => pick(tag)}>{tag}</li>{/each}</ul>{/if}</main>';
    const { target, component, document } = await mount(t, source);
    const main = target.childNodes[0];
    const items = elementsNamed(target, 'li');
    await fireEvent(items[1]);
    assert.equal(textOf(elementsNamed(target, 'p')[0]), 'b');

    await fireEvent(main, 'keydown');
    assert.deepEqual(items.map((item) => item.listeners.click), [undefined, undefined]);
    assert.equal(liveListeners(document), 1);

    await fireEvent(main, 'keydown');
    await fireEvent(elementsNamed(target, 'li')[0]);
    assert.equal(textOf(elementsNamed(target, 'p')[0]), 'a');
    component.destroy();
    assert.equal(liveListeners(document), 0);
  });
}

test('issue #71: hydrating a reactive block creates only its anchor', async (t) => {
  const source = '<script>\nlet open = true;\nfunction toggle() { open = !open; }\n</script>'
    + '<main on:click={toggle}>{#if open}<p>shown</p>{:else}<i>hidden</i>{/if}</main>';
  const { document, clientModule, metricsBefore, warnings, render } = await loadGeneratedModules(t, source);
  const { html, state } = render();
  assert.equal(html, '<main><!-- --><p>shown</p><!-- --></main>');
  const target = deliverMarkup(document, html);
  const delivered = target.childNodes[0].childNodes.find((node) => node.nodeType === 1);
  const component = clientModule.hydrateComponent(target, {}, state);

  assert.deepEqual(warnings, []);
  assert.equal(document.metrics.elements, metricsBefore.elements, 'adoption creates no elements');
  assert.equal(elementsNamed(target, 'p')[0], delivered, 'the delivered branch is adopted, not rebuilt');
  assert.equal(outline(target.childNodes[0]), 'main[p["shown"] ""]');

  // The first swap after adoption removes the adopted nodes and builds the
  // other branch through the shared maker.
  await fireEvent(target.childNodes[0]);
  assert.equal(outline(target.childNodes[0]), 'main[i["hidden"] ""]');
  assert.equal(document.metrics.elements, metricsBefore.elements + 1);
  component.destroy();
});

test('issue #71: a mismatch inside a reactive branch falls back cleanly', async (t) => {
  const source = '<script>\nlet open = true;\nfunction toggle() { open = !open; }\nfunction noop() {}\n</script>'
    + '<main on:click={toggle}>{#if open}<p on:click={noop}>shown</p>{:else}<i>hidden</i>{/if}</main>';
  const { document, clientModule, warnings, render } = await loadGeneratedModules(t, source);
  const { html, state } = render();
  // The server rendered the taken branch; deliver the other one instead.
  const target = deliverMarkup(document, html.replace('<p>shown</p>', '<i>hidden</i>'));
  const tampered = target.childNodes[0];
  const addedBefore = document.metrics.addedListeners;
  const component = clientModule.hydrateComponent(target, {}, state);

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^\[wizz\] hydration mismatch: expected <p> at index 0 of <main>/);
  assert.notEqual(target.childNodes[0], tampered, 'the tampered tree was replaced');
  // The abandoned walk attached nothing: listeners wait for a passing walk.
  assert.equal(tampered.listeners.click, undefined);
  assert.equal(document.metrics.addedListeners, addedBefore + 2, 'only the fallback mount attached listeners');
  assert.equal(outline(target.childNodes[0]), 'main[p["shown"] ""]');

  // The fallback is a normal reactive mount.
  await fireEvent(target.childNodes[0]);
  assert.equal(outline(target.childNodes[0]), 'main[i["hidden"] ""]');
  component.destroy();
  assert.deepEqual(target.childNodes, []);
  assert.equal(liveListeners(document), 0);
});

test('issue #70: hydration adopts rows with listeners without recreating them', async (t) => {
  const source = '<script>\nlet entries = [{ id: 1, name: "Egg" }, { id: 2, name: "Tea" }];\nfunction remove(id) { entries = entries.filter((entry) => entry.id !== id); }\n</script>'
    + '<ul>{#each entries as entry (entry.id)}<li>{entry.name}<button on:click={() => remove(entry.id)}>x</button></li>{/each}</ul>';
  const { document, clientModule, metricsBefore, warnings, render } = await loadGeneratedModules(t, source);
  const { html, state } = render();
  // Listeners are client-only: the delivered markup carries no trace of them.
  assert.equal(html, '<ul><li>Egg<button>x</button></li><li>Tea<button>x</button></li></ul>');
  const target = deliverMarkup(document, html);
  const deliveredItems = elementsNamed(target, 'li');
  const component = clientModule.hydrateComponent(target, {}, state);

  assert.deepEqual(warnings, []);
  assert.equal(document.metrics.elements, metricsBefore.elements);
  assert.equal(document.metrics.addedListeners, metricsBefore.addedListeners + 2, 'one listener per adopted row');

  await fireEvent(elementsNamed(target, 'button')[0]);
  assert.deepEqual(elementsNamed(target, 'li'), [deliveredItems[1]], 'the surviving row is still the delivered node');
  component.destroy();
  assert.equal(liveListeners(document), 0);
});

test('issue #70: a tampered row falls back without leaving adopted-row listeners behind', async (t) => {
  const source = '<script>\nlet entries = [{ id: 1, name: "Egg" }, { id: 2, name: "Tea" }];\nfunction remove(id) { entries = entries.filter((entry) => entry.id !== id); }\n</script>'
    + '<ul>{#each entries as entry (entry.id)}<li>{entry.name}<button on:click={() => remove(entry.id)}>x</button></li>{/each}</ul>';
  const { document, clientModule, warnings, render } = await loadGeneratedModules(t, source);
  const { html, state } = render();
  // The first row verifies (queueing its listener); the second does not.
  const target = deliverMarkup(document, html.replace('Tea', 'Coffee'));
  const firstButton = elementsNamed(target, 'button')[0];
  const component = clientModule.hydrateComponent(target, {}, state);

  assert.equal(warnings.length, 1);
  assert.equal(firstButton.listeners.click, undefined, 'the verified row never received its queued listener');
  assert.deepEqual(elementsNamed(target, 'li').map((item) => item.childNodes[0].nodeValue), ['Egg', 'Tea']);
  await fireEvent(elementsNamed(target, 'button')[1]);
  assert.deepEqual(elementsNamed(target, 'li').map((item) => item.childNodes[0].nodeValue), ['Egg']);
  component.destroy();
  assert.equal(liveListeners(document), 0);
});

// --- Expression grammar parity (issue #69) ---
// The new forms are spliced verbatim into server, hydration, and client
// code; each site must agree on the value, and updates must reach every one.

test('issue #69: conditionals, comparisons, unary operators, and calls agree across server, hydration, and updates', async (t) => {
  const source = '<wizz:head><title>{entries.length === 0 ? "Empty" : entries.length + " " + plural(entries.length)}</title>'
    + '<meta name="total" content={String(-total(entries))}></wizz:head>'
    + '<main class={entries.length > 1 && !busy ? "list many" : "list"}>'
    + '{#if !busy && entries.length >= 1}<p>Total {total(entries) * 1.5}</p>{:else}<p>{busy ? "Busy" : "None"}</p>{/if}'
    + '<ul>{#each entries as entry (entry.id)}<li class={entry.cal > 500 ? "big" : "small"}>{entry.name.toUpperCase()}</li>{/each}</ul>'
    + '<button on:click={add}>Add</button><a on:click={toggle}>Busy</a></main>'
    + '<script>\nlet entries = [{ id: 1, name: "oat", cal: 300 }];\nlet busy = false;\n'
    + 'function plural(n) { return n === 1 ? "entry" : "entries"; }\n'
    + 'function total(list) { return list.reduce((sum, e) => sum + e.cal, 0); }\n'
    + 'function add() { entries = [...entries, { id: entries.length + 1, name: "egg", cal: 600 }]; }\n'
    + 'function toggle() { busy = !busy; }\n</' + 'script>';
  const { document, clientModule, metricsBefore, warnings, render } = await loadHeadModules(t, source);
  const { html, head, state } = render();

  // Server output evaluates every new form.
  assert.match(head, />1 entry<\/title>/);
  assert.match(head, /content="-300"/);
  assert.match(html, /<main class="list"/);
  assert.match(html, /<p[^>]*>Total <!-- -->450<\/p>/);
  assert.match(html, /<li class="small"[^>]*>OAT<\/li>/);

  deliverHeadRun(document, head);
  const target = deliverMarkup(document, html);
  const component = clientModule.hydrateComponent(target, {}, state);
  assert.deepEqual(warnings, [], 'adoption verifies the delivered values');
  assert.ok(component);
  assert.equal(document.metrics.elements, metricsBefore.elements, 'adoption creates no elements');

  const main = target.firstElementChild;
  const [add, toggle] = elementsNamed(main, 'button').concat(elementsNamed(main, 'a'));
  const title = () => document.head.childNodes.find((node) => node.nodeName === 'TITLE' && node.attributes['data-wizz-head']);
  const meta = () => document.head.childNodes.find((node) => node.nodeName === 'META');

  add.dispatchEvent('click');
  await flushUpdates();
  assert.equal(main.attributes.class, 'list many');
  assert.equal(textOf(elementsNamed(main, 'p')[0]), 'Total 1350');
  assert.deepEqual(elementsNamed(main, 'li').map((li) => [li.attributes.class, textOf(li)]), [['small', 'OAT'], ['big', 'EGG']]);
  // Head expressions are evaluated at render/mount time only (a documented
  // head contract, unchanged here): the adopted nodes keep the server values.
  assert.equal(title().textContent, '1 entry');
  assert.equal(meta().attributes.content, '-300');

  // Flipping the other dependency of the && test swaps the branch.
  toggle.dispatchEvent('click');
  await flushUpdates();
  assert.equal(main.attributes.class, 'list');
  assert.deepEqual(elementsNamed(main, 'p').map(textOf), ['Busy']);

  component.destroy();
  assert.deepEqual(target.childNodes, []);
});

// --- Two-way bindings (issue #73) ---

test('issue #73: bound controls server-render their values, hydrate without recreation, and stay two-way', async (t) => {
  const source = '<script>\nlet name = "Ada";\nlet qty = 2;\nlet done = true;\nfunction clear() { name = ""; qty = null; done = false; }\n</script>'
    + '<main><input bind:value={name} /><input type="number" bind:value={qty} /><input type="checkbox" bind:checked={done} />'
    + '{#if done}<p><input bind:value={name} /></p>{/if}'
    + '<b>{name}:{qty}:{done}</b><button on:click={clear}>Clear</button></main>';
  const { document, clientModule, metricsBefore, warnings, render } = await loadGeneratedModules(t, source);
  const { html, stateScript } = render();

  assert.match(html, /<input value="Ada"/);
  assert.match(html, /<input type="number" value="2"/);
  assert.match(html, /<input type="checkbox" checked/);
  assert.doesNotMatch(html, /bind:|on:/);

  const target = deliverMarkup(document, html);
  const component = clientModule.hydrateComponent(target, {}, parseInitialStateScript(stateScript));
  assert.deepEqual(warnings, []);
  assert.equal(document.metrics.elements, metricsBefore.elements, 'adoption creates no elements');

  const main = target.firstElementChild;
  const inputs = elementsNamed(main, 'input');
  const [text, number, checkbox, branchInput] = inputs;
  const summary = () => textOf(elementsNamed(main, 'b')[0]);
  // The initial update writes state into the adopted controls' properties.
  assert.equal(text.value, 'Ada');
  assert.equal(checkbox.checked, true);
  assert.equal(summary(), 'Ada:2:true');

  // Listeners were attached to the adopted nodes, including inside the
  // reactive branch, and one control's edit reaches the others.
  text.value = 'Typed';
  text.dispatchEvent('input');
  await flushUpdates();
  assert.equal(summary(), 'Typed:2:true');
  assert.equal(branchInput.value, 'Typed');
  branchInput.value = 'Branch';
  branchInput.dispatchEvent('input');
  number.value = '7';
  number.dispatchEvent('input');
  await flushUpdates();
  assert.equal(summary(), 'Branch:7:true');
  assert.equal(text.value, 'Branch');

  // Unchecking drops the branch (and its bound input's listener).
  checkbox.checked = false;
  checkbox.dispatchEvent('change');
  await flushUpdates();
  assert.equal(elementsNamed(main, 'p').length, 0);
  assert.deepEqual(branchInput.listeners, {});

  elementsNamed(main, 'button')[0].dispatchEvent('click');
  await flushUpdates();
  assert.equal(text.value, '');
  assert.equal(number.value, '');
  assert.equal(summary(), ':null:false');

  component.destroy();
  assert.deepEqual(target.childNodes, []);
});

// --- Components inside {#each} bodies (milestone 25, step 1) ---
// Each item record owns its child instance: it mounts when the item is
// created, receives setProps() when the item updates, is destroyed when the
// item leaves, and keeps its identity and state when a keyed item moves.
// Every behavior is asserted on a fresh mount and on adopted server markup.
const rowChildSource = (rootTag) => '<script>\nexport let todo = { id: 0, text: "" };\nexport let onRemove = null;\nlet clicks = 0;\nfunction bump() { clicks += 1; }\n'
  + 'onDestroy(() => { globalThis.__wizzTestRowsDestroyed += 1; });\n</script>'
  + `<${rootTag}><span on:click={bump}>{todo.text}</span><i>{clicks}</i><button on:click={() => onRemove(todo.id)}>x</button></${rootTag}>`;
const rowParentSource = (body, keyed = true) => '<script>\nimport Counter from "./Counter.wizz";\n'
  + 'let todos = [{ id: 1, text: "a" }, { id: 2, text: "b" }, { id: 3, text: "c" }];\n'
  + 'function remove(id) { todos = todos.filter((todo) => todo.id !== id); }\n'
  + 'function add() { todos = [...todos, { id: 9, text: "z" }]; }\n'
  + 'function reverse() { todos = [...todos].reverse(); }\n'
  + 'function rename() { todos = todos.map((todo) => (todo.id === 2 ? { id: 2, text: "B" } : todo)); }\n'
  + 'function touch() { todos = todos; }\n</script>'
  + `<main on:keydown={add} on:keyup={reverse} on:focus={rename} on:blur={touch}><ul>{#each todos as todo${keyed ? ' (todo.id)' : ''}}${body}{/each}</ul></main>`;
const rowShapes = {
  'the item root': { body: '<Counter todo={todo} onRemove={remove} />', childRoot: 'li', rowTag: 'li' },
  'nested in the item element': { body: '<li class="row"><Counter todo={todo} onRemove={remove} /></li>', childRoot: 'div', rowTag: 'div' }
};
const rowTexts = (target) => elementsNamed(target, 'span').map(textOf);
const rowClicks = (target) => elementsNamed(target, 'i').map(textOf);
const countRowDestroys = (t) => {
  globalThis.__wizzTestRowsDestroyed = 0;
  t.after(() => { delete globalThis.__wizzTestRowsDestroyed; });
};

for (const [mode, mount] of Object.entries(mountBothWays)) {
  for (const [shape, { body, childRoot, rowTag }] of Object.entries(rowShapes)) {
    test(`${mode}: a keyed list renders one child per item with the child as ${shape}`, async (t) => {
      countRowDestroys(t);
      const { target, component, document } = await mount(t, rowParentSource(body), rowChildSource(childRoot));
      const main = target.childNodes[0];
      const list = elementsNamed(target, 'ul')[0];
      assert.deepEqual(rowTexts(target), ['a', 'b', 'c']);
      // Two listeners per row, four on the parent's root.
      assert.equal(liveListeners(document), 10);
      const rows = elementsNamed(target, rowTag);
      assert.equal(rows.length, 3);

      // Row state survives a keyed reorder: the instance moves with its item.
      await fireEvent(elementsNamed(target, 'span')[1]);
      await fireEvent(elementsNamed(target, 'span')[1]);
      assert.deepEqual(rowClicks(target), ['0', '2', '0']);
      await fireEvent(main, 'keyup');
      assert.deepEqual(rowTexts(target), ['c', 'b', 'a']);
      assert.deepEqual(rowClicks(target), ['0', '2', '0']);
      assert.deepEqual(elementsNamed(target, rowTag), [rows[2], rows[1], rows[0]], 'keyed rows move, never rebuild');
      assert.equal(list.childNodes.at(-1).nodeType, 3, 'the list anchor stays last');

      // A replaced item object reaches the row through setProps; its state stays.
      await fireEvent(main, 'focus');
      assert.deepEqual(rowTexts(target), ['c', 'B', 'a']);
      assert.deepEqual(rowClicks(target), ['0', '2', '0']);

      // The child calls the parent's callback prop with its current item.
      const removedButton = elementsNamed(target, 'button')[1];
      await fireEvent(removedButton);
      assert.deepEqual(rowTexts(target), ['c', 'a']);
      assert.equal(globalThis.__wizzTestRowsDestroyed, 1, 'the removed row was destroyed');
      assert.equal(removedButton.listeners.click, undefined, 'and released its listeners');
      assert.equal(liveListeners(document), 8);
      assert.ok(!elementsNamed(target, rowTag).includes(rows[1]), 'its root left the list');

      // A row added after mount is a working instance at its keyed place.
      await fireEvent(main, 'keydown');
      assert.deepEqual(rowTexts(target), ['c', 'a', 'z']);
      await fireEvent(elementsNamed(target, 'span')[2]);
      assert.deepEqual(rowClicks(target), ['0', '0', '1']);
      await fireEvent(elementsNamed(target, 'button')[2]);
      assert.deepEqual(rowTexts(target), ['c', 'a']);
      assert.equal(globalThis.__wizzTestRowsDestroyed, 2);

      component.destroy();
      assert.equal(globalThis.__wizzTestRowsDestroyed, 4, 'destroying the parent destroys every row');
      assert.equal(liveListeners(document), 0);
      assert.deepEqual(target.childNodes, []);
    });
  }

  test(`${mode}: unchanged props never re-render a row`, async (t) => {
    countRowDestroys(t);
    const { target, component, document } = await mount(t, rowParentSource(rowShapes['the item root'].body), rowChildSource('li'));
    const writesBefore = document.metrics.textWrites;
    await fireEvent(target.childNodes[0], 'blur');
    assert.equal(document.metrics.textWrites, writesBefore, 'self-assignment reaches every record, and setProps skips equal values');
    await fireEvent(target.childNodes[0], 'focus');
    assert.equal(document.metrics.textWrites, writesBefore + 1, 'only the renamed row writes');
    component.destroy();
  });

  test(`${mode}: keyless children are reused by position`, async (t) => {
    countRowDestroys(t);
    const { target, component, document } = await mount(t, rowParentSource(rowShapes['the item root'].body, false), rowChildSource('li'));
    const rows = elementsNamed(target, 'li');
    await fireEvent(elementsNamed(target, 'span')[0]);
    await fireEvent(elementsNamed(target, 'button')[0]);
    // Position 0 keeps its instance (and its state) and now shows item 2.
    assert.deepEqual(rowTexts(target), ['b', 'c']);
    assert.deepEqual(rowClicks(target), ['1', '0']);
    assert.deepEqual(elementsNamed(target, 'li'), rows.slice(0, 2));
    assert.equal(globalThis.__wizzTestRowsDestroyed, 1, 'the last position was destroyed');
    component.destroy();
    assert.equal(globalThis.__wizzTestRowsDestroyed, 3);
    assert.equal(liveListeners(document), 0);
  });

  for (const placement of ['inside an element', 'directly in the branch']) {
    test(`${mode}: rows in a reactive branch leave with the branch (${placement})`, async (t) => {
      countRowDestroys(t);
      const list = placement === 'inside an element'
        ? '{#if open}<ol>{#each todos as todo (todo.id)}<Counter todo={todo} onRemove={remove} />{/each}</ol>{/if}'
        : '{#if open}{#each todos as todo (todo.id)}<Counter todo={todo} onRemove={remove} />{/each}{/if}';
      const source = '<script>\nimport Counter from "./Counter.wizz";\nlet open = true;\nlet todos = [{ id: 1, text: "a" }, { id: 2, text: "b" }];\n'
        + 'function toggle() { open = !open; }\nfunction remove(id) { todos = todos.filter((todo) => todo.id !== id); }\n</script>'
        + `<main on:keydown={toggle}>${list}<p>end</p></main>`;
      const { target, component, document } = await mount(t, source, rowChildSource('li'));
      const main = target.childNodes[0];
      assert.deepEqual(rowTexts(target), ['a', 'b']);

      await fireEvent(main, 'keydown');
      assert.equal(globalThis.__wizzTestRowsDestroyed, 2);
      assert.deepEqual(elementsNamed(target, 'li'), [], 'no row root is left behind');
      assert.equal(liveListeners(document), 1);

      await fireEvent(main, 'keydown');
      assert.deepEqual(rowTexts(target), ['a', 'b'], 'fresh rows mount with the branch');
      const paragraph = elementsNamed(target, 'p')[0];
      assert.equal(main.childNodes.indexOf(paragraph), main.childNodes.length - 1, 'rows stay in front of later siblings');
      await fireEvent(elementsNamed(target, 'button')[0]);
      assert.deepEqual(rowTexts(target), ['b']);
      component.destroy();
      assert.equal(globalThis.__wizzTestRowsDestroyed, 4);
      assert.equal(liveListeners(document), 0);
      assert.deepEqual(target.childNodes, []);
    });
  }

  test(`${mode}: a row child sits between its item siblings and follows position updates`, async (t) => {
    const source = '<script>\nimport Counter from "./Counter.wizz";\nlet tags = ["x", "y"];\nfunction drop() { tags = tags.slice(1); }\n</script>'
      + '<main on:keydown={drop}><ul>{#each tags as tag}<li><b>{tag}</b><Counter text={tag} /><i>after</i></li>{/each}</ul></main>';
    const { target, component } = await mount(t, source, labelChildSource);
    const outlineList = () => outline(elementsNamed(target, 'ul')[0]);
    assert.equal(outlineList(), 'ul[li[b["x"] span["x"] i["after"]] li[b["y"] span["y"] i["after"]] ""]');
    await fireEvent(target.childNodes[0], 'keydown');
    assert.equal(outlineList(), 'ul[li[b["y"] span["y"] i["after"]] ""]', 'position 0 now shows y through setProps');
    component.destroy();
    assert.deepEqual(target.childNodes, []);
  });
}

test('hydration adopts row children without recreating them and routes each slice by position', async (t) => {
  countRowDestroys(t);
  const modules = await loadNestedModules(t, rowParentSource(rowShapes['the item root'].body), rowChildSource('li'));
  const { html, state } = modules.render();
  assert.deepEqual(Object.keys(state.__wizz.components), ['1:0', '1:1', '1:2']);
  // Deliver row 1 with a different count, consistently in markup and state.
  state.__wizz.components['1:1'].clicks = 42;
  const tampered = html.replace('>b</span><i data-wizz-id="2">0</i>', '>b</span><i data-wizz-id="2">42</i>');
  assert.notEqual(tampered, html);
  const target = deliverMarkup(modules.document, tampered);
  const delivered = elementsNamed(target, 'li');
  const component = modules.clientModule.hydrateComponent(target, {}, state);

  assert.deepEqual(modules.warnings, []);
  assert.equal(modules.document.metrics.elements, modules.metricsBefore.elements, 'adoption creates no elements');
  assert.deepEqual(elementsNamed(target, 'li'), delivered);
  assert.deepEqual(rowClicks(target), ['0', '42', '0'], 'each row read its own slice');
  await fireEvent(elementsNamed(target, 'span')[1]);
  assert.deepEqual(rowClicks(target), ['0', '43', '0'], 'the adopted row is live');
  component.destroy();
  assert.equal(liveListeners(modules.document), 0);
  assert.deepEqual(target.childNodes, []);
});

test('a mismatch inside one row child remounts inside that row and leaves its siblings adopted', async (t) => {
  countRowDestroys(t);
  const modules = await loadNestedModules(t, rowParentSource(rowShapes['nested in the item element'].body), rowChildSource('div'));
  const { html, state } = modules.render();
  const target = deliverMarkup(modules.document, html.replace('>b</span>', '>tampered</span>'));
  const deliveredItems = elementsNamed(target, 'li');
  const deliveredRoots = elementsNamed(target, 'div');
  const component = modules.clientModule.hydrateComponent(target, {}, state);

  assert.equal(modules.warnings.length, 1, 'only the row child reports');
  assert.match(modules.warnings[0], /^\[wizz\] hydration mismatch: expected expression text/);
  assert.deepEqual(elementsNamed(target, 'li'), deliveredItems, 'the parent tree is intact');
  assert.equal(elementsNamed(target, 'div')[0], deliveredRoots[0], 'sibling rows stay adopted');
  assert.deepEqual(rowTexts(target), ['a', 'b', 'c'], 'the tampered row rendered fresh inside its root');

  // The remounted row still works, removes itself, and tears down.
  await fireEvent(elementsNamed(target, 'button')[1]);
  assert.deepEqual(rowTexts(target), ['a', 'c']);
  assert.ok(!elementsNamed(target, 'li').includes(deliveredItems[1]));
  component.destroy();
  assert.equal(globalThis.__wizzTestRowsDestroyed, 3);
  assert.equal(liveListeners(modules.document), 0);
  assert.deepEqual(target.childNodes, []);
});

test('a mismatch inside a child that is the item root keeps the row removable', async (t) => {
  countRowDestroys(t);
  const modules = await loadNestedModules(t, rowParentSource(rowShapes['the item root'].body), rowChildSource('li'));
  const { html, state } = modules.render();
  const target = deliverMarkup(modules.document, html.replace('>b</span>', '>tampered</span>'));
  const component = modules.clientModule.hydrateComponent(target, {}, state);
  assert.equal(modules.warnings.length, 1);
  await fireEvent(elementsNamed(target, 'button')[1]);
  assert.deepEqual(rowTexts(target), ['a', 'c']);
  // The delivered root that hosted the fresh remount left with its row.
  const list = elementsNamed(target, 'ul')[0];
  assert.equal(list.childNodes.filter((node) => node.nodeType === 1).length, 2);
  component.destroy();
  assert.equal(liveListeners(modules.document), 0);
  assert.deepEqual(target.childNodes, []);
});

test('row children adopt their delivered head slices by position and consume the run', async (t) => {
  const childSource = '<script>\nexport let todo = { id: 0, text: "" };\nexport let onRemove = null;\n</script>'
    + '<wizz:head><meta name="row" content={todo.text}></wizz:head><li>{todo.text}</li>';
  const modules = await loadNestedModules(t, rowParentSource(rowShapes['the item root'].body), childSource);
  const { html, head, state } = modules.render();
  assert.match(head, /data-wizz-head-id="r\/1:2"/);
  deliverHeadRun(modules.document, head);
  const target = deliverMarkup(modules.document, html);
  const component = modules.clientModule.hydrateComponent(target, {}, state);

  assert.deepEqual(modules.warnings, []);
  const metas = () => modules.document.head.childNodes.filter((node) => node.nodeName === 'META');
  assert.deepEqual(metas().map((node) => node.attributes.content).sort(), ['a', 'b', 'c']);
  assert.ok(metas().every((node) => !('data-wizz-head-id' in node.attributes)), 'every slice was claimed');
  assert.ok(!modules.document.head.childNodes.some((node) => node.nodeType === 8), 'the run markers were consumed');

  component.destroy();
  assert.deepEqual(metas(), [], 'every row released its head node');
});

// Review of milestone 25 step 1: a child that declares no props returns no
// setProps(), and the parent compiles without seeing the child. Dynamic
// attributes on such a tag are ignored instead of throwing on the parent's
// first update, inside a list or not.
for (const [mode, mount] of Object.entries(mountBothWays)) {
  for (const [placement, body] of [
    ['in an each item', '<ul>{#each todos as todo (todo.id)}<li><Counter extra={todo.text} /></li>{/each}</ul>'],
    ['as an each item root', '<ul>{#each todos as todo (todo.id)}<Counter extra={todo.text} />{/each}</ul>'],
    ['outside any list', '<div><Counter extra={label} /></div>']
  ]) {
    test(`${mode}: dynamic attributes on a prop-less child are ignored ${placement}`, async (t) => {
      const source = '<script>\nimport Counter from "./Counter.wizz";\nlet todos = [{ id: 1, text: "a" }];\nlet label = "x";\n'
        + 'function change() { todos = [{ id: 1, text: "b" }, { id: 2, text: "c" }]; label = "y"; }\n</script>'
        + `<main on:click={change}>${body}</main>`;
      const { target, component } = await mount(t, source, noChildSource);
      const childCount = () => elementsNamed(target, 'span').length;
      assert.equal(childCount(), 1);
      await fireEvent(target.childNodes[0]);
      assert.equal(childCount(), placement === 'outside any list' ? 1 : 2);
      assert.deepEqual(elementsNamed(target, 'span').map(textOf), placement === 'outside any list' ? ['child'] : ['child', 'child']);
      component.destroy();
      assert.deepEqual(target.childNodes, []);
    });
  }
}

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
      nodeName: name.toUpperCase(),
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
      parent.childNodes.push({ nodeType: 8, nodeValue: markup.slice(index + 4, end) });
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
    parent.childNodes.push(document.makeTextNode(decodeEntities(text)));
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
    metricsBefore,
    warnings,
    render() {
      const { html, state } = serverModule.renderComponent();
      return { html, state, stateScript: serverModule.serializeInitialState(state) };
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
async function loadHeadModules(t, pageSource) {
  const projectDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-head-test-'));
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(projectDirectory, 'package.json'), '{"type":"module"}');

  const { source: serverSource } = compileServer(pageSource, { filePath: 'src/Page.wizz' });
  fs.writeFileSync(path.join(projectDirectory, 'server.js'), serverSource);
  const { source: clientSource } = compile(pageSource, { filePath: 'src/Page.wizz', hydratable: true });
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

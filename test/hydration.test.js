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
  const metrics = { elements: 0, textNodes: 0, textWrites: 0, addedListeners: 0, removedListeners: 0 };

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

// Compiles both targets for the fixture into a temporary ESM project and
// imports them (cache-busted) with the shim document installed.
async function loadGeneratedModules(t) {
  const projectDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-hydration-test-'));
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(projectDirectory, 'package.json'), '{"type":"module"}');

  const { source: serverSource } = compileServer(loadFixture(), { filePath: fixturePath });
  fs.writeFileSync(path.join(projectDirectory, 'server.js'), serverSource);
  const { source: clientSource } = compile(loadFixture(), { filePath: fixturePath, hydratable: true });
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

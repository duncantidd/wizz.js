const assert = require('node:assert/strict');
const test = require('node:test');
const { assignNodeIds } = require('../analyzer/idAssigner');
const { analyzeDependencies } = require('../analyzer/dependencyAnalyzer');
const { parseComponent } = require('../parser');
const { generateComponent } = require('./componentGenerator');
const { generateServerComponent } = require('./serverGenerator');

async function flushUpdates() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// Extends the standard generator-test shim with the surface hydration needs:
// nodeType, tagName, firstElementChild, comment nodes, and removeChild on
// created elements. createElement/createTextNode calls are counted so tests
// can prove hydration creates no duplicate DOM.
function createDocument() {
  const elements = new Map();
  const metrics = { elements: 0, textNodes: 0, textWrites: 0 };

  function createElement(name) {
    metrics.elements += 1;
    return {
      nodeType: 1,
      name,
      tagName: name,
      attributes: {},
      childNodes: [],
      listeners: {},
      setAttribute(attributeName, value) {
        this.attributes[attributeName] = value;
        if (attributeName === 'data-wizz-id') {
          elements.set(`[data-wizz-id="${value}"]`, this);
        }
      },
      getAttribute(attributeName) {
        return this.attributes[attributeName] ?? null;
      },
      querySelector(selector) {
        for (const child of this.childNodes) {
          if (child.attributes?.['data-wizz-id'] && selector === `[data-wizz-id="${child.attributes['data-wizz-id']}"]`) return child;
          const match = child.querySelector?.(selector);
          if (match) return match;
        }
        return null;
      },
      get firstElementChild() {
        return this.childNodes.find((node) => node.nodeType === 1) ?? null;
      },
      appendChild(node) {
        this.childNodes.push(node);
      },
      removeChild(node) {
        const index = this.childNodes.indexOf(node);
        if (index !== -1) this.childNodes.splice(index, 1);
      },
      addEventListener(eventName, listener) {
        this.listeners[eventName] = listener;
      },
      removeEventListener(eventName, listener) {
        if (this.listeners[eventName] === listener) delete this.listeners[eventName];
      },
      dispatchEvent(eventName) {
        this.listeners[eventName]?.({ type: eventName, target: this });
      }
    };
  }

  return {
    metrics,
    createElement,
    createTextNode(nodeValue) {
      metrics.textNodes += 1;
      return {
        nodeType: 3,
        get nodeValue() { return this._nodeValue; },
        set nodeValue(value) { metrics.textWrites += 1; this._nodeValue = value; },
        _nodeValue: nodeValue
      };
    },
    createComment(nodeValue) {
      return { nodeType: 8, nodeValue };
    },
    querySelector(selector) {
      return elements.get(selector) || null;
    }
  };
}

function createTarget() {
  return {
    childNodes: [],
    get firstElementChild() {
      return this.childNodes.find((node) => node.nodeType === 1) ?? null;
    },
    appendChild(node) { this.childNodes.push(node); },
    removeChild(node) {
      const index = this.childNodes.indexOf(node);
      if (index !== -1) this.childNodes.splice(index, 1);
    }
  };
}

function generateHydratable(source) {
  const payload = assignNodeIds(analyzeDependencies(parseComponent(source)));
  return generateComponent(payload, { hydratable: true });
}

test('emits an adoption walk verifying tags, ids, and text positionally', () => {
  const source = generateHydratable('<script>let count = 0;</script><main><p>static</p><p>Count: {count}</p></main>');

  assert.match(source, /const rootNode = target\.firstElementChild;/);
  assert.match(source, /__wizzNodeTag\(rootNode\) !== 'main'/);
  assert.match(source, /__wizzStripComments\(rootNode\);/);
  // Comment stripping precedes the exact child-count comparison.
  assert.match(source, /rootNode\.childNodes\.length !== 2/);
  // The reactive paragraph is verified by its analyzer-assigned id value.
  assert.match(source, /node_3\.getAttribute\('data-wizz-id'\) !== "1"/);
  // Expression text is compared against the seeded runtime value.
  assert.match(source, /node_5\.nodeValue !== String\(count\)/);
  // A single mismatch exit reports once, clears the target, and returns null.
  assert.match(source, /console\.warn\('\[wizz\] hydration mismatch: ' \+ problems\.join\('; '\) \+ '\. Falling back to client rendering\.'\);/);
  assert.match(source, /while \(target\.childNodes\.length > 0\) target\.removeChild\(target\.childNodes\[0\]\);/);
  assert.match(source, /return null;/);
});

test('defers listener attachment until after the walk passes', () => {
  const source = generateHydratable('<script>function go() {}</script><main><button on:click={go}>go</button></main>');

  // The listener is collected during the walk...
  assert.match(source, /pendingListeners\.push\(\[node_1, "click", go\]\);/);
  // ...and attached only after the mismatch check.
  const collectIndex = source.indexOf('pendingListeners.push');
  const attachIndex = source.indexOf("pendingListeners.forEach((pending) => trackListener(");
  const mismatchIndex = source.indexOf('if (problems.length > 0) {');
  assert.ok(collectIndex !== -1 && attachIndex !== -1 && mismatchIndex !== -1);
  assert.ok(collectIndex < mismatchIndex && mismatchIndex < attachIndex);
});

test('hydrates server-rendered markup without creating any DOM nodes', async () => {
  const componentSource = '<script>let count = 0; function increment() { count += 1; }</script><main><button data-label="go" on:click={increment}>Count: {count}</button></main>';
  const serverModuleSource = generateServerComponent(assignNodeIds(analyzeDependencies(parseComponent(componentSource))));
  const serverModule = new Function(
    serverModuleSource
      .replace('export { __wizzSerializeInitialState as serializeInitialState };', '')
      .replace('export function renderComponent(', 'function renderComponent(')
      + '\nreturn { renderComponent, __wizzSerializeInitialState };'
  )();
  const { html, state } = serverModule.renderComponent();

  const document = createDocument();
  const { hydrateComponent } = new Function(
    'document',
    generateHydratable(componentSource).replace('export default function mountComponent(', 'function mountComponent(').replace('export function hydrateComponent(', 'function hydrateComponent(')
      + '\nreturn { mountComponent, hydrateComponent };'
  )(document);

  // Rebuild the delivered markup as shim DOM, including the adjacency marker
  // comment, exactly as a browser parser would produce it.
  const main = document.createElement('main');
  const button = document.createElement('button');
  button.setAttribute('data-wizz-id', '1');
  button.setAttribute('data-label', 'go');
  button.childNodes.push(document.createTextNode('Count: '));
  button.childNodes.push(document.createComment(''));
  button.childNodes.push(document.createTextNode('0'));
  main.childNodes.push(button);
  const target = createTarget();
  target.childNodes.push(main);

  const elementsBefore = document.metrics.elements;
  const textNodesBefore = document.metrics.textNodes;
  const component = hydrateComponent(target, {}, state);

  assert.ok(component);
  // Hydration itself creates nothing; the only elements/text nodes counted
  // were built by this test to stand in for the delivered markup.
  assert.equal(document.metrics.elements, elementsBefore, 'hydration must create no elements');
  assert.equal(document.metrics.textNodes, textNodesBefore, 'hydration must create no text nodes');
  assert.equal(target.childNodes[0], main, 'the server-rendered root is adopted in place');

  // The initial update converges from the seeded state: exactly one reactive
  // text write, targeting the adopted node.
  assert.equal(document.metrics.textWrites, 1);

  // Reactivity works on the adopted nodes (markers were stripped, so the
  // expression text sits at the same index the update generator targets).
  const buttonNode = target.childNodes[0].childNodes[0];
  buttonNode.dispatchEvent('click');
  await flushUpdates();
  assert.equal(buttonNode.childNodes[1].nodeValue, '1');
  assert.equal(document.metrics.textWrites, 2, 'no extra writes beyond reactive ones');

  component.destroy();
  assert.deepEqual(target.childNodes, []);
});

test('reports one mismatch and falls back to a full client mount', async () => {
  const componentSource = '<script>let count = 0;</script><main><p>Count: {count}</p></main>';
  const moduleSource = generateHydratable(componentSource);
  const document = createDocument();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);

  const mod = new Function(
    'document',
    `${moduleSource.replace('export default function mountComponent(', 'function mountComponent(').replace('export function hydrateComponent(', 'function hydrateComponent(')}\nreturn { mountComponent, hydrateComponent };`
  )(document);

  // Tampered server markup: the interpolation text does not match state.
  const main = document.createElement('main');
  const paragraph = document.createElement('p');
  paragraph.setAttribute('data-wizz-id', '1');
  paragraph.childNodes.push(document.createTextNode('Count: '));
  paragraph.childNodes.push(document.createComment(''));
  paragraph.childNodes.push(document.createTextNode('999'));
  main.childNodes.push(paragraph);
  const target = createTarget();
  target.childNodes.push(main);

  try {
    const component = mod.hydrateComponent(target, {}, { count: 0 });

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^\[wizz\] hydration mismatch: /);
    assert.match(warnings[0], /Falling back to client rendering\./);
    // The fallback re-created the DOM client-side.
    assert.ok(document.metrics.elements > 0);
    assert.notEqual(target.childNodes[0], main);
    assert.equal(target.childNodes.length, 1);

    // The fallback component is fully reactive.
    component.destroy();
    assert.deepEqual(target.childNodes, []);
  } finally {
    console.warn = originalWarn;
  }
});

test('falls back when the mount point is empty or tagged differently', () => {
  const componentSource = '<script>let count = 0;</script><main><p>{count}</p></main>';
  const moduleSource = generateHydratable(componentSource);
  const mod = new Function(
    'document',
    `${moduleSource.replace('export default function mountComponent(', 'function mountComponent(').replace('export function hydrateComponent(', 'function hydrateComponent(')}\nreturn { mountComponent, hydrateComponent };`
  );

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    const emptyDocument = createDocument();
    const emptyMod = mod(emptyDocument);
    const emptyTarget = createTarget();
    const emptyComponent = emptyMod.hydrateComponent(emptyTarget, {}, { count: 0 });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /expected root <main>, found nothing/);
    assert.ok(emptyComponent);
    assert.ok(emptyTarget.childNodes.length > 0);

    const wrongDocument = createDocument();
    const wrongMod = mod(wrongDocument);
    const span = wrongDocument.createElement('span');
    const wrongTarget = createTarget();
    wrongTarget.childNodes.push(span);
    wrongMod.hydrateComponent(wrongTarget, {}, { count: 0 });
    assert.match(warnings[1], /expected root <main>, found <span>/);
  } finally {
    console.warn = originalWarn;
  }
});

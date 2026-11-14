const assert = require('node:assert/strict');
const test = require('node:test');
const { assignNodeIds } = require('../analyzer/idAssigner');
const { analyzeDependencies } = require('./../analyzer/dependencyAnalyzer');
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
      nodeName: name.toUpperCase(),
      tagName: name,
      attributes: {},
      childNodes: [],
      listeners: {},
      removeAttribute(attributeName) {
        delete this.attributes[attributeName];
      },
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
        node.parentNode = this;
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
    head: {
      nodeType: 1,
      nodeName: 'HEAD',
      childNodes: [],
      get firstChild() {
        return this.childNodes[0] ?? null;
      },
      appendChild(node) {
        this.childNodes.push(node);
        node.parentNode = this;
      },
      insertBefore(node, referenceNode) {
        const existing = this.childNodes.indexOf(node);
        if (existing !== -1) this.childNodes.splice(existing, 1);
        const index = referenceNode == null
          ? this.childNodes.length
          : this.childNodes.indexOf(referenceNode);
        this.childNodes.splice(index === -1 ? this.childNodes.length : index, 0, node);
        node.parentNode = this;
      },
      removeChild(node) {
        const index = this.childNodes.indexOf(node);
        if (index !== -1) this.childNodes.splice(index, 1);
        node.parentNode = null;
      },
      querySelectorAll(selector) {
        const match = selector.match(/^([A-Za-z]+)\[([a-zA-Z-]+)\]$/);
        if (!match) return [];
        return this.childNodes.filter((node) => node.nodeName === match[1].toUpperCase()
          && node.getAttribute(match[2]) != null);
      }
    },
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

// Strips export bindings and import lines so the emitted ESM can be executed
// under `new Function`; bindings arrive as parameters instead.
function stripModule(source) {
  return source
    .replace('export default function mountComponent(', 'function mountComponent(')
    .replace('export function hydrateComponent(', 'function hydrateComponent(')
    .replace('export function hydrateRoot(', 'function hydrateRoot(')
    .replace(/^import .*$/gm, '');
}

function generateHydratable(source, options = {}) {
  const payload = assignNodeIds(analyzeDependencies(parseComponent(source)));
  return generateComponent(payload, { hydratable: true, ...options });
}

test('emits an adoption walk verifying tags, ids, and text positionally', () => {
  const source = generateHydratable('<script>let count = 0;</script><main><p>static</p><p>Count: {count}</p></main>');

  // A top-level mount adopts the mount point's first element.
  assert.match(source, /const __wizzRoot = __wizzAdoptSelf \? __wizzHost : __wizzHost\.firstElementChild;/);
  assert.match(source, /__wizzNodeTag\(__wizzRoot\) !== 'main'/);
  assert.match(source, /__wizzStripComments\(__wizzRoot\);/);
  // Comment stripping precedes the flattened child-count comparison.
  assert.match(source, /!== __wizzRoot\.childNodes\.length/);
  // The reactive paragraph is verified by its analyzer-assigned id value.
  assert.match(source, /\.getAttribute\('data-wizz-id'\) !== "1"/);
  // Expression text is compared against the seeded runtime value.
  assert.match(source, /\.nodeValue !== String\(count\)/);
  // A single mismatch exit reports once, clears the target, and returns null.
  assert.match(source, /console\.warn\('\[wizz\] hydration mismatch: ' \+ __wizzProblems\.join\('; '\) \+ '\. Falling back to client rendering\.'\);/);
  assert.match(source, /while \(__wizzHost\.childNodes\.length > 0\) __wizzHost\.removeChild\(__wizzHost\.childNodes\[0\]\);/);
  assert.match(source, /return null;/);
});

test('emits the branch-aware walk for if blocks', () => {
  const source = generateHydratable(
    '<script>let flag = true;</script><main>{#if flag}<p>yes</p>{:else}<p>no</p>{/if}</main>'
  );

  // The walk re-evaluates the same test the server target evaluated.
  assert.match(source, /if \(flag\) \{/);
  // Both branches are flattened at the same cursor position.
  assert.match(source, /\} else \{/);
});

test('declares component-tag refs at __wizzHydrateCreate scope for tags inside branches', () => {
  const source = generateHydratable(
    '<script>\nimport Counter from "./Counter.wizz";\nlet flag = true;\n</script><main>{#if flag}<Counter />{/if}</main>',
    { componentServerRenderable: { Counter: true } }
  );

  // The ref is declared before the branch wrapper and only assigned inside
  // it: the adoption block after the walk references it at function scope,
  // so an inline `let` inside the branch would be out of scope there.
  const hydrationStart = source.indexOf('function __wizzHydrateCreate(');
  const declarationIndex = source.indexOf('let __wizzNode_1 = null;', hydrationStart);
  const branchIndex = source.indexOf('if (flag) {', hydrationStart);
  const adoptionIndex = source.indexOf('.hydrateRoot(__wizzNode_1,');
  assert.ok(declarationIndex !== -1, 'component ref declared at function scope');
  assert.ok(branchIndex !== -1 && adoptionIndex !== -1);
  assert.ok(declarationIndex < branchIndex, 'declaration precedes the branch wrapper');
  assert.ok(branchIndex < adoptionIndex, 'adoption follows the branch');
  // The in-branch assignment must not redeclare the ref.
  assert.doesNotMatch(source.slice(branchIndex, adoptionIndex), /let __wizzNode_1/);
});

test('emits per-list machinery for each blocks', () => {
  const source = generateHydratable(
    '<script>let fruits = [{ id: 1, name: "apple" }];</script><ul>{#each fruits as fruit (fruit.id)}<li>{fruit.name}</li>{/each}</ul>'
  );

  assert.match(source, /function __wizzHydrateList_1\(__wizzParent, __wizzStart\) \{/);
  assert.match(source, /const __wizzKey = fruit\.id;/);
  assert.match(source, /if \(__wizzRecords_1\.has\(__wizzKey\)\) __wizzProblems\.push\('Each block keys must be unique\.'\);/);
  // The anchor is created during hydration: an empty text node cannot
  // survive HTML serialization.
  assert.match(source, /__wizzAnchor_1 = document\.parentNode\.createTextNode|__wizzAnchor_1 = document\.createTextNode\(''\);/);
  // Future client updates flow through the rebuilt records map.
  assert.match(source, /__wizzLists\.push\(\(__wizzChanged\) => \{ if \(__wizzChanged\.fruits\) __wizzHydrateUpdateList_1\(\); \}\);/);
});

test('collects instrumented inline handlers for adoption', () => {
  const source = generateHydratable('<script>let name = "";</script><main><input value={name} on:input={(e) => name = e.target.value} /></main>');
  assert.match(source, /__wizzPendingListeners\.push\(\[\w+, "input", \(e\) => \{ name = e\.target\.value; __wizzQueueUpdate\(\{ name: true \}\); \}\]\);/);
});

test('defers listener attachment until after the walk passes', () => {
  const source = generateHydratable('<script>function go() {}</script><main><button on:click={go}>go</button></main>');

  // The listener is collected during the walk...
  assert.match(source, /__wizzPendingListeners\.push\(\[__wizzNode_\d+, "click", go\]\);/);
  // ...and attached only after the mismatch check.
  const collectIndex = source.indexOf('__wizzPendingListeners.push');
  const attachIndex = source.indexOf("__wizzPendingListeners.forEach((pending) => __wizzListen(");
  const mismatchIndex = source.indexOf('if (__wizzProblems.length > 0) {');
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
    stripModule(generateHydratable(componentSource)) + '\nreturn { mountComponent, hydrateComponent, hydrateRoot };'
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

test('adopts each block items positionally, rebuilds records, and creates only the anchor', async () => {
  const componentSource = '<script>\nlet fruits = [{ id: 1, name: "apple" }, { id: 2, name: "pear" }];\nfunction addFruit() { fruits = [...fruits, { id: 3, name: "fig" }]; }\nfunction dropFirst() { fruits = fruits.slice(1); }\n</script><main><button on:click={addFruit}>Add</button><ul>{#each fruits as fruit (fruit.id)}<li>{fruit.name}</li>{/each}</ul></main>';
  const document = createDocument();
  const { hydrateComponent } = new Function(
    'document',
    stripModule(generateHydratable(componentSource)) + '\nreturn { mountComponent, hydrateComponent, hydrateRoot };'
  )(document);

  // Delivered markup: two list items, no anchor (an empty text node cannot
  // survive serialization).
  const main = document.createElement('main');
  const button = document.createElement('button');
  button.setAttribute('data-wizz-id', '1');
  button.childNodes.push(document.createTextNode('Add'));
  const list = document.createElement('ul');
  const apple = document.createElement('li');
  apple.childNodes.push(document.createTextNode('apple'));
  const pear = document.createElement('li');
  pear.childNodes.push(document.createTextNode('pear'));
  list.childNodes.push(apple, pear);
  main.childNodes.push(button, list);
  const target = createTarget();
  target.childNodes.push(main);

  const state = { fruits: [{ id: 1, name: 'apple' }, { id: 2, name: 'pear' }] };
  const elementsBefore = document.metrics.elements;
  const textNodesBefore = document.metrics.textNodes;

  const component = hydrateComponent(target, {}, state);

  // Only the anchor text node is created; both items were adopted in place.
  assert.equal(document.metrics.elements, elementsBefore, 'hydration must create no elements');
  assert.equal(document.metrics.textNodes, textNodesBefore + 1, 'hydration creates only the list anchor');
  assert.deepEqual(list.childNodes.map((node) => node.nodeValue ?? node.tagName), ['li', 'li', '']);

  // Growing the collection post-hydration reuses adopted records and creates
  // only the new item, inserted before the anchor.
  button.dispatchEvent('click');
  await flushUpdates();
  assert.equal(list.childNodes.length, 4, 'the new item joins the adopted run');
  assert.equal(list.childNodes[2].childNodes[0].nodeValue, 'fig');
  assert.equal(list.childNodes[3].nodeValue, '', 'the anchor stays last');

  // The dropFirst handler compiled but is never dispatched here; a keyed
  // removal has its own test below.
  component.destroy();
  assert.deepEqual(target.childNodes, []);
});

test('keeps adopted records reactive across a keyed removal', async () => {
  const componentSource = '<script>\nlet fruits = [{ id: 1, name: "apple" }, { id: 2, name: "pear" }];\nfunction dropApple() { fruits = fruits.filter((fruit) => fruit.id !== 1); }\n</script><main><button on:click={dropApple}>Drop</button><ul>{#each fruits as fruit (fruit.id)}<li>{fruit.name}</li>{/each}</ul></main>';
  const document = createDocument();
  const { hydrateComponent } = new Function(
    'document',
    stripModule(generateHydratable(componentSource)) + '\nreturn { mountComponent, hydrateComponent, hydrateRoot };'
  )(document);

  const main = document.createElement('main');
  const button = document.createElement('button');
  button.setAttribute('data-wizz-id', '1');
  button.childNodes.push(document.createTextNode('Drop'));
  const list = document.createElement('ul');
  const apple = document.createElement('li');
  apple.childNodes.push(document.createTextNode('apple'));
  const pear = document.createElement('li');
  pear.childNodes.push(document.createTextNode('pear'));
  list.childNodes.push(apple, pear);
  main.childNodes.push(button, list);
  const target = createTarget();
  target.childNodes.push(main);

  const component = hydrateComponent(target, {}, { fruits: [{ id: 1, name: 'apple' }, { id: 2, name: 'pear' }] });
  assert.ok(component);

  button.dispatchEvent('click');
  await flushUpdates();
  // The apple record's adopted node is removed; the pear node is retained.
  assert.equal(list.childNodes.length, 2);
  assert.equal(list.childNodes[0], pear, 'the retained item keeps its adopted node');
  assert.equal(list.childNodes[1].nodeValue, '', 'the anchor follows the retained run');

  component.destroy();
  assert.deepEqual(target.childNodes, []);
});

test('hydrates nested components in place through hydrateRoot', async () => {
  const childSource = '<script>let count = 3; function increment() { count += 1; }</script><div><button on:click={increment}>Clicks: {count}</button></div>';
  const parentSource = '<script>\nimport Counter from "./Counter.wizz";\nlet greeting = "Hi";\n</script><main><h1>{greeting}</h1><Counter /></main>';

  const document = createDocument();
  const childMod = new Function(
    'document',
    stripModule(generateHydratable(childSource)) + '\nreturn { mountComponent, hydrateComponent, hydrateRoot };'
  )(document);
  const parentMod = new Function(
    'document', 'Counter', '__wizzHydrate_Counter',
    stripModule(generateHydratable(parentSource, { componentServerRenderable: { Counter: true } })) + '\nreturn { mountComponent, hydrateComponent, hydrateRoot };'
  )(document, childMod.mountComponent, { hydrateRoot: childMod.hydrateRoot });

  // Delivered markup: the parent's shell with the child's rendered root at
  // the component-tag position, plus the parent state carrying the child
  // slice under the reserved __wizz key.
  const main = document.createElement('main');
  const heading = document.createElement('h1');
  heading.setAttribute('data-wizz-id', '1');
  heading.childNodes.push(document.createTextNode('Hi'));
  const childRoot = document.createElement('div');
  const button = document.createElement('button');
  button.setAttribute('data-wizz-id', '1');
  button.childNodes.push(document.createTextNode('Clicks: '));
  button.childNodes.push(document.createComment(''));
  button.childNodes.push(document.createTextNode('3'));
  childRoot.childNodes.push(button);
  main.childNodes.push(heading, childRoot);
  const target = createTarget();
  target.childNodes.push(main);

  const state = { greeting: 'Hi', __wizz: { components: { '1': { count: 3 } } } };
  const elementsBefore = document.metrics.elements;
  const textNodesBefore = document.metrics.textNodes;

  const parent = parentMod.hydrateComponent(target, {}, state);
  assert.ok(parent);
  // Zero recreation across both templates: parent and child adopted in place.
  assert.equal(document.metrics.elements, elementsBefore, 'nested hydration must create no elements');
  assert.equal(document.metrics.textNodes, textNodesBefore, 'nested hydration must create no text nodes');

  // The child's handler works on the adopted nodes (the walk stripped the
  // adjacency marker, so the expression text sits at index 1).
  button.dispatchEvent('click');
  await flushUpdates();
  assert.equal(button.childNodes[1].nodeValue, '4');

  // Nested destroy leaves the child's node to the parent, which removes the
  // whole subtree at once.
  parent.destroy();
  assert.deepEqual(target.childNodes, []);
});

test('a nested mismatch remounts inside the child root without failing the parent', async () => {
  const childSource = '<script>let count = 3;</script><div><button>Clicks: {count}</button></div>';
  const parentSource = '<script>\nimport Counter from "./Counter.wizz";\nlet greeting = "Hi";\n</script><main><h1>{greeting}</h1><Counter /></main>';

  const document = createDocument();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);

  try {
    const childMod = new Function(
      'document',
      stripModule(generateHydratable(childSource)) + '\nreturn { mountComponent, hydrateComponent, hydrateRoot };'
    )(document);
    const parentMod = new Function(
      'document', 'Counter', '__wizzHydrate_Counter',
      stripModule(generateHydratable(parentSource, { componentServerRenderable: { Counter: true } })) + '\nreturn { mountComponent, hydrateComponent, hydrateRoot };'
    )(document, childMod.mountComponent, { hydrateRoot: childMod.hydrateRoot });

    const elementsBefore = document.metrics.elements;

    // Tamper the CHILD's markup; the parent shell stays intact.
    const main = document.createElement('main');
    const heading = document.createElement('h1');
    heading.setAttribute('data-wizz-id', '1');
    heading.childNodes.push(document.createTextNode('Hi'));
    const childRoot = document.createElement('div');
    const staleButton = document.createElement('button');
    staleButton.setAttribute('data-wizz-id', '1');
    staleButton.childNodes.push(document.createTextNode('Clicks: '));
    staleButton.childNodes.push(document.createComment(''));
    staleButton.childNodes.push(document.createTextNode('999'));
    childRoot.childNodes.push(staleButton);
    main.childNodes.push(heading, childRoot);
    const target = createTarget();
    target.childNodes.push(main);

    const parent = parentMod.hydrateComponent(target, {}, { greeting: 'Hi', __wizz: { components: { '1': { count: 3 } } } });

    // Exactly one warning, from the child's walk.
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^\[wizz\] hydration mismatch: /);
    // The parent shell was adopted in place; only the child remounted, INSIDE
    // its own root, so the parent tree never detached.
    assert.equal(target.childNodes[0], main);
    assert.notEqual(childRoot.firstElementChild, staleButton);
    assert.equal(childRoot.childNodes.length, 1);
    assert.ok(document.metrics.elements > elementsBefore, 'the fallback created fresh child nodes');

    parent.destroy();
    assert.deepEqual(target.childNodes, []);
  } finally {
    console.warn = originalWarn;
  }
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
    `${stripModule(moduleSource)}\nreturn { mountComponent, hydrateComponent };`
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
    `${stripModule(moduleSource)}\nreturn { mountComponent, hydrateComponent };`
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

function createHeadTarget() {
  return createTarget();
}

function buildDeliveredHead(document, { titleText = 'P T', titleOwner = 'r', withMeta = true, extraOwnerTagged = [] } = {}) {
  document.head.appendChild(document.createComment('wizz:head-start'));
  const titleNode = document.createElement('title');
  titleNode.setAttribute('data-wizz-head-id', titleOwner);
  titleNode.setAttribute('data-wizz-loc', '1:12');
  titleNode.textContent = titleText;
  document.head.appendChild(titleNode);
  let metaNode = null;
  if (withMeta) {
    metaNode = document.createElement('meta');
    metaNode.setAttribute('data-wizz-head-id', titleOwner);
    metaNode.setAttribute('content', 'D');
    document.head.appendChild(metaNode);
  }
  for (const owner of extraOwnerTagged) {
    const node = document.createElement('link');
    node.setAttribute('data-wizz-head-id', owner);
    document.head.appendChild(node);
  }
  document.head.appendChild(document.createComment('wizz:head-end'));
  const shellTitle = document.createElement('title');
  shellTitle.textContent = 'Shell';
  document.head.appendChild(shellTitle);
  return { titleNode, metaNode };
}

test('emits the head adoption walk only when head markup or component tags exist', () => {
  const headless = generateHydratable('<main><p>Hi</p></main>');
  assert.doesNotMatch(headless, /__wizzHeadOwner/);
  assert.doesNotMatch(headless, /__wizzHydrateCreate\(__wizzHost, __wizzState, __wizzAdoptSelf, __wizzOwnerPath\)/);
  assert.doesNotMatch(headless, /__wizzFindHeadRun/);

  const withHead = generateHydratable('<wizz:head><title>T</title></wizz:head><main><p>Hi</p></main>');
  assert.match(withHead, /function __wizzHydrateCreate\(__wizzHost, __wizzState, __wizzAdoptSelf, __wizzOwnerPath\) \{/);
  assert.match(withHead, /__wizzFindHeadRun\(\)/);
  assert.match(withHead, /__wizzOwnHead: __wizzHeadNodes \};/);

  // A component tag threads the owner path even when the parent has no head
  // of its own — the child's delivered head must be attributable.
  const withChild = generateHydratable(
    '<script>\nimport Counter from "./Counter.wizz";\n</script><main><Counter /></main>',
    { componentServerRenderable: { Counter: true } }
  );
  assert.match(withChild, /__wizzHeadOwner \+ "\/1"/);
});

test('emits list locals with the reserved prefix so author names cannot collide', () => {
  const source = generateComponent(assignNodeIds(analyzeDependencies(parseComponent(
    '<script>let items = [{ id: 1 }];</script><ul>{#each items as row (row.id)}<li>{row.id}</li>{/each}</ul>'
  ))), { hydratable: true });
  const lists = source.slice(source.indexOf('function __wizzHydrateListItem_1'), source.indexOf('function update('));

  assert.match(lists, /const __wizzItems = items;/);
  assert.doesNotMatch(lists, /\bconst items\b|\bparentRef\b|\bnextRecords\b|\bseenKeys\b|\bstartIndex\b/);
});

test('captures an update target for every reactive node it adopts', () => {
  const source = generateComponent(assignNodeIds(analyzeDependencies(parseComponent(
    '<script>let a = 1; let b = 2;</script><main title={a}><p>{#if a}<b>{a}</b>{/if}</p>{b}</main>'
  ))), { hydratable: true });
  const hydration = source.slice(source.indexOf('function __wizzHydrateCreate'), source.indexOf('function update('));
  const declared = source.match(/let (__wizzTarget_\d+(?:, __wizzTarget_\d+)*);/)[1].split(', ');

  assert.equal(declared.length, 3);
  for (const name of declared) {
    assert.match(hydration, new RegExp(`${name} = `), `${name} is captured by the walk`);
  }
  assert.match(hydration, /__wizzTarget_1 = __wizzRoot;/);
  // Hydratable modules share one declaration across create() and the walk.
  assert.equal(source.match(/let __wizzTarget_1\b/g).length, 1);
});

test('adopts the delivered head run, claims it, and consumes the markers', async () => {
  const componentSource = '<wizz:head><title>P {t}</title><meta content={d}></wizz:head><main><p>{m}</p></main><script>\nlet t = "T";\nlet d = "D";\nlet m = "M";\n</' + 'script>';
  const document = createDocument();
  const { hydrateComponent } = new Function(
    'document',
    stripModule(generateHydratable(componentSource)) + '\nreturn { mountComponent, hydrateComponent, hydrateRoot };'
  )(document);

  const { titleNode, metaNode } = buildDeliveredHead(document, { titleText: 'P T' });
  const main = document.createElement('main');
  const p = document.createElement('p');
  p.setAttribute('data-wizz-id', '1');
  p.childNodes.push(document.createTextNode('M'));
  main.childNodes.push(p);
  const target = createHeadTarget();
  target.childNodes.push(main);

  const elementsBefore = document.metrics.elements;
  const component = hydrateComponent(target, {}, { t: 'T', d: 'D', m: 'M' });
  assert.ok(component);
  assert.equal(document.metrics.elements, elementsBefore, 'adoption must create no head nodes');

  // The title was claimed (ownership re-tagged, delivery tag consumed) and
  // moved ahead of the shell title so the deepest mounted title is the one
  // document.title reads.
  assert.equal(document.head.childNodes[0], titleNode);
  assert.equal(titleNode.attributes['data-wizz-head'], 'h1');
  assert.ok(!('data-wizz-head-id' in titleNode.attributes));
  assert.equal(titleNode.textContent, 'P T');
  assert.equal(metaNode.attributes['data-wizz-head'], 'h1');
  assert.ok(!('data-wizz-head-id' in metaNode.attributes));
  assert.deepEqual(document.head.childNodes.map((node) => node.nodeName), ['TITLE', 'META', 'TITLE']);
  // The marker-delimited run is consumed: markers removed, no leftovers.
  assert.ok(!document.head.childNodes.some((node) => node.nodeValue === 'wizz:head-start' || node.nodeValue === 'wizz:head-end'));

  component.destroy();
  assert.deepEqual(document.head.childNodes.map((node) => node.nodeName), ['TITLE'],
    'destroy releases adopted head nodes and leaves the shell title');
});

test('a head text mismatch falls back to a fresh mount with exactly one title', async () => {
  const componentSource = '<wizz:head><title>P {t}</title></wizz:head><main><p>{m}</p></main><script>let t = "T"; let m = "M";</' + 'script>';
  const document = createDocument();
  const { hydrateComponent } = new Function(
    'document',
    stripModule(generateHydratable(componentSource)) + '\nreturn { mountComponent, hydrateComponent, hydrateRoot };'
  )(document);

  buildDeliveredHead(document, { titleText: 'Tampered', withMeta: false });
  const main = document.createElement('main');
  const p = document.createElement('p');
  p.setAttribute('data-wizz-id', '1');
  p.childNodes.push(document.createTextNode('M'));
  main.childNodes.push(p);
  const target = createHeadTarget();
  target.childNodes.push(main);

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    const component = hydrateComponent(target, {}, { t: 'T', m: 'M' });
    assert.ok(component, 'the fallback mount succeeds');
    assert.equal(warnings.length, 1, 'exactly one mismatch warning');
    assert.match(warnings[0], /head node 0 text mismatch/);
  } finally {
    console.warn = originalWarn;
  }

  // The stale run is stripped and the fresh mount applied its own head: one
  // wizz title with the correct evaluated text, no markers, no duplicates.
  const titles = document.head.childNodes.filter((node) => node.nodeName === 'TITLE');
  assert.deepEqual(titles.map((node) => node.textContent || ''), ['P T', 'Shell']);
  assert.ok(!document.head.childNodes.some((node) => node.nodeValue === 'wizz:head-start' || node.nodeValue === 'wizz:head-end'));
  assert.ok(!document.head.childNodes.some((node) => node.getAttribute('data-wizz-head-id') !== null));
});

test('unclaimed delivered head nodes fail consumption and are stripped', async () => {
  const componentSource = '<wizz:head><title>P {t}</title></wizz:head><main><p>{m}</p></main><script>let t = "T"; let m = "M";</' + 'script>';
  const document = createDocument();
  const { hydrateComponent } = new Function(
    'document',
    stripModule(generateHydratable(componentSource)) + '\nreturn { mountComponent, hydrateComponent, hydrateRoot };'
  )(document);

  // The delivered meta belongs to a component the client never renders, so
  // no component claims it and the run cannot be consumed.
  buildDeliveredHead(document, { titleText: 'P T', withMeta: false, extraOwnerTagged: ['r/99'] });
  const main = document.createElement('main');
  const p = document.createElement('p');
  p.setAttribute('data-wizz-id', '1');
  p.childNodes.push(document.createTextNode('M'));
  main.childNodes.push(p);
  const target = createHeadTarget();
  target.childNodes.push(main);

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    const component = hydrateComponent(target, {}, { t: 'T', m: 'M' });
    assert.ok(component);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /delivered head nodes were never claimed/);
  } finally {
    console.warn = originalWarn;
  }

  assert.ok(!document.head.childNodes.some((node) => node.nodeValue === 'wizz:head-start' || node.nodeValue === 'wizz:head-end'));
  assert.ok(!document.head.childNodes.some((node) => node.getAttribute && node.getAttribute('data-wizz-head-id') !== null));
  const titles = document.head.childNodes.filter((node) => node.nodeName === 'TITLE');
  assert.equal(titles.length, 2, 'the fresh mount applied exactly one wizz title beside the shell title');
});

test('nested head adoption claims the child slice by owner path', async () => {
  const childSource = '<wizz:head><title>Kid</title><meta name="k" content="v"></wizz:head><section><p>{c}</p></section><script>let c = "C";</' + 'script>';
  const parentSource = '<script>\nimport Kid from "./Kid.wizz";\nlet g = "G";\n</script><wizz:head><title>Shell</title></wizz:head><main><h1>{g}</h1><Kid /></main>';

  const document = createDocument();
  const childMod = new Function(
    'document',
    stripModule(generateHydratable(childSource)) + '\nreturn { mountComponent, hydrateComponent, hydrateRoot };'
  )(document);
  const parentMod = new Function(
    'document', 'Kid', '__wizzHydrate_Kid',
    stripModule(generateHydratable(parentSource, { componentServerRenderable: { Kid: true } })) + '\nreturn { mountComponent, hydrateComponent, hydrateRoot };'
  )(document, childMod.mountComponent, { hydrateRoot: childMod.hydrateRoot });

  // Delivered run: the page's title (owner r), then the child's slice
  // (owner r/1) in tree order, then the shell title.
  document.head.appendChild(document.createComment('wizz:head-start'));
  const pageTitle = document.createElement('title');
  pageTitle.setAttribute('data-wizz-head-id', 'r');
  pageTitle.setAttribute('data-wizz-loc', '2:12');
  pageTitle.textContent = 'Shell';
  document.head.appendChild(pageTitle);
  const childTitle = document.createElement('title');
  childTitle.setAttribute('data-wizz-head-id', 'r/1');
  childTitle.setAttribute('data-wizz-loc', '1:12');
  childTitle.textContent = 'Kid';
  document.head.appendChild(childTitle);
  const childMeta = document.createElement('meta');
  childMeta.setAttribute('data-wizz-head-id', 'r/1');
  childMeta.setAttribute('name', 'k');
  childMeta.setAttribute('content', 'v');
  document.head.appendChild(childMeta);
  document.head.appendChild(document.createComment('wizz:head-end'));

  const main = document.createElement('main');
  const heading = document.createElement('h1');
  heading.setAttribute('data-wizz-id', '1');
  heading.childNodes.push(document.createTextNode('G'));
  const childRoot = document.createElement('section');
  const childP = document.createElement('p');
  childP.setAttribute('data-wizz-id', '1');
  childP.childNodes.push(document.createTextNode('C'));
  childRoot.childNodes.push(childP);
  main.childNodes.push(heading, childRoot);
  const target = createHeadTarget();
  target.childNodes.push(main);

  const state = { g: 'G', __wizz: { components: { '1': { c: 'C' } } } };
  const elementsBefore = document.metrics.elements;
  const parent = parentMod.hydrateComponent(target, {}, state);
  assert.ok(parent);
  assert.equal(document.metrics.elements, elementsBefore, 'nested head adoption must create no elements');

  // The child's title is the first title element (deepest declaration wins);
  // both slices are claimed and the markers are consumed.
  assert.equal(document.head.childNodes[0], childTitle);
  // Each module owns its own __wizzHeadOwnerSeq, so the child module's first
  // instance is also 'h1'. The tag is informational; slice lookup uses the
  // server owner path ('r/1'), which cannot collide.
  assert.equal(childTitle.attributes['data-wizz-head'], 'h1');
  assert.ok(!('data-wizz-head-id' in childMeta.attributes));
  assert.equal(pageTitle.getAttribute('data-wizz-head'), 'h1');
  assert.ok(!document.head.childNodes.some((node) => node.nodeValue === 'wizz:head-start'));

  // The destroy cascade releases the child's head before the page's.
  parent.destroy();
  assert.deepEqual(document.head.childNodes.filter((node) => node.nodeName === 'TITLE').map((node) => node.textContent || ''), [],
    'both adopted heads are released on destroy');
});

// --- Dynamic attribute policy (issue #72) ---

function hydrateWithDeliveredMeta(metaAttributes) {
  const componentSource = '<wizz:head><title>T</title><meta content={d} hidden={h} name={n}></wizz:head><main><p>{m}</p></main><script>let d = undefined; let h = false; let n = "x"; let m = "M";</' + 'script>';
  const document = createDocument();
  const { hydrateComponent } = new Function(
    'document',
    stripModule(generateHydratable(componentSource)) + '\nreturn { mountComponent, hydrateComponent, hydrateRoot };'
  )(document);

  document.head.appendChild(document.createComment('wizz:head-start'));
  const title = document.createElement('title');
  title.setAttribute('data-wizz-head-id', 'r');
  title.textContent = 'T';
  document.head.appendChild(title);
  const meta = document.createElement('meta');
  meta.setAttribute('data-wizz-head-id', 'r');
  for (const [name, value] of Object.entries(metaAttributes)) meta.setAttribute(name, value);
  document.head.appendChild(meta);
  document.head.appendChild(document.createComment('wizz:head-end'));

  const main = document.createElement('main');
  const p = document.createElement('p');
  p.setAttribute('data-wizz-id', '1');
  p.childNodes.push(document.createTextNode('M'));
  main.childNodes.push(p);
  const target = createHeadTarget();
  target.childNodes.push(main);

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    const elementsBefore = document.metrics.elements;
    const component = hydrateComponent(target, {}, { d: undefined, h: false, n: 'x', m: 'M' });
    return { component, warnings, created: document.metrics.elements - elementsBefore, meta };
  } finally {
    console.warn = originalWarn;
  }
}

test('head verification accepts delivered markup that omits removed attributes', () => {
  const { component, warnings, created, meta } = hydrateWithDeliveredMeta({ name: 'x' });
  assert.ok(component);
  assert.deepEqual(warnings, []);
  assert.equal(created, 0, 'adoption creates no nodes');
  assert.equal(meta.attributes['data-wizz-head'] != null, true, 'the delivered meta was claimed');
});

test('head verification rejects stringified "undefined" and "false" from older server output', () => {
  for (const delivered of [{ name: 'x', content: 'undefined' }, { name: 'x', hidden: 'false' }]) {
    const { component, warnings } = hydrateWithDeliveredMeta(delivered);
    assert.ok(component, 'the fallback mount succeeds');
    assert.equal(warnings.length, 1, JSON.stringify(delivered));
  }
});

test('hydratable list items write boolean attributes through the helper', () => {
  const source = generateHydratable("<script>let rows = [{ id: 1, done: false }];</script><ul>{#each rows as row (row.id)}<li hidden={row.done}>{row.id}</li>{/each}</ul>");
  const fresh = source.slice(source.indexOf('function __wizzCreateFreshItem_1'), source.indexOf('function __wizzHydrateUpdateList_1'));
  assert.match(fresh, /__wizzAttr\(__wizzFresh_1_0, "hidden", row\.done, 1\);/);
  assert.doesNotMatch(source, /setAttribute\("hidden", String/);
  assert.equal((source.match(/function __wizzAttr\(/g) || []).length, 1);
});

// --- Reactive {#if} (issue #71) and on: inside {#each} (issue #70) ---
// Emission pins for the adoption walk. The behavior these lines produce is
// exercised end to end, against real server markup, in test/hydration.test.js.

const hydrateCreateOf = (source) => source.slice(source.indexOf('function __wizzHydrateCreate('), source.indexOf('// --- Reactivity Engine ---'));

test('adopts a reactive if block into the block machinery create() builds', () => {
  const source = generateHydratable(
    '<script>let flag = true; function go() {}</script><main>{#if flag}<p on:click={go}>{flag}</p>{:else}<i>no</i>{/if}</main>'
  );
  const walk = hydrateCreateOf(source);

  // The scope record and branch key are declared at function scope, before
  // the walk, so component adoption after the walk can reach them.
  assert.match(walk, /const __wizzIfScope_1 = \{ lists: \[\], drop: \[\], mounts: \[\], nodes: \[\] \};\n\s+let __wizzIfKey_1 = 0;/);
  assert.ok(walk.indexOf('__wizzIfScope_1 = {') < walk.indexOf('const __wizzRoot ='));

  // The delivered branch is adopted into the record: its top-level node, its
  // listener (still deferred), and its update target.
  assert.match(walk, /if \(flag\) \{\n\s+__wizzIfKey_1 = 1;/);
  assert.match(walk, /__wizzIfScope_1\.nodes\.push\(__wizzNode_\d+\);/);
  assert.match(walk, /__wizzPendingListeners\.push\(\[__wizzNode_\d+, "click", go, __wizzIfScope_1\.drop\]\);/);
  assert.match(walk, /if \(__wizzProblems\.length === 0\) __wizzIfScope_1\.drop\.push\(\(\) => \{ __wizzTarget_1 = null; \}\);/);

  // The anchor follows the adopted run and the cursor moves past it; the
  // block starts from the adopted key and scope and shares create()'s makers.
  assert.match(walk, /const __wizzIfAnchor_1 = document\.createTextNode\(''\);\n\s+__wizzRoot\.insertBefore\(__wizzIfAnchor_1, __wizzRoot\.childNodes\[__wizzNode_1\] \|\| null\);\n\s+__wizzNode_1 \+= 1;/);
  assert.match(walk, /__wizzIfBlock\(__wizzRoot, __wizzIfAnchor_1, \(\) => \(flag\), \[__wizzIfMake_1_0, __wizzIfMake_1_1\], __wizzIfKey_1, __wizzIfScope_1\);/);
  assert.match(walk, /__wizzLists\.push\(\(__wizzChanged\) => __wizzIf_1\.sync\(__wizzChanged, __wizzChanged\.flag\)\);/);
  assert.match(walk, /__wizzDrop\.push\(__wizzIf_1\.drop\);/);
  // The makers themselves are emitted once, by the create generator.
  assert.equal(source.split('function __wizzIfMake_1_1(').length, 2);
  assert.doesNotMatch(walk, /function __wizzIfMake/);
});

test('routes scoped pending listeners through the scoped helper only when a template has them', () => {
  const scoped = generateHydratable('<script>let flag = true; function go() {}</script><main>{#if flag}<p on:click={go}>x</p>{/if}</main>');
  assert.match(scoped, /__wizzPendingListeners\.forEach\(\(pending\) => \{ if \(pending\[3\]\) pending\[3\]\.push\(__wizzOn\(pending\[0\], pending\[1\], pending\[2\]\)\); else __wizzListen\(pending\[0\], pending\[1\], pending\[2\]\); \}\);/);

  const plain = generateHydratable('<script>let n = 0; function go() {}</script><main on:click={go}>{n}</main>');
  assert.match(plain, /__wizzPendingListeners\.forEach\(\(pending\) => __wizzListen\(pending\[0\], pending\[1\], pending\[2\]\)\);/);
  assert.doesNotMatch(plain, /__wizzOn\b|__wizzIfBlock|__wizzDrop\b/);
});

test('a dependency-free if block is adopted inline with no block machinery', () => {
  const source = generateHydratable("<script>const mode = 'a'; function go() {}</script><main>{#if mode === 'a'}<p on:click={go}>x</p>{/if}</main>");
  const walk = hydrateCreateOf(source);
  assert.match(walk, /if \(mode === 'a'\) \{/);
  assert.match(walk, /__wizzPendingListeners\.push\(\[__wizzNode_\d+, "click", go\]\);/);
  assert.doesNotMatch(source, /__wizzIfScope|__wizzIfBlock|__wizzIfAnchor|__wizzDrop\b/);
});

test('a component tag in a reactive branch is adopted into the branch scope', () => {
  const source = generateHydratable(
    '<script>\nimport Counter from "./Counter.wizz";\nlet flag = true;\nlet label = "a";\n</script><main>{#if flag}<Counter label={label} />{/if}</main>',
    { componentServerRenderable: { Counter: true } }
  );
  const walk = hydrateCreateOf(source);
  // A self-adopted child leaves its root in place on destroy, so the branch
  // tracks that root as one of its own nodes.
  assert.match(walk, /if \(__wizzProblems\.length === 0\) __wizzIfScope_1\.nodes\.push\(__wizzNode_1\);/);
  // An untaken branch leaves the ref null: nothing is adopted, and the maker
  // mounts the child if the branch is taken later.
  assert.match(walk, /if \(__wizzProblems\.length === 0 && __wizzNode_1\) \{/);
  assert.match(walk, /__wizzIfScope_1\.drop\.push\(\(\) => \{ __wizzChild_1\.destroy\(\); __wizzComponent_1 = null; \}\);/);
  assert.doesNotMatch(walk, /__wizzChildren\.push\(__wizzChild_1\)/, 'a branch child is not in the component-wide list');
  assert.match(walk, /__wizzComponent_1 = __wizzChild_1;/);
});

test('a component tag outside reactive branches keeps the component-wide adoption', () => {
  const source = generateHydratable(
    '<script>\nimport Counter from "./Counter.wizz";\n</script><main><Counter /></main>',
    { componentServerRenderable: { Counter: true } }
  );
  const walk = hydrateCreateOf(source);
  assert.match(walk, /__wizzChildren\.push\(__wizzChild_1\);/);
  assert.doesNotMatch(walk, /__wizzIfScope|&& __wizzNode_1\) \{/);
});

test('a component tag in a dependency-free if branch guards adoption on its ref', () => {
  const source = generateHydratable(
    '<script>\nimport Counter from "./Counter.wizz";\nconst show = false;\n</script><main>{#if show}<Counter />{/if}</main>',
    { componentServerRenderable: { Counter: true } }
  );
  const walk = hydrateCreateOf(source);
  // Even without a reactive branch scope, an untaken constant branch leaves
  // the component ref null and must not call hydrateRoot(null, ...).
  assert.match(walk, /if \(__wizzProblems\.length === 0 && __wizzNode_1\) \{/);
  assert.match(walk, /__wizzChildren\.push\(__wizzChild_1\);/);
  assert.doesNotMatch(walk, /__wizzIfScope/);
});

test('each items with listeners queue them per record and rebind the item on update', () => {
  const source = generateHydratable(
    '<script>let rows = [{ id: 1 }]; function pick() {}</script><ul>{#each rows as row (row.id)}<li><button on:click={() => pick(row.id)}>x</button></li>{/each}</ul>'
  );
  const walk = hydrateCreateOf(source);

  // Adopted item: the listener is queued only after the whole item verified,
  // carrying the record's own drop list.
  const adoptItem = walk.slice(walk.indexOf('function __wizzHydrateListItem_1('), walk.indexOf('function __wizzCreateFreshItem_1('));
  assert.match(adoptItem, /const __wizzDrop = \[\];\n\s+__wizzPendingListeners\.push\(\[__wizzNode_1_0_1, "click", \(\) => pick\(row\.id\), __wizzDrop\]\);\n\s+return \{/);
  assert.ok(adoptItem.lastIndexOf('return null;') < adoptItem.indexOf('const __wizzDrop = [];'), 'no listener is queued before the last verification');
  assert.match(adoptItem, /drop: __wizzDrop,\n\s+update\(__wizzItem\) \{\n\s+row = __wizzItem;/);

  // Fresh item (created after hydration): attached immediately.
  const freshItem = walk.slice(walk.indexOf('function __wizzCreateFreshItem_1('), walk.indexOf('function __wizzHydrateUpdateList_1('));
  assert.match(freshItem, /__wizzDrop\.push\(__wizzOn\(__wizzFresh_1_1, "click", \(\) => pick\(row\.id\)\)\);/);
  assert.doesNotMatch(freshItem, /setAttribute\("on:/);
  assert.match(freshItem, /drop: __wizzDrop,\n\s+update\(__wizzItem\) \{\n\s+row = __wizzItem;/);

  // Removal and scope teardown both release record listeners.
  assert.match(walk, /if \(!__wizzNext\.has\(__wizzKey\)\) \{ __wizzAnchor_1\.parentNode\.removeChild\(__wizzRecord\.node\); for \(const __wizzDropItem of __wizzRecord\.drop\) __wizzDropItem\(\); \}/);
  assert.match(walk, /__wizzDrop\.push\(\(__wizzDetach\) => \{\n\s+__wizzRecords_1\.forEach\(\(__wizzRecord\) => \{\n\s+for \(const __wizzDropItem of __wizzRecord\.drop\) __wizzDropItem\(\);\n\s+\}\);\n\s+__wizzRecords_1\.clear\(\);\n\s+\}\);/);
});

test('a list directly in a reactive branch registers in the branch scope and detaches with it', () => {
  const source = generateHydratable(
    '<script>let flag = true; let rows = [1];</script><ul>{#if flag}{#each rows as row}<li>{row}</li>{/each}{/if}</ul>'
  );
  const walk = hydrateCreateOf(source);
  assert.match(walk, /__wizzIfScope_1\.lists\.push\(\(__wizzChanged\) => \{ if \(__wizzChanged\.rows\) __wizzHydrateUpdateList_1\(\); \}\);/);
  assert.match(walk, /__wizzIfScope_1\.nodes\.push\(__wizzAnchor_1\);/);
  assert.match(walk, /__wizzIfScope_1\.drop\.push\(\(__wizzDetach\) => \{\n\s+__wizzRecords_1\.forEach\(\(__wizzRecord\) => \{\n\s+if \(__wizzDetach\) __wizzParent\.removeChild\(__wizzRecord\.node\);/);
  assert.doesNotMatch(walk, /\b__wizzLists\.push\(\(__wizzChanged\) => \{ if \(__wizzChanged\.rows\)/, 'the list is not registered component-wide');
});

test('hydratable list items without listeners keep the listener-free record shape', () => {
  const source = generateHydratable('<script>let rows = [1];</script><ul>{#each rows as row}<li>{row}</li>{/each}</ul>');
  assert.doesNotMatch(source, /__wizzDrop\b|__wizzOn\b|__wizzItem\b/);
  assert.match(source, /update\(row\) \{/);
});

test('adopts a reactive block from shim markup, then swaps and releases its listener', async () => {
  const componentSource = '<script>let open = true; function toggle() { open = !open; } function noop() {}</script>'
    + '<main><button on:click={toggle}>t</button>{#if open}<p on:click={noop}>yes</p>{/if}</main>';
  const document = createDocument();
  const { hydrateComponent } = new Function(
    'document',
    stripModule(generateHydratable(componentSource)) + '\nreturn { mountComponent, hydrateComponent, hydrateRoot };'
  )(document);

  // Delivered markup, with the block's boundary markers as comments.
  const main = document.createElement('main');
  const button = document.createElement('button');
  button.childNodes.push(document.createTextNode('t'));
  const paragraph = document.createElement('p');
  paragraph.childNodes.push(document.createTextNode('yes'));
  main.childNodes.push(button, document.createComment(' '), paragraph, document.createComment(' '));
  const target = createTarget();
  target.childNodes.push(main);

  const elementsBefore = document.metrics.elements;
  const textNodesBefore = document.metrics.textNodes;
  const component = hydrateComponent(target, {}, { open: true });
  assert.ok(component);
  assert.equal(document.metrics.elements, elementsBefore, 'adoption creates no elements');
  assert.equal(document.metrics.textNodes, textNodesBefore + 1, 'only the block anchor is created');
  assert.deepEqual(main.childNodes.map((node) => node.tagName ?? node.nodeValue), ['button', 'p', '']);
  assert.equal(typeof paragraph.listeners.click, 'function');

  button.dispatchEvent('click');
  await flushUpdates();
  assert.deepEqual(main.childNodes.map((node) => node.tagName ?? node.nodeValue), ['button', '']);
  assert.equal(paragraph.listeners.click, undefined, 'the adopted branch released its listener');

  button.dispatchEvent('click');
  await flushUpdates();
  assert.deepEqual(main.childNodes.map((node) => node.tagName ?? node.nodeValue), ['button', 'p', '']);
  assert.notEqual(main.childNodes[1], paragraph);

  const rebuilt = main.childNodes[1];
  component.destroy();
  assert.equal(rebuilt.listeners.click, undefined);
  assert.deepEqual(target.childNodes, []);
});

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
  assert.match(source, /const rootNode = adoptSelf \? target : target\.firstElementChild;/);
  assert.match(source, /__wizzNodeTag\(rootNode\) !== 'main'/);
  assert.match(source, /__wizzStripComments\(rootNode\);/);
  // Comment stripping precedes the flattened child-count comparison.
  assert.match(source, /!== rootNode\.childNodes\.length/);
  // The reactive paragraph is verified by its analyzer-assigned id value.
  assert.match(source, /\.getAttribute\('data-wizz-id'\) !== "1"/);
  // Expression text is compared against the seeded runtime value.
  assert.match(source, /\.nodeValue !== String\(count\)/);
  // A single mismatch exit reports once, clears the target, and returns null.
  assert.match(source, /console\.warn\('\[wizz\] hydration mismatch: ' \+ problems\.join\('; '\) \+ '\. Falling back to client rendering\.'\);/);
  assert.match(source, /while \(target\.childNodes\.length > 0\) target\.removeChild\(target\.childNodes\[0\]\);/);
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

test('declares component-tag refs at hydrateCreate scope for tags inside branches', () => {
  const source = generateHydratable(
    '<script>\nimport Counter from "./Counter.wizz";\nlet flag = true;\n</script><main>{#if flag}<Counter />{/if}</main>',
    { componentServerRenderable: { Counter: true } }
  );

  // The ref is declared before the branch wrapper and only assigned inside
  // it: the adoption block after the walk references it at function scope,
  // so an inline `let` inside the branch would be out of scope there.
  const hydrationStart = source.indexOf('function hydrateCreate(');
  const declarationIndex = source.indexOf('let node_1 = null;', hydrationStart);
  const branchIndex = source.indexOf('if (flag) {', hydrationStart);
  const adoptionIndex = source.indexOf('.hydrateRoot(node_1,');
  assert.ok(declarationIndex !== -1, 'component ref declared at function scope');
  assert.ok(branchIndex !== -1 && adoptionIndex !== -1);
  assert.ok(declarationIndex < branchIndex, 'declaration precedes the branch wrapper');
  assert.ok(branchIndex < adoptionIndex, 'adoption follows the branch');
  // The in-branch assignment must not redeclare the ref.
  assert.doesNotMatch(source.slice(branchIndex, adoptionIndex), /let node_1/);
});

test('emits per-list machinery for each blocks', () => {
  const source = generateHydratable(
    '<script>let fruits = [{ id: 1, name: "apple" }];</script><ul>{#each fruits as fruit (fruit.id)}<li>{fruit.name}</li>{/each}</ul>'
  );

  assert.match(source, /function hydrateList_1\(parentRef, startIndex\) \{/);
  assert.match(source, /const key = fruit\.id;/);
  assert.match(source, /if \(records_1\.has\(key\)\) problems\.push\('Each block keys must be unique\.'\);/);
  // The anchor is created during hydration: an empty text node cannot
  // survive HTML serialization.
  assert.match(source, /anchor_1 = document\.parentNode\.createTextNode|anchor_1 = document\.createTextNode\(''\);/);
  // Future client updates flow through the rebuilt records map.
  assert.match(source, /listUpdates\.push\(\(changed\) => \{ if \(changed\.fruits\) hydrateUpdateList_1\(\); \}\);/);
});

test('defers listener attachment until after the walk passes', () => {
  const source = generateHydratable('<script>function go() {}</script><main><button on:click={go}>go</button></main>');

  // The listener is collected during the walk...
  assert.match(source, /pendingListeners\.push\(\[node_\d+, "click", go\]\);/);
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

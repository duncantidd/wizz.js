const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const test = require('node:test');
const { compile } = require('../src/compiler');

const fixturesDirectory = path.join(__dirname, 'fixtures');

function loadFixture(name) {
  return fs.readFileSync(path.join(fixturesDirectory, `${name}.wizz`), 'utf8');
}

function createInstrumentedDocument() {
  const elements = new Map();
  const metrics = { elements: 0, textNodes: 0, queries: 0, textWrites: 0, addedListeners: 0, removedListeners: 0 };
  // Real DOM sibling lookup through the tracked parent: a component that is
  // an each item's root is found through its anchor's previous sibling.
  const previousSiblingOf = (node) => {
    const siblings = node.parentNode ? node.parentNode.childNodes : null;
    const index = siblings ? siblings.indexOf(node) : -1;
    return index > 0 ? siblings[index - 1] : null;
  };

  return {
    metrics,
    createElement(name) {
      metrics.elements++;
      return {
        name,
        nodeType: 1,
        tagName: name.toUpperCase(),
        attributes: {},
        childNodes: [],
        listeners: {},
        parentNode: null,
        get previousSibling() { return previousSiblingOf(this); },
        setAttribute(attributeName, value) {
          this.attributes[attributeName] = value;
          if (attributeName === 'data-wizz-id') elements.set(`[data-wizz-id="${value}"]`, this);
        },
        getAttribute(attributeName) {
          return this.attributes[attributeName] ?? null;
        },
        querySelector(selector) {
          metrics.queries++;
          const find = (node) => {
            for (const child of node.childNodes || []) {
              if (child.attributes?.['data-wizz-id'] && selector === `[data-wizz-id="${child.attributes['data-wizz-id']}"]`) return child;
              const match = find(child);
              if (match) return match;
            }
            return null;
          };
          return find(this);
        },
        appendChild(node) {
          if (node.parentNode) node.parentNode.removeChild(node);
          this.childNodes.push(node);
          node.parentNode = this;
        },
        // Moves an attached node, as list reconciliation and block branches do.
        insertBefore(node, referenceNode) {
          if (node.parentNode && node.parentNode !== this) node.parentNode.removeChild(node);
          const existing = this.childNodes.indexOf(node);
          if (existing !== -1) this.childNodes.splice(existing, 1);
          const index = referenceNode == null ? -1 : this.childNodes.indexOf(referenceNode);
          this.childNodes.splice(index === -1 ? this.childNodes.length : index, 0, node);
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
        dispatchEvent(eventName) { this.listeners[eventName]?.({ type: eventName, target: this }); }
      };
    },
    createTextNode(initialValue) {
      metrics.textNodes++;
      return {
        nodeType: 3,
        parentNode: null,
        get previousSibling() { return previousSiblingOf(this); },
        _nodeValue: initialValue,
        get nodeValue() { return this._nodeValue; },
        set nodeValue(value) {
          this._nodeValue = value;
          metrics.textWrites++;
        }
      };
    },
    createComment(nodeValue) {
      return { nodeType: 8, nodeValue };
    },
    querySelector(selector) {
      metrics.queries++;
      return elements.get(selector) || null;
    }
  };
}

function createFixtureMounter(name, document, queueMicrotask) {
  const source = compile(loadFixture(name), { filePath: `test/fixtures/${name}.wizz` }).source;
  const mountComponent = new Function(
    'document',
    'queueMicrotask',
    `${source.replace('export default ', '')}\nreturn mountComponent;`
  )(document, queueMicrotask);

  return () => {
    const target = createTarget();
    return { component: mountComponent(target), target };
  };
}

function createTarget() {
  return {
    childNodes: [],
    appendChild(node) { this.childNodes.push(node); node.parentNode = this; },
    removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); node.parentNode = null; }
  };
}

// Evaluates a parent fixture that imports one child fixture: the child module
// is compiled and evaluated the same way and handed to the parent in place of
// its import statement.
function createNestedFixtureMounter(parentName, childName, importName, document, queueMicrotask) {
  const evaluate = (source, extra = {}) => new Function(
    'document',
    'queueMicrotask',
    ...Object.keys(extra),
    `${source.replace('export default ', '')}\nreturn mountComponent;`
  )(document, queueMicrotask, ...Object.values(extra));
  const child = evaluate(compile(loadFixture(childName), { filePath: `test/fixtures/${childName}.wizz` }).source);
  const parentSource = compile(loadFixture(parentName), { filePath: `test/fixtures/${parentName}.wizz` }).source
    .split('\n')
    .filter((line) => !line.startsWith(`import ${importName} from `))
    .join('\n');
  const mountComponent = evaluate(parentSource, { [importName]: child });
  return () => {
    const target = createTarget();
    return { component: mountComponent(target), target };
  };
}

function mountFixture(name, document, queueMicrotask) {
  return createFixtureMounter(name, document, queueMicrotask)();
}

function countElements(node) {
  return (node.name ? 1 : 0) + (node.childNodes || []).reduce((count, child) => count + countElements(child), 0);
}

test('benchmark fixture batches 1,000 repeated updates into one DOM update', (t) => {
  const scheduled = [];
  const document = createInstrumentedDocument();
  const { target, component } = mountFixture('benchmark-updates', document, (callback) => scheduled.push(callback));
  const button = target.childNodes[0].childNodes[0];
  const countText = target.childNodes[0].childNodes[1].childNodes[1];
  document.metrics.queries = 0;
  document.metrics.textWrites = 0;

  const start = performance.now();
  for (let update = 0; update < 1000; update++) button.dispatchEvent('click');
  const dispatchDuration = performance.now() - start;

  assert.equal(scheduled.length, 1);
  assert.equal(countText.nodeValue, '0');
  scheduled.pop()();
  assert.equal(countText.nodeValue, '1000');
  assert.equal(document.metrics.queries, 0);
  assert.equal(document.metrics.textWrites, 1);
  assert.ok(dispatchDuration >= 0);
  t.diagnostic(`1,000 queued updates dispatched in ${dispatchDuration.toFixed(2)} ms`);
  component.destroy();
});

test('benchmark fixture removes every tracked listener across repeated teardown', (t) => {
  const document = createInstrumentedDocument();
  const mount = createFixtureMounter('benchmark-teardown', document, queueMicrotask);
  const iterations = 25;
  const start = performance.now();

  for (let iteration = 0; iteration < iterations; iteration++) {
    const { component, target } = mount();
    component.destroy();
    assert.deepEqual(target.childNodes, []);
  }

  const teardownDuration = performance.now() - start;
  assert.equal(document.metrics.addedListeners, iterations * 8);
  assert.equal(document.metrics.removedListeners, iterations * 8);
  assert.ok(teardownDuration >= 0);
  t.diagnostic(`${iterations} listener-heavy mount/destroy cycles completed in ${teardownDuration.toFixed(2)} ms`);
});

test('benchmark fixture mounts and tears down a 121-element static tree without reactive lookups', (t) => {
  const document = createInstrumentedDocument();
  const start = performance.now();
  const { component, target } = mountFixture('benchmark-large-tree', document, queueMicrotask);
  const mountDuration = performance.now() - start;

  assert.equal(countElements(target.childNodes[0]), 121);
  assert.equal(document.metrics.elements, 121);
  assert.equal(document.metrics.queries, 0);
  component.destroy();
  assert.deepEqual(target.childNodes, []);
  assert.ok(mountDuration >= 0);
  t.diagnostic(`121-element static tree mounted in ${mountDuration.toFixed(2)} ms`);
});
test('benchmark fixture rebuilds a 100-row branch per toggle and never leaks a listener', (t) => {
  // Reactive {#if} (issue #71) around a keyed list whose rows carry on:
  // handlers (issue #70): every toggle drops or builds the whole branch, so
  // the per-toggle cost and the listener balance are pinned exactly.
  const scheduled = [];
  const flush = () => { while (scheduled.length > 0) scheduled.shift()(); };
  const document = createInstrumentedDocument();
  const { target, component } = mountFixture('benchmark-blocks', document, (callback) => scheduled.push(callback));
  const main = target.childNodes[0];
  const [toggle, drop] = main.childNodes;
  const rowButtons = () => main.childNodes[2].childNodes.filter((node) => node.name === 'li').map((item) => item.childNodes[0]);

  // main, two buttons, the list, and an li + button per row.
  assert.equal(document.metrics.elements, 4 + 200);
  assert.equal(document.metrics.addedListeners, 2 + 100);
  assert.equal(document.metrics.queries, 0);

  // Removing one row releases exactly its listener and creates nothing.
  rowButtons()[40].dispatchEvent('click');
  flush();
  drop.dispatchEvent('click');
  flush();
  assert.equal(rowButtons().length, 99);
  assert.equal(document.metrics.elements, 4 + 200);
  assert.equal(document.metrics.removedListeners, 1);

  const cycles = 20;
  const elementsBefore = document.metrics.elements;
  const addedBefore = document.metrics.addedListeners;
  const removedBefore = document.metrics.removedListeners;
  const start = performance.now();
  for (let cycle = 0; cycle < cycles; cycle++) {
    toggle.dispatchEvent('click');
    flush();
    assert.equal(main.childNodes[2].name, 'p');
    toggle.dispatchEvent('click');
    flush();
    assert.equal(main.childNodes[2].name, 'ul');
  }
  const toggleDuration = performance.now() - start;

  // Per cycle: one <p>, then the list with 99 rows (ul + 99 li + 99 buttons).
  assert.equal(document.metrics.elements - elementsBefore, cycles * (1 + 1 + 99 * 2));
  assert.equal(document.metrics.addedListeners - addedBefore, cycles * 99);
  assert.equal(document.metrics.removedListeners - removedBefore, cycles * 99);
  assert.equal(document.metrics.addedListeners - document.metrics.removedListeners, 2 + 99, 'live listeners never grow');
  assert.equal(main.childNodes.length, 4, 'two buttons, one branch root, one anchor');
  assert.equal(document.metrics.queries, 0);

  component.destroy();
  assert.deepEqual(target.childNodes, []);
  assert.equal(document.metrics.addedListeners, document.metrics.removedListeners);
  assert.ok(toggleDuration >= 0);
  t.diagnostic(`${cycles} drop/rebuild cycles of a 99-row listener-bearing branch completed in ${toggleDuration.toFixed(2)} ms`);
});

test('benchmark fixture mounts and updates 1,000 keyed row components with exact costs', (t) => {
  // Milestone 25: every row is a child component owned by its item record.
  // The counts pin that unchanged rows never re-render (setProps compares
  // with Object.is), keyed moves create nothing, and removal leaks nothing.
  const scheduled = [];
  const flush = () => { while (scheduled.length > 0) scheduled.shift()(); };
  const document = createInstrumentedDocument();
  const mount = createNestedFixtureMounter('benchmark-rows', 'benchmark-row', 'Row', document, (callback) => scheduled.push(callback));
  const rowCount = 1000;

  let start = performance.now();
  const { target, component } = mount();
  const mountDuration = performance.now() - start;
  const main = target.childNodes[0];
  const [relabel, reverse, drop, list] = main.childNodes;
  const rows = () => list.childNodes.filter((node) => node.name === 'li');

  // main, three buttons, the list; li + button + span per row.
  assert.equal(document.metrics.elements, 5 + rowCount * 3);
  assert.equal(document.metrics.addedListeners, 3 + rowCount);
  assert.equal(rows().length, rowCount);
  assert.equal(list.childNodes.length, rowCount + 1, 'rows plus the list anchor: no placeholder is left');
  assert.equal(document.metrics.queries, 0);

  // Changing every tenth item rewrites exactly those labels.
  const before = { ...document.metrics };
  start = performance.now();
  relabel.dispatchEvent('click');
  flush();
  const relabelDuration = performance.now() - start;
  assert.equal(document.metrics.textWrites - before.textWrites, rowCount / 10);
  assert.equal(document.metrics.elements, before.elements);
  assert.equal(rows()[10].childNodes[0].childNodes[0].nodeValue, 'Row 10!');
  assert.equal(rows()[11].childNodes[0].childNodes[0].nodeValue, 'Row 11');

  // Row state rides along with a keyed reverse, which creates and writes nothing.
  const clicked = rows()[5];
  clicked.childNodes[0].dispatchEvent('click');
  flush();
  assert.equal(clicked.childNodes[1].childNodes[0].nodeValue, '1');
  const afterClick = { ...document.metrics };
  start = performance.now();
  reverse.dispatchEvent('click');
  flush();
  const reverseDuration = performance.now() - start;
  assert.equal(rows()[rowCount - 1 - 5], clicked);
  assert.equal(clicked.childNodes[1].childNodes[0].nodeValue, '1');
  assert.equal(document.metrics.elements, afterClick.elements);
  assert.equal(document.metrics.textWrites, afterClick.textWrites);

  // Dropping the picked row destroys exactly one instance and its listener.
  const afterReverse = { ...document.metrics };
  drop.dispatchEvent('click');
  flush();
  assert.equal(rows().length, rowCount - 1);
  assert.ok(!rows().includes(clicked));
  assert.equal(document.metrics.removedListeners - afterReverse.removedListeners, 1);
  assert.equal(document.metrics.elements, afterReverse.elements);

  start = performance.now();
  component.destroy();
  const destroyDuration = performance.now() - start;
  assert.deepEqual(target.childNodes, []);
  assert.equal(document.metrics.addedListeners, document.metrics.removedListeners, 'every row listener was released');
  t.diagnostic(`1,000 row components mounted in ${mountDuration.toFixed(2)} ms; relabel ${relabelDuration.toFixed(2)} ms; keyed reverse ${reverseDuration.toFixed(2)} ms; destroy ${destroyDuration.toFixed(2)} ms`);
});

test('hydration adopts delivered markup with zero DOM creation and exact reactive writes', async (t) => {
  const document = createInstrumentedDocument();
  // The hydratable module carries a second named export alongside the
  // default mount, so both export forms are stripped for execution.
  const source = compile(loadFixture('hydration'), { hydratable: true }).source;
  const module = new Function(
    'document',
    'queueMicrotask',
    `${source
      .replace('export default function mountComponent(', 'function mountComponent(')
      .replace('export function hydrateComponent(', 'function hydrateComponent(')
      .replace('export function hydrateRoot(', 'function hydrateRoot(')
    }\nreturn { hydrateComponent };`
  )(document, queueMicrotask);

  // Stand-in for delivered markup, built through the instrumented document
  // exactly as the server target renders the hydration fixture. The p
  // element is the only node the analyzer stamps with a data-wizz-id.
  const section = document.createElement('section');
  section.setAttribute('class', 'panel');
  const whitespace = (value) => section.appendChild(document.createTextNode(value));
  whitespace('\n  ');
  const heading = document.createElement('h1');
  heading.appendChild(document.createTextNode('Hydration'));
  section.appendChild(heading);
  whitespace('\n  ');
  const paragraph = document.createElement('p');
  paragraph.setAttribute('data-note', 'ready');
  paragraph.setAttribute('data-wizz-id', '1');
  paragraph.appendChild(document.createTextNode('Visits: '));
  paragraph.appendChild(document.createComment(''));
  paragraph.appendChild(document.createTextNode('0'));
  section.appendChild(paragraph);
  whitespace('\n  ');
  const button = document.createElement('button');
  button.appendChild(document.createTextNode('Increment'));
  section.appendChild(button);
  whitespace('\n');
  const target = {
    childNodes: [section],
    get firstElementChild() { return this.childNodes.find((node) => node.nodeType === 1) ?? null; },
    appendChild(node) { this.childNodes.push(node); },
    removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); }
  };

  // Delivered-markup construction is done; hydration itself must create
  // nothing — the walk only reads attributes. The initial update then issues
  // one targeted lookup per reactive variable (count and note share a
  // data-wizz-id target).
  const before = { ...document.metrics };
  const component = module.hydrateComponent(target, {}, { count: 0, note: 'ready' });
  const hydration = {
    elements: document.metrics.elements - before.elements,
    textNodes: document.metrics.textNodes - before.textNodes,
    queries: document.metrics.queries - before.queries
  };
  assert.deepEqual(hydration, { elements: 0, textNodes: 0, queries: 0 });

  // The initial update converges with exactly one reactive text write.
  assert.equal(document.metrics.textWrites - before.textWrites, 1);

  // A dispatched event produces exactly one batched write on adopted nodes.
  button.dispatchEvent('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(paragraph.childNodes[1].nodeValue, '1');
  assert.equal(paragraph.attributes['data-note'], 'clicked');
  assert.equal(document.metrics.textWrites - before.textWrites, 2);
  assert.equal(document.metrics.queries - before.queries, 0);

  component.destroy();
  assert.deepEqual(target.childNodes, []);
  assert.equal(document.metrics.removedListeners, 1);
});

// Milestone 23: `wizz build --compact` size reduction and compaction cost.
// Every benchmark fixture is compiled to its client, hydratable, and server
// modules, which are compacted alongside the shipped runtime. The recorded
// reduction is the number a production deploy sees for generated code; the
// floor and budget catch a compactor that stops compacting or turns slow.
test('compact builds shrink generated modules and the runtime within a time budget', (t) => {
  const { compileServer } = require('../src/compiler');
  const { compactJs } = require('../src/compiler/compact');
  const sources = [];
  for (const name of ['benchmark-blocks', 'benchmark-large-tree', 'benchmark-teardown', 'benchmark-updates', 'hydration', 'profile']) {
    const source = loadFixture(name);
    sources.push(compile(source).source);
    sources.push(compile(source, { hydratable: true }).source);
    sources.push(compileServer(source).source);
  }
  const runtimeDirectory = path.join(__dirname, '..', 'src', 'runtime');
  for (const name of fs.readdirSync(runtimeDirectory).filter((file) => file.endsWith('.js'))) {
    sources.push(fs.readFileSync(path.join(runtimeDirectory, name), 'utf8'));
  }

  compactJs(sources[0]); // Warm up.
  const before = sources.reduce((total, source) => total + Buffer.byteLength(source), 0);
  const start = performance.now();
  const after = sources.map((source) => compactJs(source)).reduce((total, source) => total + Buffer.byteLength(source), 0);
  const duration = performance.now() - start;
  const reduction = 1 - after / before;

  assert.ok(reduction > 0.15, `expected at least a 15% reduction, got ${(reduction * 100).toFixed(1)}%`);
  assert.ok(duration < 2000, `compaction took ${duration.toFixed(0)} ms`);
  t.diagnostic(`${sources.length} modules compacted ${before} -> ${after} bytes (${(reduction * 100).toFixed(1)}% smaller) in ${duration.toFixed(2)} ms`);
});

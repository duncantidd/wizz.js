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

  return {
    metrics,
    createElement(name) {
      metrics.elements++;
      return {
        name,
        attributes: {},
        childNodes: [],
        listeners: {},
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
        appendChild(node) { this.childNodes.push(node); },
        removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); },
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
        _nodeValue: initialValue,
        get nodeValue() { return this._nodeValue; },
        set nodeValue(value) {
          this._nodeValue = value;
          metrics.textWrites++;
        }
      };
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
    const target = {
      childNodes: [],
      appendChild(node) { this.childNodes.push(node); },
      removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); }
    };

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
  assert.equal(document.metrics.queries, 1);
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
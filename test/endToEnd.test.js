const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { compile } = require('../src/compiler');

const fixturesDir = path.join(__dirname, 'fixtures');

function loadFixture(name) {
  return fs.readFileSync(path.join(fixturesDir, `${name}.wizz`), 'utf-8');
}

// Fixture paths passed to compile() are repo-relative so error messages stay readable.
const fixturePath = (name) => `test/fixtures/${name}.wizz`;

function createDocument() {
  const elements = new Map();

  return {
    createElement(name) {
      return {
        name,
        attributes: {},
        childNodes: [],
        listeners: {},
        setAttribute(attributeName, value) {
          this.attributes[attributeName] = value;
          if (attributeName === 'data-wizz-id') {
            elements.set(`[data-wizz-id="${value}"]`, this);
          }
        },
        appendChild(node) {
          this.childNodes.push(node);
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
    },
    createTextNode(nodeValue) {
      return { nodeValue };
    },
    querySelector(selector) {
      return elements.get(selector) || null;
    }
  };
}

async function flushUpdates() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function mountFixture(name) {
  const { source } = compile(loadFixture(name), { filePath: fixturePath(name) });
  const document = createDocument();
  const target = {
    childNodes: [],
    appendChild(node) {
      this.childNodes.push(node);
    },
    removeChild(node) {
      this.childNodes.splice(this.childNodes.indexOf(node), 1);
    }
  };
  const mountComponent = new Function(
    'document',
    `${source.replace('export default ', '')}\nreturn mountComponent;`
  )(document);

  return { source, document, target, component: mountComponent(target) };
}

function findElement(root, name) {
  for (const node of root.childNodes || []) {
    if (node.name === name) return node;
    const found = findElement(node, name);
    if (found) return found;
  }
  return null;
}

test('counter fixture mounts, updates through events, and unmounts', async () => {
  const { source, document, target, component } = mountFixture('counter');

  assert.match(source, /count \+= 1; queueUpdate\(\{ count: true \}\);/);

  assert.equal(target.childNodes[0].name, 'main');
  const button = document.querySelector('[data-wizz-id="1"]');
  assert.equal(button.name, 'button');
  assert.equal(button.childNodes[1].nodeValue, '0');

  button.dispatchEvent('click');
  button.dispatchEvent('click');
  await flushUpdates();
  assert.equal(button.childNodes[1].nodeValue, '2');

  component.destroy();
  assert.deepEqual(target.childNodes, []);
});

test('profile fixture renders constants once and reactive state through events', async () => {
  const { document, component } = mountFixture('profile');

  const heading = document.querySelector('[data-wizz-id="1"]');
  const paragraph = document.querySelector('[data-wizz-id="2"]');
  const button = document.querySelector('[data-wizz-id="3"]');

  // The const title and both reactive values render during creation.
  assert.equal(heading.childNodes[0].nodeValue, 'Ada');
  assert.deepEqual(paragraph.childNodes.map((node) => node.nodeValue), ['Dashboard', ': ', '0']);
  assert.equal(button.childNodes[1].nodeValue, '0');

  button.dispatchEvent('click');

  // One event mutates two pieces of state; the scheduler coalesces both
  // queueUpdate calls into one batch, and every dependent expression updates.
  await flushUpdates();
  assert.equal(heading.childNodes[0].nodeValue, 'Grace');
  assert.equal(paragraph.childNodes[2].nodeValue, '1');
  assert.equal(button.childNodes[1].nodeValue, '1');

  component.destroy();
});

test('lifecycle fixture runs mount hooks after mounting and destroy hooks before teardown', async () => {
  const { document, target, component } = mountFixture('lifecycle');

  // The hook has run by the time mountComponent returns, but its state
  // assignment flows through the batched scheduler and renders on a microtask.
  assert.equal(document.querySelector('[data-wizz-id="1"]').childNodes[0].nodeValue, 'created');
  await flushUpdates();
  assert.equal(document.querySelector('[data-wizz-id="1"]').childNodes[0].nodeValue, 'mounted');

  component.destroy();
  assert.equal(document.title, 'destroyed');
  assert.deepEqual(target.childNodes, []);
});

test('static fixture mounts without any reactive machinery', () => {
  const { source, target, component } = mountFixture('static');

  // The queueUpdate dispatcher is always emitted; what matters is that no
  // reactive targets or update lookups are generated for a stateless component.
  assert.doesNotMatch(source, /querySelector|data-wizz-id/);
  assert.doesNotMatch(source, /get \w+\(\) \{ return/);
  assert.equal(target.childNodes[0].name, 'article');
  const paragraph = findElement(target.childNodes[0], 'p');
  assert.equal(paragraph.childNodes[0].nodeValue, 'No state, no updates.');

  component.destroy();
  assert.deepEqual(target.childNodes, []);
});

test('invalid fixture fails with its file path and source location', () => {
  assert.throws(
    () => compile(loadFixture('invalid'), { filePath: fixturePath('invalid') }),
    (error) => error instanceof SyntaxError
      && error.filePath === 'test/fixtures/invalid.wizz'
      && /Expected <\/p>, found <\/main> at test\/fixtures\/invalid\.wizz:3:1\./.test(error.message)
  );
});

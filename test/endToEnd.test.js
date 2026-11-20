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

  assert.match(source, /count \+= 1; __wizzQueueUpdate\(\{ count: true \}\);/);

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

test('inline-handlers fixture updates the DOM from assignments in inline arrow handlers', async () => {
  const { source, target, component } = mountFixture('inline-handlers');

  assert.match(source, /\(event\) => \{ name = event\.target\.value; __wizzQueueUpdate\(\{ name: true \}\); \}/);
  const input = findElement(target, 'input');
  const button = findElement(target, 'button');
  const greeting = findElement(target, 'p');
  assert.equal(button.childNodes[1].nodeValue, '0');

  input.value = 'Ada';
  input.dispatchEvent('input');
  button.dispatchEvent('click');
  button.dispatchEvent('click');
  await flushUpdates();
  assert.equal(greeting.childNodes[1].nodeValue, 'Ada');
  assert.equal(button.childNodes[1].nodeValue, '2');
  assert.equal(input.value, 'Ada');

  // Destroy removes the instrumented listeners like any other.
  component.destroy();
  assert.deepEqual(input.listeners, {});
  assert.deepEqual(button.listeners, {});
});

test('expressions fixture re-renders conditionals, comparisons, and calls from state (issue #69)', async () => {
  const { source, target, component } = mountFixture('expressions');
  const main = target.childNodes[0];
  const add = findElement(target, 'button');
  const dismiss = findElement(target, 'a');
  const text = (name) => findElement(target, name).childNodes[0].nodeValue;

  // The expression source reaches the module verbatim.
  assert.match(source, /String\(entries\.length === 0 \? 'No entries yet' : entries\.length \+ ' ' \+ plural\(entries\.length\)\)/);
  assert.equal(main.attributes.class, 'entries is-empty');
  assert.equal(text('p'), 'No entries yet');
  assert.equal(text('span'), 'OK');
  assert.equal(text('em'), '0');

  add.dispatchEvent('click');
  await flushUpdates();
  assert.equal(main.attributes.class, 'entries');
  assert.equal(text('p'), '1 entry');
  assert.equal(text('em'), '-1.5');

  add.dispatchEvent('click');
  add.dispatchEvent('click');
  await flushUpdates();
  assert.equal(text('p'), '3 entries');
  assert.equal(text('span'), 'Over budget');

  // The branch's other dependency updates the same text.
  dismiss.dispatchEvent('click');
  await flushUpdates();
  assert.equal(text('span'), 'OK');
  assert.equal(text('em'), '-4.5');

  component.destroy();
  assert.deepEqual(add.listeners, {});
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
  // __wizzQueueUpdate calls into one batch, and every dependent expression updates.
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

  // The __wizzQueueUpdate dispatcher is always emitted; what matters is that no
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

test('bindings fixture: bind:value/bind:checked and parenthesized handlers update state both ways (issue #73)', async () => {
  const { source, target, component } = mountFixture('bindings');
  const [text, number, checkbox] = target.childNodes[0].childNodes.filter((node) => node.name === 'input');
  const select = findElement(target, 'select');
  const textarea = findElement(target, 'textarea');
  const button = findElement(target, 'button');
  const paragraph = findElement(target, 'p');
  const rendered = () => paragraph.childNodes.filter((node) => !node.name).map((node) => node.nodeValue).join('');

  // No bind: survives to the module, and the number guard is emitted.
  assert.doesNotMatch(source, /bind:/);
  assert.match(source, /function __wizzSetNumber\(node, value\)/);

  // State flows into the controls at mount.
  assert.equal(text.value, 'Ada');
  assert.equal(number.value, 250);
  assert.equal(checkbox.checked, false);
  assert.equal(select.value, 'lunch');
  assert.equal(rendered(), 'Ada|500|todo|lunch|');

  // Control edits flow into state and the rest of the DOM.
  text.value = 'Grace';
  text.dispatchEvent('input');
  number.value = '400';
  number.dispatchEvent('input');
  checkbox.checked = true;
  checkbox.dispatchEvent('change');
  select.value = 'dinner';
  select.dispatchEvent('change');
  textarea.value = 'tasty';
  textarea.dispatchEvent('input');
  await flushUpdates();
  assert.equal(rendered(), 'Grace|800|done|dinner|tasty');

  // A half-typed number reads as '' and is stored as null; the guard leaves
  // the field's text alone instead of writing '' back.
  number.value = '';
  number.dispatchEvent('input');
  await flushUpdates();
  assert.equal(rendered(), 'Grace|empty|done|dinner|tasty');

  // Script assignments flow back into the controls.
  button.dispatchEvent('click');
  await flushUpdates();
  assert.equal(text.value, '');
  assert.equal(number.value, 0);
  assert.equal(checkbox.checked, true);
  assert.equal(select.value, 'dinner');
  assert.equal(rendered(), '|0|done|dinner|tasty');

  component.destroy();
  assert.deepEqual(text.listeners, {});
  assert.deepEqual(checkbox.listeners, {});
  assert.deepEqual(textarea.listeners, {});
});

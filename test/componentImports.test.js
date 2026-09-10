const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { buildProject } = require('../build');

function createTemporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-component-import-test-'));
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, 'utf8');
}

function createDocument() {
  const elements = new Map();

  return {
    createElement(name) {
      return {
        childNodes: [],
        name,
        attributes: {},
        listeners: {},
        appendChild(node) { this.childNodes.push(node); },
        removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); },
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

test('builds and mounts an imported .wizz component with parent-owned teardown', async (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));

  const inputDirectory = path.join(projectDirectory, 'src');
  const outputDirectory = path.join(projectDirectory, 'dist');
  writeFile(
    path.join(inputDirectory, 'App.wizz'),
    "<script>import Counter from './components/Counter.wizz';</script><main><h1>Dashboard</h1><Counter /></main>"
  );
  writeFile(
    path.join(inputDirectory, 'components', 'Counter.wizz'),
    '<script>let count = 0;</script><button>Count: {count}</button>'
  );

  assert.deepEqual(
    buildProject(inputDirectory, outputDirectory, { log() {}, error() {} }),
    { compiledCount: 2, failedCount: 0 }
  );
  writeFile(path.join(outputDirectory, 'package.json'), '{"type":"module"}');

  const document = createDocument();
  const originalDocument = global.document;
  global.document = document;
  t.after(() => { global.document = originalDocument; });

  const module = await import(`${pathToFileURL(path.join(outputDirectory, 'App.js')).href}?test=${Date.now()}`);
  const target = document.createElement('div');
  const app = module.default(target);

  const main = target.childNodes[0];
  assert.equal(main.name, 'main');
  assert.equal(main.childNodes[0].name, 'h1');
  assert.equal(main.childNodes[1].name, 'button');
  assert.equal(main.childNodes[1].childNodes[1].nodeValue, '0');

  app.destroy();
  assert.deepEqual(target.childNodes, []);
});

test('keeps reactive updates within the imported component DOM subtree', async (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));

  const inputDirectory = path.join(projectDirectory, 'src');
  const outputDirectory = path.join(projectDirectory, 'dist');
  writeFile(
    path.join(inputDirectory, 'App.wizz'),
    `<script>import Counter from './components/Counter.wizz';\nlet name = 'friend';</script><main><h1>Hello {name}</h1><Counter /></main>`
  );
  writeFile(
    path.join(inputDirectory, 'components', 'Counter.wizz'),
    '<script>let count = 0; function increment() { count += 1; }</script><button on:click={increment}>Clicks: {count}</button>'
  );

  assert.deepEqual(
    buildProject(inputDirectory, outputDirectory, { log() {}, error() {} }),
    { compiledCount: 2, failedCount: 0 }
  );
  writeFile(path.join(outputDirectory, 'package.json'), '{"type":"module"}');

  const document = createDocument();
  const originalDocument = global.document;
  global.document = document;
  t.after(() => { global.document = originalDocument; });

  const module = await import(`${pathToFileURL(path.join(outputDirectory, 'App.js')).href}?test=${Date.now()}`);
  const target = document.createElement('div');
  const app = module.default(target);
  const main = target.childNodes[0];
  const heading = main.childNodes[0];
  const button = main.childNodes[1];

  button.dispatchEvent('click');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(heading.childNodes[1].nodeValue, 'friend');
  assert.equal(button.childNodes[1].nodeValue, '1');
  app.destroy();
});
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { buildProject } = require('../build');

function createTemporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-component-props-test-'));
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, 'utf8');
}

async function flushUpdates() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// A minimal DOM with the subset the generated modules use: element creation,
// tracked listeners for event-driven updates, and data-wizz-id lookups.
function createDocument() {
  const elements = new Map();

  return {
    createElement(name) {
      return {
        childNodes: [],
        name,
        listeners: {},
        appendChild(node) { this.childNodes.push(node); },
        insertBefore(node, referenceNode) {
          const existingIndex = this.childNodes.indexOf(node);
          if (existingIndex !== -1) this.childNodes.splice(existingIndex, 1);
          const referenceIndex = this.childNodes.indexOf(referenceNode);
          this.childNodes.splice(referenceIndex === -1 ? this.childNodes.length : referenceIndex, 0, node);
        },
        removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); },
        setAttribute(attributeName, value) {
          if (attributeName === 'data-wizz-id') {
            elements.set(`[data-wizz-id="${value}"]`, this);
          }
        },
        addEventListener(eventName, listener) { this.listeners[eventName] = listener; },
        removeEventListener(eventName, listener) {
          if (this.listeners[eventName] === listener) delete this.listeners[eventName];
        },
        dispatchEvent(eventName) { this.listeners[eventName]?.({ type: eventName, target: this }); }
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

async function buildAndMount(t, files, entry = 'App.wizz') {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));

  const inputDirectory = path.join(projectDirectory, 'src');
  const outputDirectory = path.join(projectDirectory, 'dist');
  for (const [relativePath, contents] of Object.entries(files)) {
    writeFile(path.join(inputDirectory, relativePath), contents);
  }

  assert.deepEqual(
    buildProject(inputDirectory, outputDirectory, { log() {}, error() {} }),
    { compiledCount: Object.keys(files).length, failedCount: 0 }
  );
  writeFile(path.join(outputDirectory, 'package.json'), '{"type":"module"}');

  const document = createDocument();
  const originalDocument = global.document;
  global.document = document;
  t.after(() => { global.document = originalDocument; });

  const module = await import(`${pathToFileURL(path.join(outputDirectory, entry.replace(/\.wizz$/, '.js'))).href}?test=${Date.now()}`);
  const target = document.createElement('div');
  const app = module.default(target);
  t.after(() => { try { app.destroy(); } catch { /* already destroyed by the test */ } });
  return { app, target };
}

const textOf = (node) => node.childNodes.map((child) => child.nodeValue).join('');

test('builds and mounts an imported component receiving static, dynamic, and boolean props', async (t) => {
  const { target } = await buildAndMount(t, {
    'App.wizz': [
      '<script>',
      "import Status from './components/Status.wizz';",
      'let level = 2;',
      'function promote() {',
      '  level = 3;',
      '}',
      '</script>',
      '<main><button on:click={promote}>Promote</button><Status level={level} rank="Lead" active /></main>'
    ].join('\n'),
    'components/Status.wizz': "<script>\nexport let level = 0;\nexport let rank = 'Member';\nexport let active = false;\n</script><p>Status {rank} at {level} active={active}</p>"
  });

  const main = target.childNodes[0];
  const paragraph = main.childNodes.find((node) => node.name === 'p');
  // The dynamic, static, and boolean props all reached the child.
  assert.equal(textOf(paragraph), 'Status Lead at 2 active=true');

  main.childNodes.find((node) => node.name === 'button').dispatchEvent('click');
  await flushUpdates();

  // The parent's state change propagated through setProps; the child rerendered.
  assert.equal(textOf(paragraph), 'Status Lead at 3 active=true');
});

test('uses declared defaults for missing props and undefined for undeclared ones', async (t) => {
  const { target } = await buildAndMount(t, {
    'App.wizz': "<script>\nimport Card from './components/Card.wizz';\n</script><main><Card title=\"Only title\" /></main>",
    'components/Card.wizz': "<script>\nexport let title = 'Untitled';\nexport let footnote;\n</script><p>{title}|{footnote}</p>"
  });

  assert.equal(textOf(target.childNodes[0].childNodes.find((node) => node.name === 'p')), 'Only title|undefined');
});

test('chains props through nested imported components', async (t) => {
  const { target } = await buildAndMount(t, {
    'App.wizz': "<script>\nimport Panel from './components/Panel.wizz';\nlet depth = 1;\n</script><main><Panel depth={depth} /></main>",
    'components/Panel.wizz': "<script>\nimport Row from './Row.wizz';\nexport let depth = 0;\n</script><section><Row incoming={depth} /></section>",
    'components/Row.wizz': "<script>\nexport let incoming = -1;\n</script><p>depth {incoming}</p>"
  });

  const main = target.childNodes[0];
  const section = main.childNodes.find((node) => node.name === 'section');
  const paragraph = section.childNodes.find((node) => node.name === 'p');
  assert.equal(textOf(paragraph), 'depth 1');
});

test('preserves child identity across parent updates and cascades teardown', async (t) => {
  const { app, target } = await buildAndMount(t, {
    'App.wizz': [
      '<script>',
      "import Tick from './components/Tick.wizz';",
      'let count = 0;',
      'function bump() {',
      '  count = count + 1;',
      '}',
      '</script>',
      '<main><button on:click={bump}>Bump</button><Tick value={count} /></main>'
    ].join('\n'),
    'components/Tick.wizz': "<script>\nexport let value = 0;\n</script><p>{value}</p>"
  });

  const main = target.childNodes[0];
  const paragraphBefore = main.childNodes.find((node) => node.name === 'p');
  assert.equal(textOf(paragraphBefore), '0');

  main.childNodes.find((node) => node.name === 'button').dispatchEvent('click');
  await flushUpdates();

  // Same paragraph node object: the child updated in place, it was not remounted.
  const paragraphAfter = main.childNodes.find((node) => node.name === 'p');
  assert.equal(paragraphAfter, paragraphBefore);
  assert.equal(textOf(paragraphAfter), '1');

  // Parent teardown cascades into the child and removes the whole tree.
  app.destroy();
  assert.deepEqual(target.childNodes, []);
});

test('propagates reactive props to a child that never rerenders on its own', async (t) => {
  const { target } = await buildAndMount(t, {
    'App.wizz': [
      '<script>',
      "import Meter from './components/Meter.wizz';",
      'let percent = 10;',
      'function drain() {',
      '  percent = 90;',
      '}',
      '</script>',
      '<main><button on:click={drain}>Drain</button><Meter percent={percent} /></main>'
    ].join('\n'),
    // The child has no script state of its own beyond the prop.
    'components/Meter.wizz': "<script>\nexport let percent = 0;\n</script><p>{percent}%</p>"
  });

  const main = target.childNodes[0];
  assert.equal(textOf(main.childNodes.find((node) => node.name === 'p')), '10%');

  main.childNodes.find((node) => node.name === 'button').dispatchEvent('click');
  await flushUpdates();
  assert.equal(textOf(main.childNodes.find((node) => node.name === 'p')), '90%');
});

test('rejects invalid prop syntax during the build with the file path', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));

  const inputDirectory = path.join(projectDirectory, 'src');
  const outputDirectory = path.join(projectDirectory, 'dist');
  writeFile(path.join(inputDirectory, 'App.wizz'), '<main>OK</main>');
  writeFile(
    path.join(inputDirectory, 'pages', 'Broken.wizz'),
    "<script>export const name = 'x';</script><p>{name}</p>"
  );

  const errors = [];
  const result = buildProject(inputDirectory, outputDirectory, { log() {}, error(message) { errors.push(message); } });

  assert.equal(result.failedCount, 1);
  assert.equal(
    errors.some((message) => message.includes('pages/Broken.wizz') && /Unsupported export syntax/.test(message)),
    true
  );
});

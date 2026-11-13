const assert = require('node:assert/strict');
const test = require('node:test');
const { assignNodeIds } = require('../analyzer/idAssigner');
const { analyzeDependencies } = require('../analyzer/dependencyAnalyzer');
const { parseComponent } = require('../parser');
const { generateComponent } = require('./componentGenerator');
const { VERSIONS } = require('../version');

async function flushUpdates() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// Extends the standard shim with the document.head surface the head
// machinery uses: markers, owned-node queries, and move-or-insert.
function createHeadDocument() {
  const document = createDocument();
  document.head = {
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
      const existingIndex = this.childNodes.indexOf(node);
      if (existingIndex !== -1) this.childNodes.splice(existingIndex, 1);
      const referenceIndex = referenceNode == null
        ? this.childNodes.length
        : this.childNodes.indexOf(referenceNode);
      this.childNodes.splice(referenceIndex === -1 ? this.childNodes.length : referenceIndex, 0, node);
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
  };
  return document;
}

function createHeadTarget() {
  return {
    childNodes: [],
    appendChild(node) {
      this.childNodes.push(node);
    },
    removeChild(node) {
      this.childNodes.splice(this.childNodes.indexOf(node), 1);
    }
  };
}

function createDocument() {
  const elements = new Map();

  return {
    createElement(name) {
      return {
        name,
        nodeName: name.toUpperCase(),
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
        appendChild(node) {
          this.childNodes.push(node);
        },
        insertBefore(node, referenceNode) {
          const existingIndex = this.childNodes.indexOf(node);
          if (existingIndex !== -1) this.childNodes.splice(existingIndex, 1);
          const referenceIndex = this.childNodes.indexOf(referenceNode);
          this.childNodes.splice(referenceIndex === -1 ? this.childNodes.length : referenceIndex, 0, node);
        },
        removeChild(node) {
          this.childNodes.splice(this.childNodes.indexOf(node), 1);
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

test('generates a mountable module from formatted component source', () => {
  const payload = assignNodeIds(analyzeDependencies(parseComponent(`
    <script>let count = 0;</script>
    <main><h1>Count: {count}</h1></main>
  `)));
  const source = generateComponent(payload);
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

  const component = mountComponent(target);

  assert.equal(target.childNodes.length, 1);
  assert.equal(target.childNodes[0].name, 'main');
  assert.equal(target.childNodes[0].childNodes[0].name, 'h1');
  assert.equal(target.childNodes[0].childNodes[0].childNodes[1].nodeValue, '0');

  component.destroy();
  assert.deepEqual(target.childNodes, []);
});

test('emits an ES module default export and creates framework context getters', () => {
  const payload = assignNodeIds(analyzeDependencies(parseComponent(
    '<script>let count = 0; const title = "Total";</script><p>{count}</p>'
  )));
  const source = generateComponent(payload);

  assert.match(source, /^export default function mountComponent\(__wizzHost, __wizzProps = \{\}, __wizzAnchor = null\)/m);
  assert.match(source, /get count\(\) \{ return count; \}/);
  assert.doesNotMatch(source, /get title\(\)/);
});

test('stamps the version header as the first line of every generated module', () => {
  const generate = (template) => generateComponent(assignNodeIds(analyzeDependencies(parseComponent(template))));

  for (const source of [
    generate('<main><p>Static</p></main>'),
    generate("<script>import Counter from './Counter.wizz';</script><main><Counter /></main>")
  ]) {
    const header = source.split('\n')[0];
    const match = header.match(
      /^\/\/ Generated by Wizz (\d+\.\d+\.\d+) \(component syntax (\d+\.\d+\.\d+), generated output (\d+\.\d+\.\d+)\)\. Edits will be overwritten\.$/
    );

    assert.notEqual(match, null, `expected a version header, got: ${header}`);
    assert.equal(match[1], VERSIONS.compiler);
    assert.equal(match[2], VERSIONS.syntax);
    assert.equal(match[3], VERSIONS.output);
    assert.equal(source.split('\n').filter((line) => line.includes('Generated by Wizz')).length, 1);
  }
});

test('generated modules keep the output contract surface pinned to output 1.9.0 (syntax 1.4.2)', () => {
  // This is the concrete meaning of VERSIONS.output within its major version:
  // the module surface and teardown behavior generated modules guarantee.
  // Breaking any assertion here requires bumping VERSIONS.output and the
  // compiler major version, never a silent codegen change.
  const payload = assignNodeIds(analyzeDependencies(parseComponent(
    '<script>let count = 0;</script><main><p>{count}</p></main>'
  )));
  const source = generateComponent(payload);

  assert.match(source, /export default function mountComponent\(__wizzHost, __wizzProps = \{\}, __wizzAnchor = null\) \{/);
  // Components without declared props expose no setProps member.
  assert.doesNotMatch(source, /setProps/);
  assert.match(source, /return \{\n    destroy\(\) \{/);
  assert.match(source, /__wizzHost\.removeChild\(__wizzRoot\);/);
  assert.match(source, /\.__wizzChildComponents = __wizzChildren;/);
  assert.match(source, /\.__wizzMountChildren = \(\) => __wizzChildMounts\.forEach\(\(mount\) => mount\(\)\);/);
  assert.match(source, /\.__wizzListUpdates = __wizzLists;/);
});

test('renders non-reactive constant expressions during creation', () => {
  const payload = assignNodeIds(analyzeDependencies(parseComponent(
    '<script>const title = "Total";</script><p>{title}</p>'
  )));
  const source = generateComponent(payload);
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

  mountComponent(target);

  assert.equal(target.childNodes[0].childNodes[0].nodeValue, 'Total');
});

test('intercepts reactive mutations in the emitted component script', () => {
  const payload = assignNodeIds(analyzeDependencies(parseComponent(
    '<script>let count = 0; function increment() { count += 1; }</script><p>{count}</p>'
  )));
  const source = generateComponent(payload);

  assert.match(source, /count \+= 1; __wizzQueueUpdate\(\{ count: true \}\);/);
});

test('does not update before component initialization is complete', () => {
  const payload = assignNodeIds(analyzeDependencies(parseComponent(
    '<script>let name = null; if (!name) { name = "Alice"; }</script><p>{name}</p>'
  )));
  const source = generateComponent(payload);
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

  assert.doesNotThrow(() => mountComponent(target));
  assert.equal(target.childNodes[0].childNodes[0].nodeValue, 'Alice');
});

test('binds explicit event directives to component-local handlers', async () => {
  const payload = assignNodeIds(analyzeDependencies(parseComponent(
    '<script>let clicks = 0; function increment() { clicks++; }</script><button on:click={increment}>Clicks: {clicks}</button>'
  )));
  const source = generateComponent(payload);
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

  mountComponent(target);
  const button = target.childNodes[0];
  button.dispatchEvent('click');
  await flushUpdates();

  assert.equal(button.attributes['on:click'], undefined);
  assert.equal(button.childNodes[1].nodeValue, '1');
});

test('updates dynamic attributes and properties when reactive state changes', async () => {
  const payload = assignNodeIds(analyzeDependencies(parseComponent(
    '<script>let name = "Ada"; let selected = 1; function applyChanges() { name = "Grace"; selected = 0; }</script><input value={name} checked={selected} aria-label={name} on:click={applyChanges} />'
  )));
  const source = generateComponent(payload);
  const document = createDocument();
  const target = {
    childNodes: [],
    appendChild(node) { this.childNodes.push(node); },
    removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); }
  };
  const mountComponent = new Function('document', `${source.replace('export default ', '')}\nreturn mountComponent;`)(document);
  mountComponent(target);

  const input = target.childNodes[0];
  assert.equal(input.value, 'Ada');
  assert.equal(input.checked, 1);
  assert.equal(input.attributes['aria-label'], 'Ada');
  input.dispatchEvent('click');
  await flushUpdates();
  assert.equal(input.value, 'Grace');
  assert.equal(input.checked, 0);
  assert.equal(input.attributes['aria-label'], 'Grace');
});

test('renders the selected conditional branch during mounting', () => {
  const payload = assignNodeIds(analyzeDependencies(parseComponent(
    "<script>const section = 'About';</script><main>{#if section === 'About'}<p>Shown</p>{:else}<p>Hidden</p>{/if}</main>"
  )));
  const source = generateComponent(payload);
  const document = createDocument();
  const target = { childNodes: [], appendChild(node) { this.childNodes.push(node); }, removeChild() {} };
  const mountComponent = new Function('document', `${source.replace('export default ', '')}\nreturn mountComponent;`)(document);
  mountComponent(target);
  assert.equal(target.childNodes[0].childNodes[0].childNodes[0].nodeValue, 'Shown');
});

test('reconciles keyed each blocks by moving retained nodes and removing deleted nodes', async () => {
  const payload = assignNodeIds(analyzeDependencies(parseComponent(`
    <script>
      let items = [{ id: 1, name: 'Ada' }, { id: 2, name: 'Grace' }];
      function reorder() { items = [{ id: 2, name: 'Grace Hopper' }, { id: 1, name: 'Ada' }]; }
      function removeFirst() { items = [{ id: 1, name: 'Ada' }]; }
    </script>
    <main><button on:click={reorder}>Reorder</button><button on:click={removeFirst}>Remove</button><ul>{#each items as item (item.id)}<li>{item.name}</li>{/each}</ul></main>
  `)));
  const source = generateComponent(payload);
  const document = createDocument();
  const target = { childNodes: [], appendChild(node) { this.childNodes.push(node); }, removeChild() {} };
  const mountComponent = new Function('document', `${source.replace('export default ', '')}\nreturn mountComponent;`)(document);
  mountComponent(target);

  const main = target.childNodes[0];
  const list = main.childNodes[2];
  const firstItem = list.childNodes[0];
  const secondItem = list.childNodes[1];
  main.childNodes[0].dispatchEvent('click');
  await flushUpdates();

  assert.strictEqual(list.childNodes[0], secondItem);
  assert.strictEqual(list.childNodes[1], firstItem);
  assert.equal(list.childNodes[0].childNodes[0].nodeValue, 'Grace Hopper');
  main.childNodes[1].dispatchEvent('click');
  await flushUpdates();
  assert.deepEqual(list.childNodes.filter((node) => node.name === 'li'), [firstItem]);
});

test('rejects duplicate each block keys during mounting', () => {
  const payload = assignNodeIds(analyzeDependencies(parseComponent(
    "<script>let items = [{ id: 1 }, { id: 1 }];</script><ul>{#each items as item (item.id)}<li>{item.id}</li>{/each}</ul>"
  )));
  const source = generateComponent(payload);
  const document = createDocument();
  const target = { appendChild() {} };
  const mountComponent = new Function('document', `${source.replace('export default ', '')}\nreturn mountComponent;`)(document);

  assert.throws(() => mountComponent(target), /Each block keys must be unique\./);
});

test('renders keyless each blocks over primitive collections and updates them positionally', async () => {
  const payload = assignNodeIds(analyzeDependencies(parseComponent(
    "<script>let list = ['one', 'two']; function rename() { list = ['uno', 'dos', 'tres']; } function shrink() { list = ['only']; }</script><main><button on:click={rename}>Rename</button><button on:click={shrink}>Shrink</button><ul>{#each list as item}<li>{item}</li>{/each}</ul></main>"
  )));
  const source = generateComponent(payload);
  const document = createDocument();
  const target = { childNodes: [], appendChild(node) { this.childNodes.push(node); }, removeChild() {} };
  const mountComponent = new Function('document', `${source.replace('export default ', '')}\nreturn mountComponent;`)(document);
  mountComponent(target);

  const list = target.childNodes[0].childNodes[2];
  const items = () => list.childNodes.filter((node) => node.name === 'li');
  const firstItem = items()[0];
  const secondItem = items()[1];

  assert.deepEqual(items().map((li) => li.childNodes[0].nodeValue), ['one', 'two']);

  target.childNodes[0].childNodes[0].dispatchEvent('click');
  await flushUpdates();
  assert.strictEqual(items()[0], firstItem);
  assert.strictEqual(items()[1], secondItem);
  assert.deepEqual(items().map((li) => li.childNodes[0].nodeValue), ['uno', 'dos', 'tres']);

  target.childNodes[0].childNodes[1].dispatchEvent('click');
  await flushUpdates();
  assert.strictEqual(items()[0], firstItem);
  assert.deepEqual(items().map((li) => li.childNodes[0].nodeValue), ['only']);
});

test('rejects each block bodies with multiple root elements', () => {
  const payload = assignNodeIds(analyzeDependencies(parseComponent(
    '<script>const items = [1, 2];</script><ul>{#each items as item}<li>{item}</li><li>extra</li>{/each}</ul>'
  )));

  assert.throws(() => generateComponent(payload), /Each blocks must contain exactly one root element\./);
});

test('batches multiple assignments in one event into a single scheduled update with merged flags', async () => {
  const payload = assignNodeIds(analyzeDependencies(parseComponent(
    '<script>let a = 1; let b = 2; function set() { a = 3; b = 4; }</script><main><p>{a}</p><p>{b}</p><button on:click={set}>Set</button></main>'
  )));
  const source = generateComponent(payload);
  const document = createDocument();
  const target = { childNodes: [], appendChild(node) { this.childNodes.push(node); }, removeChild() {} };
  const scheduled = [];
  const mountComponent = new Function(
    'document',
    'queueMicrotask',
    `${source.replace('export default ', '')}\nreturn mountComponent;`
  )(document, (callback) => scheduled.push(callback));
  mountComponent(target);

  const main = target.childNodes[0];
  main.childNodes[2].dispatchEvent('click');

  assert.equal(scheduled.length, 1);
  scheduled[0]();
  assert.equal(main.childNodes[0].childNodes[0].nodeValue, '3');
  assert.equal(main.childNodes[1].childNodes[0].nodeValue, '4');
});

test('defers DOM updates until the scheduled batch runs', async () => {
  const payload = assignNodeIds(analyzeDependencies(parseComponent(
    '<script>let count = 0; function increment() { count += 1; }</script><main><p>{count}</p><button on:click={increment}>Inc</button></main>'
  )));
  const source = generateComponent(payload);
  const document = createDocument();
  const target = { childNodes: [], appendChild(node) { this.childNodes.push(node); }, removeChild() {} };
  const mountComponent = new Function('document', `${source.replace('export default ', '')}\nreturn mountComponent;`)(document);
  mountComponent(target);

  const main = target.childNodes[0];
  main.childNodes[1].dispatchEvent('click');

  assert.equal(main.childNodes[0].childNodes[0].nodeValue, '0');
  await flushUpdates();
  assert.equal(main.childNodes[0].childNodes[0].nodeValue, '1');
});

test('destroy cancels a pending scheduled update', async () => {
  const payload = assignNodeIds(analyzeDependencies(parseComponent(
    '<script>let count = 0; function increment() { count += 1; }</script><main><button on:click={increment}>Clicks: {count}</button></main>'
  )));
  const source = generateComponent(payload);
  const document = createDocument();
  const target = { childNodes: [], appendChild(node) { this.childNodes.push(node); }, removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); } };
  const mountComponent = new Function('document', `${source.replace('export default ', '')}\nreturn mountComponent;`)(document);
  const component = mountComponent(target);

  const button = document.querySelector('[data-wizz-id="1"]');
  button.dispatchEvent('click');
  component.destroy();
  await flushUpdates();

  assert.deepEqual(target.childNodes, []);
  assert.equal(button.childNodes[1].nodeValue, '0');
});

test('emits lifecycle hook registration machinery', () => {
  const payload = assignNodeIds(analyzeDependencies(parseComponent(
    '<script>function init() {} onMount(init); function bye() {} onDestroy(bye);</script><main><p>Total</p></main>'
  )));
  const source = generateComponent(payload);

  assert.match(source, /function onMount\(hook\) \{ __wizzMountHooks\.push\(hook\); \}/);
  assert.match(source, /function onDestroy\(hook\) \{ __wizzDestroyHooks\.push\(hook\); \}/);
  assert.match(source, /__wizzMounted = true;\n  __wizzMountHooks\.forEach\(\(hook\) => hook\(\)\);/);
  assert.match(source, /__wizzDestroyed = true;\n      __wizzDestroyHooks\.forEach\(\(hook\) => hook\(\)\);/);
});

test('runs mount hooks after mounting with the DOM attached and reactive state available', async () => {
  const payload = assignNodeIds(analyzeDependencies(parseComponent(
    '<script>export let probe; let status = "created"; function first() { probe("mountLog"); } function initialize() { status = "mounted"; } onMount(first); onMount(initialize);</script><main><p>{status}</p></main>'
  )));
  const source = generateComponent(payload);
  const document = createDocument();
  const target = { childNodes: [], appendChild(node) { this.childNodes.push(node); }, removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); } };
  const mountComponent = new Function('document', `${source.replace('export default ', '')}\nreturn mountComponent;`)(document);
  mountComponent(target, { probe: (key) => { target[key] = target.childNodes.length; } });

  assert.equal(target.mountLog, 1);
  assert.equal(target.childNodes[0].childNodes[0].childNodes[0].nodeValue, 'created');
  await flushUpdates();
  assert.equal(target.childNodes[0].childNodes[0].childNodes[0].nodeValue, 'mounted');
});

test('intercepts state mutations inside inline arrow callbacks passed to hooks', async () => {
  const payload = assignNodeIds(analyzeDependencies(parseComponent(
    '<script>let status = "created"; onMount(() => { status = "ready"; });</script><main><p>{status}</p></main>'
  )));
  const source = generateComponent(payload);
  const document = createDocument();
  const target = { childNodes: [], appendChild(node) { this.childNodes.push(node); }, removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); } };
  const mountComponent = new Function('document', `${source.replace('export default ', '')}\nreturn mountComponent;`)(document);
  mountComponent(target);

  assert.equal(target.childNodes[0].childNodes[0].childNodes[0].nodeValue, 'created');
  await flushUpdates();
  assert.equal(target.childNodes[0].childNodes[0].childNodes[0].nodeValue, 'ready');
});

test('runs destroy hooks before teardown and ignores their scheduled updates', async () => {
  const payload = assignNodeIds(analyzeDependencies(parseComponent(
    '<script>export let probe; let count = 0; function teardown() { probe("destroyLog"); count += 1; } onDestroy(teardown);</script><main><button>Clicks: {count}</button></main>'
  )));
  const source = generateComponent(payload);
  const document = createDocument();
  const target = { childNodes: [], appendChild(node) { this.childNodes.push(node); }, removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); } };
  const mountComponent = new Function('document', `${source.replace('export default ', '')}\nreturn mountComponent;`)(document);
  const component = mountComponent(target, { probe: (key) => { target[key] = target.childNodes.length; } });
  const button = document.querySelector('[data-wizz-id="1"]');

  component.destroy();

  assert.equal(target.destroyLog, 1);
  assert.deepEqual(target.childNodes, []);
  await flushUpdates();
  assert.equal(button.childNodes[1].nodeValue, '0');
});

test('removes tracked event listeners when the component is destroyed', async () => {
  const payload = assignNodeIds(analyzeDependencies(parseComponent(
    '<script>let count = 0; function increment() { count += 1; }</script><main><button on:click={increment}>Clicks: {count}</button></main>'
  )));
  const source = generateComponent(payload);
  const document = createDocument();
  const target = { childNodes: [], appendChild(node) { this.childNodes.push(node); }, removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); } };
  const mountComponent = new Function('document', `${source.replace('export default ', '')}\nreturn mountComponent;`)(document);
  const component = mountComponent(target);
  const button = document.querySelector('[data-wizz-id="1"]');

  button.dispatchEvent('click');
  await flushUpdates();
  assert.equal(button.childNodes[1].nodeValue, '1');
  assert.notEqual(button.listeners.click, undefined);

  component.destroy();
  assert.equal(button.listeners.click, undefined);

  button.dispatchEvent('click');
  await flushUpdates();
  assert.equal(button.childNodes[1].nodeValue, '1');
});

test('allows formatting whitespace around an each block root element', () => {
  const payload = assignNodeIds(analyzeDependencies(parseComponent(
    "<script>let items = [{ id: 1, name: 'Ada' }];</script><ul>\n  {#each items as item (item.id)}\n    <li>{item.name}</li>\n  {/each}\n</ul>"
  )));

  assert.doesNotThrow(() => generateComponent(payload));
});

test('emits top-level component imports and mounts imported self-closing components', () => {
  const payload = assignNodeIds(analyzeDependencies(parseComponent(
    "<script>import Counter from './Counter.wizz';</script><main><Counter /></main>"
  )));
  const source = generateComponent(payload);

  assert.match(source, /^import Counter from "\.\/Counter\.js";/m);
  assert.match(source, /__wizzChildren\.push\(Counter\(__wizzNode_1, \{\}, __wizzNode_\d+\)\);/);
  assert.match(
    source,
    /__wizzHost\.appendChild\(__wizzRoot\);\n  __wizzRoot\.__wizzMountChildren\(\);\n  __wizzUpdate\(__wizzCtx, \{  \}\);/
  );
  assert.match(source, /__wizzChildren\.forEach\(\(component\) => component\.destroy\(\)\);/);
  assert.doesNotMatch(source, /document\.createElement\("Counter"\)/);
});

test('passes component tag attributes as props and still rejects children and root-level tags', () => {
  const generate = (template) => generateComponent(assignNodeIds(analyzeDependencies(parseComponent(template))));

  const source = generate("<script>import Counter from './Counter.wizz';</script><main><Counter label=\"Count\" /></main>");
  assert.match(source, /__wizzChildren\.push\(Counter\(__wizzNode_1, \{ "label": "Count" \}, __wizzNode_\d+\)\);/);
  assert.throws(
    () => generate("<script>import Counter from './Counter.wizz';</script><main><Counter>ignored</Counter></main>"),
    /Component <Counter> does not support children\./
  );
  assert.throws(
    () => generate("<script>import Counter from './Counter.wizz';</script><Counter />"),
    /Component <Counter> must be nested inside an element\./
  );
  assert.throws(
    () => generate("<script>import Counter from './Counter.wizz';</script><main><Counter on:click={handle} /></main>"),
    /Event directive 'on:click' is not supported on component <Counter>/
  );
});
test('emits prop bindings, the props parameter, and a setProps member for prop components', () => {
  const source = generateComponent(assignNodeIds(analyzeDependencies(parseComponent(
    "<script>export let name = 'Guest'; export let count;</script><p>{name} {count}</p>"
  ))));

  assert.match(source, /export default function mountComponent\(__wizzHost, __wizzProps = \{\}, __wizzAnchor = null\) \{/);
  assert.match(source, /let name = __wizzProps\.name !== undefined \? __wizzProps\.name : \('Guest'\);/);
  assert.match(source, /let count = __wizzProps\.count;/);
  assert.match(source, /setProps\(__wizzIncoming\) \{/);
  assert.match(source, /if \(!Object\.is\(name, __wizzNext\)\) \{/);
  assert.match(source, /if \(!Object\.is\(count, __wizzIncoming\.count\)\) \{/);
});

test('rejects statement-level mutation of props with a located read-only error', () => {
  const generate = (script) => () => generateComponent(assignNodeIds(analyzeDependencies(parseComponent(
    `<script>export let name = 'Guest'; ${script}</script><p>{name}</p>`
  ))));

  assert.throws(generate('name = "Ada";'), /Props are read-only: 'name' cannot be assigned inside the component at 1:\d+\./);
  assert.throws(generate('name++;'), /Props are read-only/);
  assert.throws(generate('name += "!";'), /Props are read-only/);
  assert.throws(generate('name.first = "Ada";'), /Props are read-only/);
});

test('rejects prop mutation inside inline on: handlers with the read-only code', () => {
  const generate = (handler) => () => generateComponent(assignNodeIds(analyzeDependencies(parseComponent(
    `<script>export let name = 'Guest';</script><button on:click={${handler}}>{name}</button>`
  ))));

  for (const handler of ['() => name = "Ada"', '() => name++', '(e) => { name += e; }', 'function () { name.first = 1; }']) {
    assert.throws(generate(handler), (error) => {
      assert.equal(error.code, 'WIZZ-G015');
      assert.match(error.message, /Props are read-only: 'name' cannot be assigned in the 'on:click' handler\./);
      return true;
    }, handler);
  }
  // A parameter that shadows the prop is local, and calls are not mutations.
  assert.doesNotThrow(generate('(name) => name = 1'));
  assert.doesNotThrow(generate('(e) => notify(name)'));
});

test('instruments inline handler mutations in both branches of an if block', () => {
  const source = generateComponent(assignNodeIds(analyzeDependencies(parseComponent(
    '<script>let a = 1; let b = 1;</script><main>{#if a === 1}<button on:click={() => a = 2}>x</button>{:else}<button on:click={() => b = 2}>y</button>{/if}</main>'
  ))));
  assert.match(source, /\(\) => \{ a = 2; __wizzQueueUpdate\(\{ a: true \}\); \}/);
  assert.match(source, /\(\) => \{ b = 2; __wizzQueueUpdate\(\{ b: true \}\); \}/);
});

test('inline handlers write persistent state and leave non-mutating handlers untouched', () => {
  const source = generateComponent(assignNodeIds(analyzeDependencies(parseComponent(
    "<script>let clicks = persist('clicks', 0); function go() {}</script><main><button on:click={() => clicks += 1}>{clicks}</button><button on:click={(e) => go(e)}>go</button></main>"
  ))));
  assert.match(source, /\(\) => \{ clicks \+= 1; __wizzQueueUpdate\(\{ clicks: true \}\); __wizzPersistWrite\("clicks", clicks\); \}/);
  assert.match(source, /__wizzListen\(__wizzNode_\d+, "click", \(e\) => go\(e\)\);/);
});

test('allows shadowed prop names inside functions and blocks', () => {
  const generate = (script) => generateComponent(assignNodeIds(analyzeDependencies(parseComponent(
    `<script>export let name = 'Guest'; ${script}</script><p>{name}</p>`
  ))));

  assert.doesNotThrow(() => generate('function rename(name) { name = "local"; }'));
  assert.doesNotThrow(() => generate('{ let name = "local"; name = "other"; }'));
});

test('renders with parent props, defaults, and missing-prop behavior at mount', () => {
  const source = generateComponent(assignNodeIds(analyzeDependencies(parseComponent(
    "<script>export let name = 'Guest'; export let count;</script><p>{name}:{count}</p>"
  ))));
  const mount = (props) => {
    const document = createDocument();
    const target = { childNodes: [], appendChild(node) { this.childNodes.push(node); }, removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); } };
    const mountComponent = new Function('document', `${source.replace('export default ', '')}\nreturn mountComponent;`)(document);
    const component = mountComponent(target, props);
    return { component, text: () => target.childNodes[0].childNodes.map((node) => node.nodeValue).join('') };
  };

  assert.equal(mount({ name: 'Ada', count: 3 }).text(), 'Ada:3');
  // Missing props fall back to defaults; a prop without a default is undefined.
  assert.equal(mount({}).text(), 'Guest:undefined');
  assert.equal(mount().text(), 'Guest:undefined');
});

test('rerenders when setProps delivers changed values and deduplicates identical values', async () => {
  const source = generateComponent(assignNodeIds(analyzeDependencies(parseComponent(
    "<script>export let count = 0;</script><p>{count}</p>"
  ))));
  const document = createDocument();
  const target = { childNodes: [], appendChild(node) { this.childNodes.push(node); }, removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); } };
  const mountComponent = new Function('document', `${source.replace('export default ', '')}\nreturn mountComponent;`)(document);
  const component = mountComponent(target, { count: 1 });
  const paragraph = target.childNodes[0];

  component.setProps({ count: 5 });
  await flushUpdates();
  assert.equal(paragraph.childNodes[0].nodeValue, '5');

  // Identical values must not schedule a child update.
  const before = paragraph.childNodes[0].nodeValue;
  component.setProps({ count: 5 });
  await flushUpdates();
  assert.equal(paragraph.childNodes[0].nodeValue, before);

  // Unknown props are ignored; a destroyed child ignores late prop updates.
  assert.doesNotThrow(() => component.setProps({ undeclared: 1 }));
  component.destroy();
  assert.doesNotThrow(() => component.setProps({ count: 99 }));
  await flushUpdates();
  assert.equal(paragraph.childNodes[0].nodeValue, '5');
});

test('re-applies declared defaults when setProps receives undefined', async () => {
  const source = generateComponent(assignNodeIds(analyzeDependencies(parseComponent(
    "<script>export let name = 'Guest';</script><p>{name}</p>"
  ))));
  const document = createDocument();
  const target = { childNodes: [], appendChild(node) { this.childNodes.push(node); }, removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); } };
  const mountComponent = new Function('document', `${source.replace('export default ', '')}\nreturn mountComponent;`)(document);
  const component = mountComponent(target, { name: 'Ada' });

  component.setProps({ name: undefined });
  await flushUpdates();
  assert.equal(target.childNodes[0].childNodes[0].nodeValue, 'Guest');
});

test('does not expose setProps on components without declared props', () => {
  const source = generateComponent(assignNodeIds(analyzeDependencies(parseComponent(
    '<script>let count = 0;</script><p>{count}</p>'
  ))));

  assert.doesNotMatch(source, /setProps/);
});

test('delivers updates for a prop whose name collides with generated local names', async () => {
  // Regression: the setProps accumulator once shadowed a prop named `value`,
  // silently making Object.is compare the shadow to itself.
  const source = generateComponent(assignNodeIds(analyzeDependencies(parseComponent(
    '<script>export let value = 0;</script><p>{value}</p>'
  ))));
  const document = createDocument();
  const target = { childNodes: [], appendChild(node) { this.childNodes.push(node); }, removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); } };
  const mountComponent = new Function('document', `${source.replace('export default ', '')}\nreturn mountComponent;`)(document);
  const component = mountComponent(target, { value: 1 });

  component.setProps({ value: 2 });
  await flushUpdates();
  assert.equal(target.childNodes[0].childNodes[0].nodeValue, '2');
});

test('rejects prop names using the reserved __wizz framework prefix', () => {
  assert.throws(
    () => generateComponent(assignNodeIds(analyzeDependencies(parseComponent(
      '<script>export let __wizzNext = 1;</script><p>{__wizzNext}</p>'
    )))),
    /reserved '__wizz' framework prefix/
  );
});

test('emits factory-scope component references and guarded setProps calls for reactive parent props', () => {
  const source = generateComponent(assignNodeIds(analyzeDependencies(parseComponent(
    "<script>\nimport Counter from './Counter.wizz';\nlet start = 0;\n</script><main><Counter start={start} label=\"Total\" /></main>"
  ))));

  assert.match(source, /let __wizzComponent_1 = null;/);
  assert.match(source, /__wizzComponent_1 = Counter\(__wizzNode_1, \{ "start": start, "label": "Total" \}, __wizzNode_\d+\);/);
  assert.match(source, /if \(__wizzChanged\.start\) \{\n      if \(__wizzComponent_1\) __wizzComponent_1\.setProps\(\{ "start": start \}\);\n    \}/);
});

test('keeps child component identity across parent prop updates', async () => {
  const counterSource = generateComponent(assignNodeIds(analyzeDependencies(parseComponent(
    '<script>export let start = 0;</script><p>{start}</p>'
  ))));
  const parentSource = generateComponent(assignNodeIds(analyzeDependencies(parseComponent(
    "<script>\nimport Counter from './Counter.wizz';\nlet start = 1;\nfunction bump() {\n  start = 2;\n}\n</script><main><button on:click={bump}>Bump</button><Counter start={start} /></main>"
  ))));

  const document = createDocument();
  const counterMount = new Function('document', `${counterSource.replace('export default ', '')}\nreturn mountComponent;`)(document);
  const mountedChildren = [];
  const target = {
    childNodes: [],
    appendChild(node) { this.childNodes.push(node); },
    removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); }
  };
  const mountComponent = new Function(
    'document',
    'Counter',
    `${parentSource.replace(/^import .*$/m, '').replace('export default ', '')}\nreturn mountComponent;`
  )(document, (target_, props) => {
    const instance = counterMount(target_, props);
    mountedChildren.push(instance);
    return instance;
  });
  const parent = mountComponent(target);
  const main = target.childNodes[0];
  const paragraphBeforeUpdate = main.childNodes.find((node) => node.name === 'p');

  assert.equal(paragraphBeforeUpdate.childNodes[0].nodeValue, '1');

  const button = main.childNodes.find((node) => node.name === 'button');
  button.dispatchEvent('click');
  await flushUpdates();

  // The child paragraph is the same node object: updated in place, not remounted.
  const paragraphAfterUpdate = main.childNodes.find((node) => node.name === 'p');
  assert.equal(paragraphAfterUpdate, paragraphBeforeUpdate);
  assert.equal(paragraphAfterUpdate.childNodes[0].nodeValue, '2');
  assert.equal(mountedChildren.length, 1);

  // The parent-owned teardown cascade destroys the child instance.
  parent.destroy();
  assert.deepEqual(target.childNodes, []);
});

test('declares update targets only when a template has reactive content', () => {
  const generate = (source) => generateComponent(assignNodeIds(analyzeDependencies(parseComponent(source))));

  assert.doesNotMatch(generate('<main><p>static</p></main>'), /__wizzTarget/);
  assert.match(generate('<script>let count = 0;</script><main><p>{count}</p></main>'), /^\s*let __wizzTarget_1;$/m);
});

test('pins the complete default output byte-for-byte for a fixed fixture', () => {
  // Defense in depth beyond the regex pins: the default (non-hydratable)
  // emission must not drift when new targets or options are added. Any
  // intentional change updates this pin and VERSIONS.output together.
  const payload = assignNodeIds(analyzeDependencies(parseComponent(
    '<script>let count = 0;</script><main><p>static</p><p>{count}</p></main>'
  )));
  assert.equal(generateComponent(payload), "// Generated by Wizz 1.21.0 (component syntax 1.4.3, generated output 1.11.0). Edits will be overwritten.\n\nexport default function mountComponent(__wizzHost, __wizzProps = {}, __wizzAnchor = null) {\n  let __wizzMounted = false;\n  let __wizzDestroyed = false;\n  let __wizzBatched = false;\n  let __wizzPending = {};\n  const __wizzMountHooks = [];\n  const __wizzDestroyHooks = [];\n  function onMount(hook) { __wizzMountHooks.push(hook); }\n  function onDestroy(hook) { __wizzDestroyHooks.push(hook); }\n  const __wizzListeners = [];\n  function __wizzListen(node, eventName, handler) {\n    node.addEventListener(eventName, handler);\n    __wizzListeners.push({ node, eventName, handler });\n  }\n  function __wizzQueueUpdate(__wizzChanged) {\n    if (!__wizzMounted) return;\n    __wizzPending = { ...__wizzPending, ...__wizzChanged };\n    if (__wizzBatched) return;\n    __wizzBatched = true;\n    queueMicrotask(() => {\n      __wizzBatched = false;\n      const __wizzBatch = __wizzPending;\n      __wizzPending = {};\n      if (__wizzDestroyed) return;\n      __wizzUpdate(__wizzCtx, __wizzBatch);\n    });\n  }\n  // --- Developer Logic ---\n  let count = 0;\n  \n// --- Framework Context ---\n  const __wizzCtx = {\n    get count() { return count; },\n  };\n  \n// --- DOM Creation ---\n  let __wizzTarget_1;\n  \n  function __wizzCreate(__wizzCtx) {\n    const __wizzChildren = [];\n    const __wizzChildMounts = [];\n    const __wizzLists = [];\n    const __wizzNode_1 = document.createElement(\"main\");\n    const __wizzNode_2 = document.createElement(\"p\");\n    __wizzNode_1.appendChild(__wizzNode_2);\n    const __wizzNode_3 = document.createTextNode(\"static\");\n    __wizzNode_2.appendChild(__wizzNode_3);\n    const __wizzNode_4 = document.createElement(\"p\");\n    __wizzNode_4.setAttribute(\"data-wizz-id\", \"1\");\n    __wizzNode_1.appendChild(__wizzNode_4);\n    const __wizzNode_5 = document.createTextNode(String(count));\n    __wizzTarget_1 = __wizzNode_5;\n    __wizzNode_4.appendChild(__wizzNode_5);\n    __wizzNode_1.__wizzChildComponents = __wizzChildren;\n    __wizzNode_1.__wizzMountChildren = () => __wizzChildMounts.forEach((mount) => mount());\n    __wizzNode_1.__wizzListUpdates = __wizzLists;\n    return __wizzNode_1;\n  }\n  \n// --- Reactivity Engine ---\n  function __wizzUpdate(__wizzCtx, __wizzChanged) {\n    if (__wizzChanged.count) {\n      __wizzTarget_1.nodeValue = String(count);\n    }\n  }\n  \n// --- Initialization ---\n  const __wizzRoot = __wizzCreate(__wizzCtx);\n  const __wizzChildren = __wizzRoot.__wizzChildComponents;\n  const __wizzLists = __wizzRoot.__wizzListUpdates;\n  if (__wizzAnchor) __wizzHost.insertBefore(__wizzRoot, __wizzAnchor); else __wizzHost.appendChild(__wizzRoot);\n  __wizzRoot.__wizzMountChildren();\n  __wizzUpdate(__wizzCtx, { count: true });\n  __wizzMounted = true;\n  __wizzMountHooks.forEach((hook) => hook());\n  \nreturn {\n    destroy() {\n      __wizzDestroyed = true;\n      __wizzDestroyHooks.forEach((hook) => hook());\n      __wizzChildren.forEach((component) => component.destroy());\n      __wizzListeners.forEach(({ node, eventName, handler }) => node.removeEventListener(eventName, handler));\n      __wizzHost.removeChild(__wizzRoot);\n    }\n  };\n}");
});

test('hydratable compiles export both mount entries through one __wizzMountInstance', () => {
  const payload = assignNodeIds(analyzeDependencies(parseComponent(
    '<script>let count = 0; function go() {}</script><main><p>{count}</p><button on:click={go}>x</button></main>'
  )));
  const source = generateComponent(payload, { hydratable: true });

  assert.match(source, /export default function mountComponent\(__wizzHost, __wizzProps = \{\}, __wizzAnchor = null\) \{\n  return __wizzMountInstance\(__wizzHost, __wizzProps, __wizzAnchor, false, null, false\);\n\}/);
  assert.match(source, /export function hydrateComponent\(__wizzHost, __wizzProps = \{\}, __wizzState = null\) \{\n  return __wizzMountInstance\(__wizzHost, __wizzProps, null, true, __wizzState, false\);\n\}/);
  // The nested adoption entry adopts the given node as the component root, so
  // a mismatch remounts inside it and never detaches the parent's tree.
  assert.match(source, /export function hydrateRoot\(__wizzRoot, __wizzProps = \{\}, __wizzState = null\)/);
  assert.match(source, /return __wizzMountInstance\(__wizzRoot, __wizzProps, null, true, __wizzState, true\);/);
  assert.match(source, /function __wizzMountInstance\(__wizzHost, __wizzProps, __wizzAnchor, __wizzHydrating, __wizzState, __wizzAdoptSelf\) \{/);
  assert.match(source, /function __wizzHydrateCreate\(__wizzHost, __wizzState, __wizzAdoptSelf\) \{/);
  assert.match(source, /const __wizzAdopted = __wizzHydrating \? __wizzHydrateCreate\(__wizzHost, __wizzState, __wizzAdoptSelf\) : null;/);
  assert.match(source, /if \(__wizzHydrating && !__wizzAdopted\) return __wizzMountInstance\(__wizzHost, __wizzProps, null, false, null, false\);/);
  assert.match(source, /const __wizzRoot = __wizzHydrating \? __wizzAdopted\.node : __wizzCreate\(__wizzCtx\);/);
  // Hydration collects listeners and attaches them only after the walk passes.
  assert.match(source, /__wizzPendingListeners\.forEach\(\(pending\) => __wizzListen\(pending\[0\], pending\[1\], pending\[2\]\)\);/);
  // A self-adopted root belongs to the parent's tree; teardown leaves it.
  assert.match(source, /if \(!__wizzHydrating \|\| !__wizzAdoptSelf\) __wizzHost\.removeChild\(__wizzRoot\);/);
});

test('default compiles never emit the hydration surface', () => {
  const payload = assignNodeIds(analyzeDependencies(parseComponent('<script>let count = 0;</script><main><p>{count}</p></main>')));
  const source = generateComponent(payload);

  assert.doesNotMatch(source, /hydrateComponent|__wizzHydrateCreate|__wizzMountInstance/);
});

test('hydratable compiles seed non-prop reactive state from the serialized snapshot', () => {
  const payload = assignNodeIds(analyzeDependencies(parseComponent(
    '<script>export let label = "x"; let count = 0;</script><p>{label}{count}</p>'
  )));
  const source = generateComponent(payload, { hydratable: true });

  assert.match(source, /if \(__wizzHydrating && __wizzState && typeof __wizzState === 'object' && !Array\.isArray\(__wizzState\)\) \{/);
  assert.match(source, /if \(Object\.prototype\.hasOwnProperty\.call\(__wizzState, "count"\)\) count = __wizzState\["count"\];/);
  assert.doesNotMatch(source, /hasOwnProperty\.call\(__wizzState, "label"\)/);
});

test('hydratable compiles reject the server-renderable boundary', () => {
  assert.throws(
    () => generateComponent(assignNodeIds(analyzeDependencies(parseComponent(
      '<script>import Counter from "./Counter.wizz";</script><main><Counter/></main>'
    ))), { hydratable: true }),
    /Server rendering does not support component tags/
  );
  // Blocks and each lists hydrate since nested hydration; a vouched component
  // import clears the gate and pulls in the child's hydratable module.
  const payload = assignNodeIds(analyzeDependencies(parseComponent(
    '<script>\nimport Counter from "./Counter.wizz";\n</script><main><Counter /></main>'
  )));
  const source = generateComponent(payload, {
    hydratable: true,
    componentServerRenderable: { Counter: true }
  });
  assert.match(source, /import \* as __wizzHydrate_Counter from "\.\/Counter\.hydrate\.js";/);
  // An import that is never rendered must not drag in a hydratable module.
  const unusedPayload = assignNodeIds(analyzeDependencies(parseComponent(
    '<script>\nimport Counter from "./Counter.wizz";\n</script><main><p>static</p></main>'
  )));
  const unusedSource = generateComponent(unusedPayload, {
    hydratable: true,
    componentServerRenderable: { Counter: true }
  });
  assert.doesNotMatch(unusedSource, /__wizzHydrate_Counter/);
});

test('applies head nodes ahead of existing head content on fresh mount and releases them on destroy', () => {
  const payload = assignNodeIds(analyzeDependencies(parseComponent(
    '<wizz:head><title>Home</title><meta name="viewport" content="width=device-width"></wizz:head><main><p>Hi</p></main>'
  )));
  const source = generateComponent(payload);
  const document = createHeadDocument();
  const target = createHeadTarget();
  const mountComponent = new Function('document', `${source.replace('export default ', '')}\nreturn mountComponent;`)(document);

  const shellTitle = document.createElement('title');
  shellTitle.textContent = 'Shell';
  document.head.appendChild(shellTitle);

  const component = mountComponent(target);

  // Nodes are prepended, so the wizz title sits ahead of the shell's static
  // title — the one document.title reads.
  assert.deepEqual(document.head.childNodes.map((node) => node.nodeName), ['META', 'TITLE', 'TITLE']);
  const title = document.head.childNodes[1];
  assert.equal(title.textContent, 'Home');
  assert.equal(title.attributes['data-wizz-loc'], '1:12');
  assert.ok(title.attributes['data-wizz-head'], 'the applied run is tagged with the owning instance');
  assert.equal(document.head.childNodes[0].attributes.name, 'viewport');
  assert.equal(document.head.childNodes[0].attributes.content, 'width=device-width');

  component.destroy();
  // Released nodes are removed; the shell title survives untouched.
  assert.deepEqual(document.head.childNodes.map((node) => node.nodeName), ['TITLE']);
  assert.equal(document.head.childNodes[0], shellTitle);
});

test('evaluates head expressions at mount time', () => {
  const payload = assignNodeIds(analyzeDependencies(parseComponent(
    '<script>\nlet pageTitle = "Docs";\nlet depth = "wide";\n</script><wizz:head><title>Wizz — {pageTitle}</title><meta name="audience" content={depth}></wizz:head><main><p>Hi</p></main>'
  )));
  const source = generateComponent(payload);
  const document = createHeadDocument();
  const mountComponent = new Function('document', `${source.replace('export default ', '')}\nreturn mountComponent;`)(document);

  mountComponent(createHeadTarget());

  const title = document.head.childNodes.find((node) => node.nodeName === 'TITLE');
  assert.equal(title.textContent, 'Wizz — Docs');
  const meta = document.head.childNodes.find((node) => node.nodeName === 'META');
  assert.equal(meta.attributes.content, 'wide');
});

test('warns once naming both locations when a second mounted head declares a title', () => {
  const compileMount = (componentSource) => new Function('document',
    `${generateComponent(assignNodeIds(analyzeDependencies(parseComponent(componentSource)))).replace('export default ', '')}\nreturn mountComponent;`);

  const document = createHeadDocument();
  const first = compileMount('<wizz:head><title>First</title></wizz:head><main><p>a</p></main>')(document);
  const second = compileMount('<wizz:head>\n  <title>Second</title>\n</wizz:head><main><p>b</p></main>')(document);

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  const firstInstance = first(createHeadTarget());
  const secondInstance = second(createHeadTarget());

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Multiple <title> declarations/);
  assert.match(warnings[0], /1:12/);
  assert.match(warnings[0], /2:3/);
  // Both titles stay mounted while both instances live; the most recent one
  // is the first title element, which is what document.title reads.
  const titles = document.head.childNodes.filter((node) => node.nodeName === 'TITLE');
  assert.deepEqual(titles.map((node) => node.textContent), ['Second', 'First']);

  // Releasing the second instance lets the first's title win again.
  secondInstance.destroy();
  assert.deepEqual(
    document.head.childNodes.filter((node) => node.nodeName === 'TITLE').map((node) => node.textContent),
    ['First']
  );
});

test('ignores event directives on head nodes', () => {
  const payload = assignNodeIds(analyzeDependencies(parseComponent(
    '<script>function go() {}</script><wizz:head><meta on:click={go} name="x"></wizz:head><main><p>Hi</p></main>'
  )));
  const source = generateComponent(payload);
  const document = createHeadDocument();
  const mountComponent = new Function('document', `${source.replace('export default ', '')}\nreturn mountComponent;`)(document);

  mountComponent(createHeadTarget());

  const meta = document.head.childNodes.find((node) => node.nodeName === 'META');
  assert.ok(meta, 'the head node itself is still created');
  assert.deepEqual(meta.listeners, {}, 'head nodes never receive event listeners');
});

test('head-free component-free modules emit no head machinery', () => {
  const plain = generateComponent(assignNodeIds(analyzeDependencies(parseComponent('<main><p>Hi</p></main>'))));
  assert.doesNotMatch(plain, /__wizzApplyHead/);
  assert.doesNotMatch(plain, /__wizzHeadOwnerSeq/);
  assert.doesNotMatch(plain, /headNodes/);
  assert.doesNotMatch(plain, /__wizzMountInstance\(__wizzHost, __wizzProps, __wizzAnchor, __wizzHydrating, __wizzState, __wizzAdoptSelf, __wizzOwnerPath\)/);

  const hydratableHeadless = generateComponent(
    assignNodeIds(analyzeDependencies(parseComponent('<main><p>Hi</p></main>'))),
    { hydratable: true }
  );
  assert.doesNotMatch(hydratableHeadless, /__wizzApplyHead/);
  assert.doesNotMatch(hydratableHeadless, /__wizzHydrateCreate\(__wizzHost, __wizzState, __wizzAdoptSelf, __wizzOwnerPath\)/);
});

test('styled components mount one scoped stylesheet and stamp data-wizz-s markup', () => {
  const payload = assignNodeIds(analyzeDependencies(parseComponent(
    '<main><h2>Title</h2></main><wizz:style>h2 { font-size: 30px }</wizz:style>'
  )));
  const source = generateComponent(payload);
  const document = createHeadDocument();
  const target = createHeadTarget();
  const mountComponent = new Function('document', `${source.replace('export default ', '')}\nreturn mountComponent;`)(document);

  assert.ok(source.includes('__wizzCreateStyle'), 'the style factory is emitted');
  const component = mountComponent(target);

  const styles = document.head.childNodes.filter((node) => node.nodeName === 'STYLE');
  assert.equal(styles.length, 1);
  const style = styles[0];
  assert.match(style.attributes['data-wizz-style'], /^s[0-9a-z]+$/);
  assert.equal(style.attributes['data-wizz-loc'], '1:28');
  assert.equal(style.attributes['data-wizz-refs'], '1');
  assert.ok(style.attributes['data-wizz-head'], 'the applied style is tagged with the owning instance');
  assert.equal(style.textContent, `h2[data-wizz-s="${style.attributes['data-wizz-style']}"] { font-size: 30px }`);
  // Every rendered element carries the scope attribute.
  const root = target.childNodes[0];
  assert.equal(root.attributes['data-wizz-s'], style.attributes['data-wizz-style']);
  assert.equal(root.childNodes[0].attributes['data-wizz-s'], style.attributes['data-wizz-style']);

  component.destroy();
  assert.equal(document.head.childNodes.filter((node) => node.nodeName === 'STYLE').length, 0);
});

test('two instances of one styled component share a refcounted stylesheet', () => {
  const source = generateComponent(assignNodeIds(analyzeDependencies(parseComponent(
    '<main><h2>Title</h2></main><wizz:style>h2 { font-size: 30px }</wizz:style>'
  ))));
  const document = createHeadDocument();
  const mountComponent = new Function('document', `${source.replace('export default ', '')}\nreturn mountComponent;`)(document);

  const first = mountComponent(createHeadTarget());
  const second = mountComponent(createHeadTarget());

  const styles = document.head.childNodes.filter((node) => node.nodeName === 'STYLE');
  assert.equal(styles.length, 1, 'the stylesheet is injected exactly once');
  assert.equal(styles[0].attributes['data-wizz-refs'], '2');

  first.destroy();
  assert.equal(styles[0].attributes['data-wizz-refs'], '1');
  assert.equal(document.head.childNodes.filter((node) => node.nodeName === 'STYLE').length, 1);

  second.destroy();
  assert.equal(document.head.childNodes.filter((node) => node.nodeName === 'STYLE').length, 0);
});

test('different styled components keep distinct stylesheets', () => {
  const compile = (componentSource) => new Function('document',
    `${generateComponent(assignNodeIds(analyzeDependencies(parseComponent(componentSource)))).replace('export default ', '')}\nreturn mountComponent;`);
  const document = createHeadDocument();

  const first = compile('<main><h2>A</h2></main><wizz:style>h2 { font-size: 30px }</wizz:style>')(document)(createHeadTarget());
  const second = compile('<main><h2>B</h2></main><wizz:style>h2 { font-size: 24px }</wizz:style>')(document)(createHeadTarget());

  const styles = document.head.childNodes.filter((node) => node.nodeName === 'STYLE');
  assert.equal(styles.length, 2);
  assert.notEqual(styles[0].attributes['data-wizz-style'], styles[1].attributes['data-wizz-style']);
  // Insertion prepends, so head order is newest-first; match by content.
  const bySize = styles.map((style) => (style.textContent.includes('30px') ? 'big' : 'small')).sort();
  assert.deepEqual(bySize, ['big', 'small']);
});

test('unstyled components emit no style machinery or scope attributes', () => {
  const payload = assignNodeIds(analyzeDependencies(parseComponent(
    '<main><h2>Title</h2></main>'
  )));
  const source = generateComponent(payload);
  const document = createHeadDocument();
  const target = createHeadTarget();
  const mountComponent = new Function('document', `${source.replace('export default ', '')}\nreturn mountComponent;`)(document);

  assert.ok(!source.includes('__wizzCreateStyle'));
  assert.ok(!source.includes('data-wizz-style'));
  mountComponent(target);
  const root = target.childNodes[0];
  assert.ok(!('data-wizz-s' in root.attributes));
  assert.equal(document.head.childNodes.filter((node) => node.nodeName === 'STYLE').length, 0);
});

test('extractedStyles drops the injection but keeps the scope attributes', () => {
  const source = '<main><h2>Title</h2></main><wizz:style>h2 { font-size: 30px }</wizz:style>';
  const payload = assignNodeIds(analyzeDependencies(parseComponent(source)));
  const generated = generateComponent(payload, { extractedStyles: true });
  const document = createHeadDocument();
  const target = createHeadTarget();
  const mountComponent = new Function('document', `${generated.replace('export default ', '')}\nreturn mountComponent;`)(document);

  assert.ok(!generated.includes('font-size'));
  assert.ok(!generated.includes('__wizzCreateStyle'));
  assert.ok(!generated.includes('__wizzApplyHead'), 'a style-only component needs no head machinery');

  const component = mountComponent(target);
  const root = target.childNodes[0];
  assert.equal(root.attributes['data-wizz-s'], payload.style.scope);
  assert.equal(root.childNodes[0].attributes['data-wizz-s'], payload.style.scope);
  assert.equal(document.head.childNodes.filter((node) => node.nodeName === 'STYLE').length, 0);
  component.destroy();
  assert.equal(target.childNodes.length, 0);
});

test('extractedStyles leaves a component\'s own head block working', () => {
  const payload = assignNodeIds(analyzeDependencies(parseComponent(
    '<main><h2>T</h2></main><wizz:head><title>Page</title></wizz:head><wizz:style>h2 { color: red }</wizz:style>'
  )));
  const generated = generateComponent(payload, { extractedStyles: true });
  const document = createHeadDocument();
  const mountComponent = new Function('document', `${generated.replace('export default ', '')}\nreturn mountComponent;`)(document);

  const component = mountComponent(createHeadTarget());
  assert.deepEqual(document.head.childNodes.map((node) => node.nodeName), ['TITLE']);
  component.destroy();
  assert.equal(document.head.childNodes.length, 0);
});

test('extractedStyles only matches true: other truthy values keep the injection', () => {
  const payload = assignNodeIds(analyzeDependencies(parseComponent(
    '<main></main><wizz:style>main { color: red }</wizz:style>'
  )));
  assert.ok(generateComponent(payload, { extractedStyles: 'yes' }).includes('__wizzCreateStyle'));
});

test('extractedStyles is byte-identical for a component with no style block', () => {
  const payload = assignNodeIds(analyzeDependencies(parseComponent('<main><p>Hi</p></main>')));
  assert.equal(generateComponent(payload, { extractedStyles: true }), generateComponent(payload));
});

// --- Persistent state (milestone 17) ---

// Installs fake persistence globals the way a browser would provide them, and
// resets the shared state bus so tests never see each other's subscriptions.
// BroadcastChannel is always replaced: Node ships a real one (v18+) whose
// channel keeps the test process alive, and tests must control delivery.
function installPersistenceGlobals({ storage, BroadcastChannel = function FakeBroadcastChannel() { return { onmessage: null, postMessage() {}, close() {} }; } } = {}) {
  const saved = {
    localStorage: globalThis.localStorage,
    BroadcastChannel: globalThis.BroadcastChannel,
    __wizzStateBus: globalThis.__wizzStateBus
  };
  if (storage !== undefined) globalThis.localStorage = storage;
  if (BroadcastChannel !== undefined) globalThis.BroadcastChannel = BroadcastChannel;
  delete globalThis.__wizzStateBus;
  return () => {
    if (saved.localStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = saved.localStorage;
    if (saved.BroadcastChannel === undefined) delete globalThis.BroadcastChannel;
    else globalThis.BroadcastChannel = saved.BroadcastChannel;
    if (saved.__wizzStateBus === undefined) delete globalThis.__wizzStateBus;
    else globalThis.__wizzStateBus = saved.__wizzStateBus;
  };
}

function createMapStorage(initial = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    getItem(key) { return entries.has(key) ? entries.get(key) : null; },
    setItem(key, value) { entries.set(key, String(value)); },
    removeItem(key) { entries.delete(key); },
    clear() { entries.clear(); }
  };
}

const THEME_COMPONENT = `
    <script>
      let theme = persist('theme', 'light');
      function toggle() { theme = theme === 'light' ? 'dark' : 'light'; }
    </script>
    <main><p>{theme}</p><button on:click={toggle}>Toggle</button></main>
  `;

// The rendered root: <main><p>{theme}</p><button on:click={toggle}>…</button></main>
function mountTheme(source, document) {
  const target = { childNodes: [], appendChild(node) { this.childNodes.push(node); }, removeChild() {} };
  const mountComponent = new Function('document', `${source.replace('export default ', '')}\nreturn mountComponent;`)(document);
  const component = mountComponent(target);
  const main = target.childNodes[0];
  return {
    component,
    text: () => main.childNodes[0].childNodes[0].nodeValue,
    toggle: () => main.childNodes[1].dispatchEvent('click')
  };
}

test('emits persistence helpers, read initializers, and subscription machinery for persistent vars', () => {
  const source = generateComponent(assignNodeIds(analyzeDependencies(parseComponent(THEME_COMPONENT))));

  assert.match(source, /function __wizzStateBus\(\)/);
  assert.match(source, /function __wizzPersistRead\(key, fallback\)/);
  assert.match(source, /function __wizzPersistWrite\(key, value\)/);
  assert.match(source, /function __wizzPersistSubscribe\(key, callback\)/);
  assert.match(source, /let theme = __wizzPersistRead\("theme", \('light'\)\);/);
  assert.match(source, /theme = theme === 'light' \? 'dark' : 'light'; __wizzQueueUpdate\(\{ theme: true \}\); __wizzPersistWrite\("theme", theme\);/);
  assert.match(source, /__wizzPersistUnsubscribe\.push\(__wizzPersistSubscribe\("theme", \(__wizzValue\) => \{/);
  assert.match(source, /if \(Object\.is\(__wizzValue, theme\)\) return;\n    theme = __wizzValue;\n    __wizzQueueUpdate\(\{ theme: true \}\);/);
  assert.match(source, /__wizzDestroyHooks\.push\(\(\) => \{ for \(const __wizzStop of __wizzPersistUnsubscribe\) __wizzStop\(\); \}\);/);
});

test('persist-free components emit no persistence machinery', () => {
  const source = generateComponent(assignNodeIds(analyzeDependencies(parseComponent(
    '<script>let count = 0;</script><p>{count}</p>'
  ))));

  assert.doesNotMatch(source, /__wizzPersist/);
  assert.doesNotMatch(source, /__wizzStateBus/);
  // The byte-for-byte output pin for a persist-free component lives in the
  // "pins the complete default output" test; it is the full-output guarantee.
});

test('mounts persistent components from storage and writes mutations back', async () => {
  const restore = installPersistenceGlobals({
    storage: createMapStorage({ theme: '"dark"' })
  });
  try {
    const source = generateComponent(assignNodeIds(analyzeDependencies(parseComponent(THEME_COMPONENT))));
    const mounted = mountTheme(source, createDocument());

    assert.equal(mounted.text(), 'dark', 'the stored value wins over the default');

    mounted.toggle();
    await flushUpdates();
    assert.equal(mounted.text(), 'light');
    assert.equal(globalThis.localStorage.getItem('theme'), '"light"', 'the mutation is written back to storage');

    mounted.component.destroy();
  } finally {
    restore();
  }
});

test('converges two instances sharing one key without echoing the write back', async () => {
  const restore = installPersistenceGlobals({ storage: createMapStorage() });
  try {
    const source = generateComponent(assignNodeIds(analyzeDependencies(parseComponent(THEME_COMPONENT))));
    const document = createDocument();
    const first = mountTheme(source, document);
    const second = mountTheme(source, document);

    assert.equal(first.text(), 'light');
    assert.equal(second.text(), 'light');

    // One instance toggles; the other receives the same-tab delivery and
    // updates. The writer ignores its own echo via the Object.is guard.
    first.toggle();
    await flushUpdates();

    assert.equal(first.text(), 'dark');
    assert.equal(second.text(), 'dark', 'both instances converged on the written value');

    first.component.destroy();
    second.component.destroy();
    assert.equal(globalThis.__wizzStateBus.bindings.size, 0, 'destroy unregisters every subscription');
  } finally {
    restore();
  }
});

test('a destroyed instance stops receiving updates for its keys', async () => {
  const restore = installPersistenceGlobals({ storage: createMapStorage() });
  try {
    const source = generateComponent(assignNodeIds(analyzeDependencies(parseComponent(THEME_COMPONENT))));
    const document = createDocument();
    const first = mountTheme(source, document);
    const second = mountTheme(source, document);

    first.component.destroy();
    // The surviving instance toggles; the destroyed one must not react.
    second.toggle();
    await flushUpdates();

    assert.equal(first.text(), 'light', 'the destroyed instance kept its last rendered value');
    assert.equal(second.text(), 'dark');

    second.component.destroy();
  } finally {
    restore();
  }
});

test('survives a failing or absent storage without losing in-memory updates', async () => {
  const throwingStorage = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('quota exceeded'); }
  };
  const restore = installPersistenceGlobals({ storage: throwingStorage });
  try {
    const source = generateComponent(assignNodeIds(analyzeDependencies(parseComponent(THEME_COMPONENT))));
    const mounted = mountTheme(source, createDocument());

    assert.doesNotThrow(() => mounted);
    assert.equal(mounted.text(), 'light', 'unreadable storage falls back to the default');

    mounted.toggle();
    await flushUpdates();
    assert.equal(mounted.text(), 'dark', 'in-memory state still updates');

    mounted.component.destroy();
  } finally {
    restore();
  }
});

test('hydratable compiles seed persistent vars for the walk and restore storage afterwards', () => {
  const source = generateComponent(assignNodeIds(analyzeDependencies(parseComponent(
    "<script>let clicks = 0; let theme = persist('theme', 'light');</script><p>{clicks}{theme}</p>"
  ))), { hydratable: true });

  assert.match(source, /if \(Object\.prototype\.hasOwnProperty\.call\(__wizzState, "clicks"\)\) clicks = __wizzState\["clicks"\];/);
  assert.match(source, /if \(Object\.prototype\.hasOwnProperty\.call\(__wizzState, "theme"\)\) theme = __wizzState\["theme"\];/);
  assert.match(source, /const __wizzPersistHydration = \{ theme: theme \};/);

  // Ordering contract: the storage-read values are captured before the
  // snapshot seeding overwrites them, the adoption walk runs against the
  // seeded (server-rendered) values, and the restore lands after the walk
  // returns but before the initial update pass syncs the adopted markup to
  // the persisted value.
  const capture = source.indexOf('const __wizzPersistHydration = {');
  const seeding = source.indexOf('hasOwnProperty.call(__wizzState, "theme")');
  const walkCall = source.indexOf('const __wizzAdopted = __wizzHydrating ? __wizzHydrateCreate');
  const restore = source.indexOf('theme = __wizzPersistHydration.theme;');
  const initialUpdate = source.indexOf('__wizzUpdate(__wizzCtx, {');
  assert.ok(capture !== -1 && seeding > capture, 'the storage capture precedes the snapshot seeding');
  assert.ok(walkCall !== -1 && restore > walkCall, 'the restore runs after the adoption walk returns');
  assert.ok(restore !== -1 && restore < initialUpdate, 'the restore precedes the initial update pass');
});

test('plain client compiles emit no hydration capture for persistent vars', () => {
  const source = generateComponent(assignNodeIds(analyzeDependencies(parseComponent(
    "<script>let theme = persist('theme', 'light');</script><p>{theme}</p>"
  ))));

  assert.doesNotMatch(source, /__wizzPersistHydration/);
});

// --- Dynamic boolean attributes (issue #72) ---

function mountSource(componentSource) {
  const source = generateComponent(assignNodeIds(analyzeDependencies(parseComponent(componentSource))));
  const document = createDocument();
  const target = {
    childNodes: [],
    appendChild(node) { this.childNodes.push(node); },
    removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); }
  };
  const mountComponent = new Function('document', `${source.replace('export default ', '')}\nreturn mountComponent;`)(document);
  const component = mountComponent(target);
  return { source, target, component };
}

test('a falsy dynamic boolean attribute is absent on mount and toggles with state', async () => {
  const { target } = mountSource(
    '<script>let isValid = false; let tip = null; let expanded = false; function flip() { isValid = !isValid; tip = isValid ? "ok" : undefined; expanded = isValid; }</script>'
    + '<form on:submit={flip}><p hidden={isValid} title={tip} aria-expanded={expanded}>Please enter a food name.</p><input required={isValid} readonly={0} /></form>'
  );
  const form = target.childNodes[0];
  const [paragraph, input] = form.childNodes.filter((node) => node.name);

  assert.equal('hidden' in paragraph.attributes, false, 'hidden={false} must not hide');
  assert.equal('title' in paragraph.attributes, false, 'null removes a plain attribute');
  assert.equal(paragraph.attributes['aria-expanded'], 'false', 'aria-* keeps the string "false"');
  assert.equal('required' in input.attributes, false);
  assert.equal('readonly' in input.attributes, false, 'any falsy value removes a boolean attribute');

  form.dispatchEvent('submit');
  await flushUpdates();
  assert.equal(paragraph.attributes.hidden, '');
  assert.equal(paragraph.attributes.title, 'ok');
  assert.equal(paragraph.attributes['aria-expanded'], 'true');
  assert.equal(input.attributes.required, '');

  form.dispatchEvent('submit');
  await flushUpdates();
  assert.equal('hidden' in paragraph.attributes, false);
  assert.equal('title' in paragraph.attributes, false, 'undefined removes a plain attribute');
  assert.equal(paragraph.attributes['aria-expanded'], 'false');
  assert.equal('required' in input.attributes, false);
});

test('boolean attributes inside an if branch toggle without touching an untaken branch', async () => {
  const { target } = mountSource(
    '<script>let shown = true; let open = false; function toggle() { open = !open; }</script>'
    + '<main on:click={toggle}>{#if shown}<details open={open}><summary>More</summary></details>{:else}<p hidden={open}>x</p>{/if}</main>'
  );
  const main = target.childNodes[0];
  const details = main.childNodes.find((node) => node.name === 'details');
  assert.equal('open' in details.attributes, false);
  main.dispatchEvent('click');
  await flushUpdates();
  assert.equal(details.attributes.open, '');
  main.dispatchEvent('click');
  await flushUpdates();
  assert.equal('open' in details.attributes, false);
});

test('each item boolean and nullable attributes follow the policy on create and update', async () => {
  const { target } = mountSource(
    "<script>let rows = [{ id: 1, done: true, note: null }, { id: 2, done: false, note: 'n' }]; function swap() { rows = [{ id: 1, done: false, note: 'm' }, { id: 2, done: true, note: undefined }]; }</script>"
    + '<ul on:click={swap}>{#each rows as row (row.id)}<li hidden={row.done} title={row.note}>{row.id}</li>{/each}</ul>'
  );
  const list = target.childNodes[0];
  const items = () => list.childNodes.filter((node) => node.name === 'li');

  assert.deepEqual(items().map((li) => [li.attributes.hidden ?? null, li.attributes.title ?? null]), [['', null], [null, 'n']]);
  list.dispatchEvent('click');
  await flushUpdates();
  assert.deepEqual(items().map((li) => [li.attributes.hidden ?? null, li.attributes.title ?? null]), [[null, 'm'], ['', null]]);
});

test('emits the attribute helper only when a native element has a helper-written dynamic attribute', () => {
  const generate = (componentSource) => generateComponent(assignNodeIds(analyzeDependencies(parseComponent(componentSource))));
  const helperDefinitions = (source) => (source.match(/function __wizzAttr\(/g) || []).length;

  assert.equal(helperDefinitions(generate('<p class="a">Hi</p>')), 0);
  assert.equal(helperDefinitions(generate('<script>let n = 1;</script><p>{n}</p>')), 0);
  assert.equal(helperDefinitions(generate('<script>let v = "";</script><input value={v} checked={v} disabled={v} />')), 0);
  assert.equal(helperDefinitions(generate('<script>function go() {}</script><button on:click={go}>Go</button>')), 0);
  assert.equal(helperDefinitions(generate("<script>\nimport Card from './Card.wizz';\nlet t = 'x';\n</script><main><Card title={t} /></main>")), 0);

  const withHidden = generate('<script>let a = false;</script><p hidden={a}>x</p>');
  assert.equal(helperDefinitions(withHidden), 1);
  // Emitted once at module scope, ahead of the factory.
  assert.ok(withHidden.indexOf('function __wizzAttr(') < withHidden.indexOf('export default function mountComponent('));
  assert.match(withHidden, /__wizzAttr\(__wizz\w+, "hidden", a, 1\);/);
  assert.doesNotMatch(withHidden, /setAttribute\("hidden", String/);
  assert.doesNotMatch(withHidden, /innerHTML/);

  assert.equal(helperDefinitions(generate('<script>let rows = [];</script><ul>{#each rows as r}<li title={r}>x</li>{/each}</ul>')), 1);
});

test('head nodes apply the attribute policy, including for checked/disabled names', () => {
  const source = generateComponent(assignNodeIds(analyzeDependencies(parseComponent(
    '<script>let robots = undefined; let off = false;</script><wizz:head><meta name="robots" content={robots}><link rel="alternate" disabled={off}></wizz:head><main>x</main>'
  ))));
  assert.match(source, /function __wizzAttr\(/);
  assert.match(source, /__wizzAttr\(\w+, "content", robots\);/);
  assert.match(source, /__wizzAttr\(\w+, "disabled", off, 1\);/);
  assert.doesNotMatch(source, /\.disabled = off/);
});

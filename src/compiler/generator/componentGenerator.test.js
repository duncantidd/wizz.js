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

  assert.match(source, /^export default function mountComponent\(target, props = \{\}\)/m);
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

test('generated modules keep the output contract surface pinned to output 1.2.0', () => {
  // This is the concrete meaning of VERSIONS.output within its major version:
  // the module surface and teardown behavior generated modules guarantee.
  // Breaking any assertion here requires bumping VERSIONS.output and the
  // compiler major version, never a silent codegen change.
  const payload = assignNodeIds(analyzeDependencies(parseComponent(
    '<script>let count = 0;</script><main><p>{count}</p></main>'
  )));
  const source = generateComponent(payload);

  assert.match(source, /export default function mountComponent\(target, props = \{\}\) \{/);
  // Components without declared props expose no setProps member.
  assert.doesNotMatch(source, /setProps/);
  assert.match(source, /return \{\n    destroy\(\) \{/);
  assert.match(source, /target\.removeChild\(rootNode\);/);
  assert.match(source, /\.__wizzChildComponents = childComponents;/);
  assert.match(source, /\.__wizzMountChildren = \(\) => mountChildren\.forEach\(\(mount\) => mount\(\)\);/);
  assert.match(source, /\.__wizzListUpdates = listUpdates;/);
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

  assert.match(source, /count \+= 1; queueUpdate\(\{ count: true \}\);/);
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

  assert.match(source, /function onMount\(hook\) \{ mountHooks\.push\(hook\); \}/);
  assert.match(source, /function onDestroy\(hook\) \{ destroyHooks\.push\(hook\); \}/);
  assert.match(source, /isMounted = true;\n  mountHooks\.forEach\(\(hook\) => hook\(\)\);/);
  assert.match(source, /isDestroyed = true;\n      destroyHooks\.forEach\(\(hook\) => hook\(\)\);/);
});

test('runs mount hooks after mounting with the DOM attached and reactive state available', async () => {
  const payload = assignNodeIds(analyzeDependencies(parseComponent(
    '<script>let status = "created"; function first() { target.mountLog = target.childNodes.length; } function initialize() { status = "mounted"; } onMount(first); onMount(initialize);</script><main><p>{status}</p></main>'
  )));
  const source = generateComponent(payload);
  const document = createDocument();
  const target = { childNodes: [], appendChild(node) { this.childNodes.push(node); }, removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); } };
  const mountComponent = new Function('document', `${source.replace('export default ', '')}\nreturn mountComponent;`)(document);
  mountComponent(target);

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
    '<script>let count = 0; function teardown() { target.destroyLog = target.childNodes.length; count += 1; } onDestroy(teardown);</script><main><button>Clicks: {count}</button></main>'
  )));
  const source = generateComponent(payload);
  const document = createDocument();
  const target = { childNodes: [], appendChild(node) { this.childNodes.push(node); }, removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); } };
  const mountComponent = new Function('document', `${source.replace('export default ', '')}\nreturn mountComponent;`)(document);
  const component = mountComponent(target);
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
  assert.match(source, /mountChildren\.push\(\(\) => childComponents\.push\(Counter\(node_1, \{\}\)\)\);/);
  assert.match(
    source,
    /target\.appendChild\(rootNode\);\n  rootNode\.__wizzMountChildren\(\);\n  update\(ctx, \{  \}\);/
  );
  assert.match(source, /childComponents\.forEach\(\(component\) => component\.destroy\(\)\);/);
  assert.doesNotMatch(source, /document\.createElement\("Counter"\)/);
});

test('passes component tag attributes as props and still rejects children and root-level tags', () => {
  const generate = (template) => generateComponent(assignNodeIds(analyzeDependencies(parseComponent(template))));

  const source = generate("<script>import Counter from './Counter.wizz';</script><main><Counter label=\"Count\" /></main>");
  assert.match(source, /mountChildren\.push\(\(\) => childComponents\.push\(Counter\(node_1, \{ "label": "Count" \}\)\)\);/);
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

  assert.match(source, /export default function mountComponent\(target, props = \{\}\) \{/);
  assert.match(source, /let name = props\.name !== undefined \? props\.name : \('Guest'\);/);
  assert.match(source, /let count = props\.count;/);
  assert.match(source, /setProps\(next\) \{/);
  assert.match(source, /if \(!Object\.is\(name, __wizzNext\)\) \{/);
  assert.match(source, /if \(!Object\.is\(count, next\.count\)\) \{/);
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

  assert.match(source, /let component_1 = null;/);
  assert.match(source, /component_1 = Counter\(node_1, \{ "start": start, "label": "Total" \}\);/);
  assert.match(source, /if \(changed\.start\) \{\n      if \(component_1\) component_1\.setProps\(\{ "start": start \}\);\n    \}/);
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

test('pins the complete default output byte-for-byte for a fixed fixture', () => {
  // Defense in depth beyond the regex pins: the default (non-hydratable)
  // emission must not drift when new targets or options are added. Any
  // intentional change updates this pin and VERSIONS.output together.
  const payload = assignNodeIds(analyzeDependencies(parseComponent(
    '<script>let count = 0;</script><main><p>static</p><p>{count}</p></main>'
  )));
  assert.equal(generateComponent(payload), "// Generated by Wizz 1.5.0 (component syntax 1.1.0, generated output 1.5.0). Edits will be overwritten.\n\nexport default function mountComponent(target, props = {}) {\n  let isMounted = false;\n  let isDestroyed = false;\n  let batchScheduled = false;\n  let pendingChanges = {};\n  const mountHooks = [];\n  const destroyHooks = [];\n  function onMount(hook) { mountHooks.push(hook); }\n  function onDestroy(hook) { destroyHooks.push(hook); }\n  const trackedListeners = [];\n  function trackListener(node, eventName, handler) {\n    node.addEventListener(eventName, handler);\n    trackedListeners.push({ node, eventName, handler });\n  }\n  function queueUpdate(changed) {\n    if (!isMounted) return;\n    pendingChanges = { ...pendingChanges, ...changed };\n    if (batchScheduled) return;\n    batchScheduled = true;\n    queueMicrotask(() => {\n      batchScheduled = false;\n      const changes = pendingChanges;\n      pendingChanges = {};\n      if (isDestroyed) return;\n      update(ctx, changes);\n    });\n  }\n  // --- Developer Logic ---\n  let count = 0;\n  \n// --- Framework Context ---\n  const ctx = {\n    get count() { return count; },\n  };\n  \n// --- DOM Creation ---\n  function create(ctx) {\n    const childComponents = [];\n    const mountChildren = [];\n    const listUpdates = [];\n    const node_1 = document.createElement(\"main\");\n    const node_2 = document.createElement(\"p\");\n    node_1.appendChild(node_2);\n    const node_3 = document.createTextNode(\"static\");\n    node_2.appendChild(node_3);\n    const node_4 = document.createElement(\"p\");\n    node_4.setAttribute(\"data-wizz-id\", \"1\");\n    node_1.appendChild(node_4);\n    const node_5 = document.createTextNode(String(count));\n    node_4.appendChild(node_5);\n    node_1.__wizzChildComponents = childComponents;\n    node_1.__wizzMountChildren = () => mountChildren.forEach((mount) => mount());\n    node_1.__wizzListUpdates = listUpdates;\n    return node_1;\n  }\n  \n// --- Reactivity Engine ---\n  function update(ctx, changed) {\n    if (changed.count) {\n      const target_1 = rootNode.getAttribute('data-wizz-id') === '1' ? rootNode : rootNode.querySelector('[data-wizz-id=\"1\"]');\n      target_1.childNodes[0].nodeValue = String(count);\n    }\n  }\n  \n// --- Initialization ---\n  const rootNode = create(ctx);\n  const childComponents = rootNode.__wizzChildComponents;\n  const listUpdates = rootNode.__wizzListUpdates;\n  target.appendChild(rootNode);\n  rootNode.__wizzMountChildren();\n  update(ctx, { count: true });\n  isMounted = true;\n  mountHooks.forEach((hook) => hook());\n  \nreturn {\n    destroy() {\n      isDestroyed = true;\n      destroyHooks.forEach((hook) => hook());\n      childComponents.forEach((component) => component.destroy());\n      trackedListeners.forEach(({ node, eventName, handler }) => node.removeEventListener(eventName, handler));\n      target.removeChild(rootNode);\n    }\n  };\n}");
});

test('hydratable compiles export both mount entries through one mountInstance', () => {
  const payload = assignNodeIds(analyzeDependencies(parseComponent(
    '<script>let count = 0; function go() {}</script><main><p>{count}</p><button on:click={go}>x</button></main>'
  )));
  const source = generateComponent(payload, { hydratable: true });

  assert.match(source, /export default function mountComponent\(target, props = \{\}\) \{\n  return mountInstance\(target, props, false, null, false\);\n\}/);
  assert.match(source, /export function hydrateComponent\(target, props = \{\}, state = null\) \{\n  return mountInstance\(target, props, true, state, false\);\n\}/);
  // The nested adoption entry adopts the given node as the component root, so
  // a mismatch remounts inside it and never detaches the parent's tree.
  assert.match(source, /export function hydrateRoot\(rootNode, props = \{\}, state = null\)/);
  assert.match(source, /return mountInstance\(rootNode, props, true, state, true\);/);
  assert.match(source, /function mountInstance\(target, props, hydrate, state, adoptSelf\) \{/);
  assert.match(source, /function hydrateCreate\(target, state, adoptSelf\) \{/);
  assert.match(source, /const adoptedHydration = hydrate \? hydrateCreate\(target, state, adoptSelf\) : null;/);
  assert.match(source, /if \(hydrate && !adoptedHydration\) return mountComponent\(target, props\);/);
  assert.match(source, /const rootNode = hydrate \? adoptedHydration\.node : create\(ctx\);/);
  // Hydration collects listeners and attaches them only after the walk passes.
  assert.match(source, /pendingListeners\.forEach\(\(pending\) => trackListener\(pending\[0\], pending\[1\], pending\[2\]\)\);/);
  // A self-adopted root belongs to the parent's tree; teardown leaves it.
  assert.match(source, /if \(!hydrate \|\| !adoptSelf\) target\.removeChild\(rootNode\);/);
});

test('default compiles never emit the hydration surface', () => {
  const payload = assignNodeIds(analyzeDependencies(parseComponent('<script>let count = 0;</script><main><p>{count}</p></main>')));
  const source = generateComponent(payload);

  assert.doesNotMatch(source, /hydrateComponent|hydrateCreate|mountInstance/);
});

test('hydratable compiles seed non-prop reactive state from the serialized snapshot', () => {
  const payload = assignNodeIds(analyzeDependencies(parseComponent(
    '<script>export let label = "x"; let count = 0;</script><p>{label}{count}</p>'
  )));
  const source = generateComponent(payload, { hydratable: true });

  assert.match(source, /if \(hydrate && state && typeof state === 'object' && !Array\.isArray\(state\)\) \{/);
  assert.match(source, /if \(Object\.prototype\.hasOwnProperty\.call\(state, "count"\)\) count = state\["count"\];/);
  assert.doesNotMatch(source, /hasOwnProperty\.call\(state, "label"\)/);
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
  assert.doesNotMatch(plain, /mountInstance\(target, props, hydrate, state, adoptSelf, headOwner\)/);

  const hydratableHeadless = generateComponent(
    assignNodeIds(analyzeDependencies(parseComponent('<main><p>Hi</p></main>'))),
    { hydratable: true }
  );
  assert.doesNotMatch(hydratableHeadless, /__wizzApplyHead/);
  assert.doesNotMatch(hydratableHeadless, /hydrateCreate\(target, state, adoptSelf, headOwner\)/);
});

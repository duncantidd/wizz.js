const assert = require('node:assert/strict');
const test = require('node:test');
const { assignNodeIds } = require('../analyzer/idAssigner');
const { analyzeDependencies } = require('../analyzer/dependencyAnalyzer');
const { parseComponent } = require('../parser');
const { generateComponent } = require('./componentGenerator');

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

  assert.match(source, /^export default function mountComponent\(target\)/);
  assert.match(source, /get count\(\) \{ return count; \}/);
  assert.doesNotMatch(source, /get title\(\)/);
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

test('binds explicit event directives to component-local handlers', () => {
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

  assert.equal(button.attributes['on:click'], undefined);
  assert.equal(button.childNodes[1].nodeValue, '1');
});

test('updates dynamic attributes and properties when reactive state changes', () => {
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

test('emits top-level component imports and mounts imported self-closing components', () => {
  const payload = assignNodeIds(analyzeDependencies(parseComponent(
    "<script>import Counter from './Counter.wizz';</script><main><Counter /></main>"
  )));
  const source = generateComponent(payload);

  assert.match(source, /^import Counter from "\.\/Counter\.js";/);
  assert.match(source, /mountChildren\.push\(\(\) => childComponents\.push\(Counter\(node_1\)\)\);/);
  assert.match(
    source,
    /target\.appendChild\(rootNode\);\n  rootNode\.__wizzMountChildren\(\);\n  update\(ctx, \{  \}\);/
  );
  assert.match(source, /childComponents\.forEach\(\(component\) => component\.destroy\(\)\);/);
  assert.doesNotMatch(source, /document\.createElement\("Counter"\)/);
});

test('rejects component attributes, children, and root-level component tags', () => {
  const generate = (template) => generateComponent(assignNodeIds(analyzeDependencies(parseComponent(template))));

  assert.throws(
    () => generate("<script>import Counter from './Counter.wizz';</script><main><Counter label=\"Count\" /></main>"),
    /Component <Counter> does not support attributes or children\./
  );
  assert.throws(
    () => generate("<script>import Counter from './Counter.wizz';</script><Counter />"),
    /Component <Counter> must be nested inside an element\./
  );
});
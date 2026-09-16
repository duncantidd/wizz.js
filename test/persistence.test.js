const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { compile, compileServer } = require('../src/compiler');

async function flushUpdates() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const THEME_WIZZ = `<script>
  let theme = persist('theme', 'light');
  function toggle() { theme = theme === 'light' ? 'dark' : 'light'; }
</script><main><p>{theme}</p><button on:click={toggle}>Toggle</button></main>`;

// A backing store shared by every tab in one scenario, mirroring the browser
// model: all tabs read and write one origin store, and a write fires storage
// events on every *other* window (never on the writer's own window).
function createSharedStore() {
  const entries = new Map();
  const listeners = new Set();
  const store = { entries };
  store.addListener = (owner, handler) => listeners.add({ owner, handler });
  store.removeListener = (owner, handler) => {
    for (const listener of listeners) {
      if (listener.owner === owner && listener.handler === handler) listeners.delete(listener);
    }
  };
  store.failWrites = false;
  store.viewFor = (owner) => ({
    getItem(key) {
      return entries.has(key) ? entries.get(key) : null;
    },
    setItem(key, value) {
      if (store.failWrites) throw new Error('QuotaExceededError');
      const oldValue = entries.has(key) ? entries.get(key) : null;
      entries.set(key, String(value));
      for (const listener of listeners) {
        if (listener.owner !== owner) listener.handler({ key, oldValue, newValue: String(value) });
      }
    },
    removeItem(key) {
      const oldValue = entries.has(key) ? entries.get(key) : null;
      entries.delete(key);
      for (const listener of listeners) {
        if (listener.owner !== owner) listener.handler({ key, oldValue, newValue: null });
      }
    },
    clear() {
      entries.clear();
      for (const listener of listeners) listener.handler({ key: null, oldValue: null, newValue: null });
    }
  });
  return store;
}

// A fake BroadcastChannel ether: posting delivers to every other live channel
// synchronously (real browsers queue a task; synchronous keeps tests
// deterministic) and never to the sender, matching the platform contract.
function createEther() {
  const channels = [];
  function BroadcastChannel(name) {
    const channel = { name, onmessage: null };
    channel.postMessage = (message) => {
      for (const other of channels.slice()) {
        if (other !== channel && typeof other.onmessage === 'function') other.onmessage({ data: message });
      }
    };
    channel.close = () => {
      const index = channels.indexOf(channel);
      if (index !== -1) channels.splice(index, 1);
    };
    channels.push(channel);
    return channel;
  }
  return { BroadcastChannel, channels };
}

// A compact per-tab document: enough of the DOM surface for fresh mounts and
// hydration walks over the fixtures in this file.
function createTabDocument() {
  const elementsById = new Map();

  function makeTextNode(initialValue) {
    return { nodeType: 3, nodeValue: initialValue };
  }

  function makeElement(name) {
    const element = {
      nodeType: 1,
      name,
      nodeName: name.toUpperCase(),
      tagName: name.toUpperCase(),
      attributes: {},
      childNodes: [],
      listeners: {},
      setAttribute(attributeName, value) {
        element.attributes[attributeName] = String(value);
        if (attributeName === 'data-wizz-id') elementsById.set(`[data-wizz-id="${value}"]`, element);
      },
      removeAttribute(attributeName) {
        delete element.attributes[attributeName];
      },
      getAttribute(attributeName) {
        return element.attributes[attributeName] ?? null;
      },
      querySelector(selector) {
        const find = (node) => {
          for (const child of node.childNodes || []) {
            if (
              child.nodeType === 1 &&
              child.attributes['data-wizz-id'] !== undefined &&
              selector === `[data-wizz-id="${child.attributes['data-wizz-id']}"]`
            ) return child;
            const match = find(child);
            if (match) return match;
          }
          return null;
        };
        return find(element);
      },
      get firstElementChild() {
        return element.childNodes.find((node) => node.nodeType === 1) ?? null;
      },
      appendChild(node) {
        element.childNodes.push(node);
      },
      removeChild(node) {
        const index = element.childNodes.indexOf(node);
        if (index !== -1) element.childNodes.splice(index, 1);
      },
      addEventListener(eventName, listener) {
        element.listeners[eventName] = listener;
      },
      removeEventListener(eventName, listener) {
        if (element.listeners[eventName] === listener) delete element.listeners[eventName];
      },
      dispatchEvent(eventName) {
        element.listeners[eventName]?.({ type: eventName, target: element });
      }
    };
    return element;
  }

  return {
    makeElement,
    makeTextNode,
    createElement(name) {
      return makeElement(name);
    },
    createTextNode(value) {
      return makeTextNode(value);
    },
    createComment(nodeValue) {
      return { nodeType: 8, nodeValue };
    },
    querySelector(selector) {
      return elementsById.get(selector) || null;
    }
  };
}

// Server-escaping mirrors, to decode delivered markup back into shim DOM.
const decodeEntities = (value) => value.replace(
  /&(amp|lt|gt|quot);/g,
  (_, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"' })[entity]
);

function parseMarkup(markup, document) {
  const voidElements = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const root = { name: null, childNodes: [] };
  const stack = [root];
  let index = 0;

  while (index < markup.length) {
    const parent = stack[stack.length - 1];

    if (markup.startsWith('<!--', index)) {
      const end = markup.indexOf('-->', index + 4);
      if (end === -1) throw new Error('Unterminated comment in delivered markup');
      parent.childNodes.push({ nodeType: 8, nodeValue: markup.slice(index + 4, end) });
      index = end + 3;
      continue;
    }

    if (markup.startsWith('</', index)) {
      const end = markup.indexOf('>', index);
      const closing = markup.slice(index + 2, end).trim();
      if (parent.name !== closing) throw new Error(`Mismatched closing tag </${closing}> in delivered markup`);
      stack.pop();
      index = end + 1;
      continue;
    }

    if (markup[index] === '<') {
      const end = markup.indexOf('>', index);
      const rawTag = markup.slice(index + 1, end);
      const name = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(rawTag)[1];
      const selfClosing = rawTag.endsWith('/');
      const element = document.makeElement(name);
      const attributeSource = rawTag.slice(name.length).replace(/\/$/, '');
      const attributePattern = /([^\s=/]+)(?:="([^"]*)")?/g;
      let match;
      while ((match = attributePattern.exec(attributeSource)) !== null) {
        if (match[0] === '') break;
        element.setAttribute(match[1], decodeEntities(match[2] ?? ''));
      }
      parent.childNodes.push(element);
      if (!selfClosing && !voidElements.has(name.toLowerCase())) stack.push(element);
      index = end + 1;
      continue;
    }

    const nextTag = markup.indexOf('<', index);
    const text = markup.slice(index, nextTag === -1 ? markup.length : nextTag);
    parent.childNodes.push(document.makeTextNode(decodeEntities(text)));
    index = nextTag === -1 ? markup.length : nextTag;
  }

  if (stack.length > 1) throw new Error(`Unclosed tag <${stack[stack.length - 1].name}> in delivered markup`);
  return root.childNodes;
}

function deliverMarkup(markup, document) {
  const target = document.makeElement('div');
  for (const node of parseMarkup(markup, document)) target.appendChild(node);
  return target;
}

// A tab is a fresh JavaScript realm: its own globalThis (so the state bus is
// per-tab exactly as in a browser), its own localStorage view over the shared
// store, its own window storage listeners, and its own module evaluation.
function createTab({ store, ether } = {}) {
  const owner = {};
  const document = createTabDocument();
  const context = vm.createContext();
  const tab = { owner, document, context };

  tab.global = vm.runInContext('globalThis', context);
  tab.global.document = document;
  tab.global.queueMicrotask = queueMicrotask;
  if (store) tab.global.localStorage = store.viewFor(owner);
  if (ether) tab.global.BroadcastChannel = ether.BroadcastChannel;
  tab.global.window = {
    addEventListener(eventName, handler) {
      if (eventName === 'storage' && store) store.addListener(owner, handler);
    },
    removeEventListener(eventName, handler) {
      if (eventName === 'storage' && store) store.removeListener(owner, handler);
    }
  };

  // Strips ESM exports and evaluates the module inside the tab, returning the
  // factory. The generated module references `document` bare, so the factory
  // takes it as a parameter like the generator-level tests do.
  const stripExports = (moduleSource) => moduleSource
    .replace(/^export \{[^}]*\};\s*$/gm, '')
    .replace(/^export (default )?/gm, '');
  tab.load = (moduleSource) => {
    const body = stripExports(moduleSource);
    const factorySource = `(function (document) {\n${body}\nreturn {\n` +
      '  mountComponent,\n' +
      '  hydrateComponent: typeof hydrateComponent === "undefined" ? null : hydrateComponent,\n' +
      '  hydrateRoot: typeof hydrateRoot === "undefined" ? null : hydrateRoot\n' +
      '};\n})';
    return vm.runInContext(factorySource, context);
  };
  tab.loadServer = (moduleSource) => {
    const body = stripExports(moduleSource);
    // The server module takes no document, so the wrapper self-invokes and
    // yields the module object directly.
    // The server module renames its serializer through an export list, so
    // resolve whichever binding exists; typeof keeps undeclared names safe.
    const factorySource = `(() => {\n${body}\nreturn {\n` +
      '  renderComponent,\n' +
      '  serializeInitialState: typeof __wizzSerializeInitialState === "function" ? __wizzSerializeInitialState : (typeof serializeInitialState === "function" ? serializeInitialState : null)\n' +
      '};\n})()';
    return vm.runInContext(factorySource, context);
  };
  return tab;
}

// Mounts the theme fixture on a tab and hands back readers over the shim DOM.
function mountTheme(tab, clientModuleSource) {
  const factory = tab.load(clientModuleSource);
  const target = { childNodes: [], appendChild(node) { this.childNodes.push(node); }, removeChild() {} };
  const component = factory(tab.document).mountComponent(target);
  const main = target.childNodes[0];
  return {
    component,
    text: () => main.childNodes[0].childNodes[0].nodeValue,
    toggle: () => main.childNodes[1].dispatchEvent('click')
  };
}

async function compileThemeModule(options = {}) {
  const { source } = compile(THEME_WIZZ, options);
  return source;
}

test('a remounted component adopts the value the previous session wrote', async () => {
  const store = createSharedStore();
  const ether = createEther();
  const clientSource = await compileThemeModule();

  const firstTab = createTab({ store, ether });
  const first = mountTheme(firstTab, clientSource);
  assert.equal(first.text(), 'light');
  first.toggle();
  await flushUpdates();
  assert.equal(first.text(), 'dark');
  assert.equal(store.entries.get('theme'), '"dark"');
  first.component.destroy();

  // The "refresh": a brand-new realm mounts with the same storage.
  const secondTab = createTab({ store, ether });
  const second = mountTheme(secondTab, clientSource);
  assert.equal(second.text(), 'dark', 'the persisted value survives the reload');
});

test('a write in one tab reaches mounted components in other tabs', async () => {
  const store = createSharedStore();
  const ether = createEther();
  const clientSource = await compileThemeModule();

  const tabA = createTab({ store, ether });
  const tabB = createTab({ store, ether });
  const inA = mountTheme(tabA, clientSource);
  const inB = mountTheme(tabB, clientSource);

  assert.equal(inA.text(), 'light');
  assert.equal(inB.text(), 'light');

  inA.toggle();
  await flushUpdates();

  assert.equal(inA.text(), 'dark');
  assert.equal(inB.text(), 'dark', 'the other tab converged via BroadcastChannel');
  assert.equal(store.entries.get('theme'), '"dark"');
});

test('tabs without BroadcastChannel converge through storage events', async () => {
  const store = createSharedStore();
  const clientSource = await compileThemeModule();

  const tabA = createTab({ store });
  const tabB = createTab({ store });
  const inA = mountTheme(tabA, clientSource);
  const inB = mountTheme(tabB, clientSource);

  inA.toggle();
  await flushUpdates();

  assert.equal(inA.text(), 'dark');
  assert.equal(inB.text(), 'dark', 'the storage-event fallback delivered the value');
});

test('a corrupted stored entry falls back to the default instead of throwing', async () => {
  const store = createSharedStore();
  store.entries.set('theme', '{oops');
  const ether = createEther();
  const clientSource = await compileThemeModule();

  const tab = createTab({ store, ether });
  const mounted = mountTheme(tab, clientSource);

  assert.equal(mounted.text(), 'light', 'the default wins over unreadable storage');

  // A later write replaces the hostile entry wholesale.
  mounted.toggle();
  await flushUpdates();
  assert.equal(mounted.text(), 'dark');
  assert.equal(store.entries.get('theme'), '"dark"');
});

test('storage write failures leave the in-memory state and peers intact', async () => {
  const store = createSharedStore();
  const ether = createEther();
  const clientSource = await compileThemeModule();

  const tabA = createTab({ store, ether });
  const tabB = createTab({ store, ether });
  const inA = mountTheme(tabA, clientSource);
  const inB = mountTheme(tabB, clientSource);

  store.failWrites = true;
  assert.doesNotThrow(() => inA.toggle());
  await flushUpdates();
  assert.equal(inA.text(), 'dark', 'the in-memory state still updates');
  assert.equal(inB.text(), 'dark', 'peers still receive the value');
  assert.equal(store.entries.has('theme'), false, 'the failed write never landed');

  // Recovery: once writes succeed again, the next mutation persists.
  store.failWrites = false;
  inA.toggle();
  await flushUpdates();
  assert.equal(store.entries.get('theme'), '"light"');
});

test('two instances of one component in the same tab share the key and converge', async () => {
  const store = createSharedStore();
  const ether = createEther();
  const clientSource = await compileThemeModule();

  const tab = createTab({ store, ether });
  const first = mountTheme(tab, clientSource);
  const second = mountTheme(tab, clientSource);

  first.toggle();
  await flushUpdates();

  assert.equal(first.text(), 'dark');
  assert.equal(second.text(), 'dark');

  first.component.destroy();
  second.component.destroy();
  assert.equal(tab.global.__wizzStateBus.bindings.size, 0, 'destroy unregisters every key');
});

test('hydration adopts the server default and the initial pass writes the stored value', async () => {
  const store = createSharedStore();
  store.entries.set('theme', '"dark"');
  const ether = createEther();
  const clientSource = await compileThemeModule({ hydratable: true });
  const { source: serverSource } = compileServer(THEME_WIZZ, {});

  const tab = createTab({ store, ether });
  const serverModule = tab.loadServer(serverSource);
  const { html, state } = serverModule.renderComponent();
  assert.ok(html.includes('>light<'), 'the server rendered the default');
  const stateScript = serverModule.serializeInitialState(state);

  const clientModule = tab.load(clientSource)(tab.document);
  const target = deliverMarkup(html, tab.document);
  const stateValue = JSON.parse(/^<script type="application\/wizz-state">(.*)<\/script>$/.exec(stateScript)[1]);
  clientModule.hydrateComponent(target, {}, stateValue);

  const paragraph = target.childNodes[0].childNodes[0];
  await flushUpdates();
  assert.equal(paragraph.childNodes[0].nodeValue, 'dark', 'the stored value replaced the server default after adoption');
});

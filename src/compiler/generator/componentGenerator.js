const { CodeBuilder } = require('./codeBuilder');
const { generateCreateFunction, collectComponentRefNames } = require('./domGenerator');
const { generateUpdateFunction } = require('./updateGenerator');
const { interceptAssignments, findReactiveMutations } = require('./assignmentInterceptor');
const { rewritePersistInitializers } = require('./persistInitializer');
const { assertServerRenderable } = require('./serverGenerator');
const { generateHydrationFunction } = require('./hydrationGenerator');
const { scopeCss } = require('../analyzer/cssScanner.js');
const { VERSIONS } = require('../version.js');

// Defined flush-left and emitted verbatim via Function.prototype.toString so
// the generated module carries exactly this head-management implementation
// (the same pattern as the server target's escaping helpers). Head nodes are
// plain DOM nodes held in the instance closure; `data-wizz-head` marks the
// owning instance for conflict warnings, while `data-wizz-head-id` is the
// server delivery tag hydration consumes. The `__wizz` prefix is reserved, so
// author identifiers cannot collide with any of these names.
//
// Style nodes (tagged `data-wizz-style` with the component's scope) dedup by
// scope: a component rendered by several instances must inject its stylesheet
// exactly once, so an already-present copy is refcounted through
// `data-wizz-refs` instead of re-inserted and the duplicate node is dropped.
// The applied list holds the node whose ref THIS call acquired — an inserted
// copy (refs set to 1) or the found copy (refs incremented) — so release
// decrements exactly once per acquisition and removes the stylesheet when the
// last holder lets go.
function __wizzApplyHead(nodes, loc) {
  const head = document.head;
  const owner = 'h' + (++__wizzHeadOwnerSeq);
  const applied = [];
  const titles = nodes.filter((node) => node.nodeName === 'TITLE');
  const existing = titles.length > 0
    ? Array.prototype.slice.call(head.querySelectorAll('title[data-wizz-head]'))
    : [];
  if (titles.length > 0 && existing.length > 0) {
    console.warn('[wizz] Multiple <title> declarations are mounted in the document head; the most recently mounted one wins. Existing: ' + (existing[0].getAttribute('data-wizz-loc') || 'unknown location') + ' Latest: ' + loc);
  }
  for (const node of nodes) {
    if (node.nodeName === 'STYLE' && node.getAttribute('data-wizz-style')) {
      const scope = node.getAttribute('data-wizz-style');
      let found = null;
      for (const candidate of head.querySelectorAll('style[data-wizz-style]')) {
        if (candidate.getAttribute('data-wizz-style') === scope) { found = candidate; break; }
      }
      if (found) {
        const current = parseInt(found.getAttribute('data-wizz-refs'), 10);
        found.setAttribute('data-wizz-refs', String((Number.isNaN(current) ? 0 : current) + 1));
        applied.push(found);
        continue;
      }
      node.setAttribute('data-wizz-refs', '1');
      applied.push(node);
      continue;
    }
    applied.push(node);
  }
  for (const node of applied) node.setAttribute('data-wizz-head', owner);
  // Prepending makes the latest-applied title the document's first title
  // element — the one the document.title getter reads — mirroring the
  // last-in-tree title policy; on release the previous owner's title resumes
  // naturally because the nodes are simply removed again.
  for (const node of applied) head.insertBefore(node, head.firstChild);
  return applied;
}
function __wizzReleaseHead(nodes) {
  for (const node of nodes) {
    if (node.nodeName === 'STYLE' && node.getAttribute('data-wizz-style') && node.parentNode) {
      // Decrement this holder's ref; the stylesheet survives until the last
      // holder releases. A missing/invalid count defensively reads as 1.
      const refs = (parseInt(node.getAttribute('data-wizz-refs'), 10) || 1) - 1;
      if (refs <= 0) node.parentNode.removeChild(node);
      else node.setAttribute('data-wizz-refs', String(refs));
      continue;
    }
    if (node.parentNode) node.parentNode.removeChild(node);
  }
}
function __wizzClaimHead(nodes) {
  const owner = 'h' + (++__wizzHeadOwnerSeq);
  for (const node of nodes) {
    node.setAttribute('data-wizz-head', owner);
    node.removeAttribute('data-wizz-head-id');
  }
  const titles = Array.prototype.slice.call(document.head.querySelectorAll('title[data-wizz-head]'));
  if (titles.length > 1) {
    console.warn('[wizz] Multiple <title> declarations are mounted in the document head; the most recently mounted one wins. Existing: ' + (titles[0].getAttribute('data-wizz-loc') || 'unknown location') + ' Latest: ' + (titles[1].getAttribute('data-wizz-loc') || 'unknown location'));
  }
  // Move the freshly claimed titles to the front so the deepest component's
  // title is the one document.title reads, reproducing the fresh-mount order
  // without re-creating the adopted nodes.
  for (const node of nodes) {
    if (node.nodeName === 'TITLE' && node.parentNode === document.head) {
      document.head.insertBefore(node, document.head.firstChild);
    }
  }
}
function __wizzFindHeadRun() {
  const head = document.head;
  if (!head) return null;
  let startMarker = null;
  let endMarker = null;
  for (const node of head.childNodes) {
    if (node.nodeType !== 8) continue;
    if (node.nodeValue === 'wizz:head-start') startMarker = node;
    else if (node.nodeValue === 'wizz:head-end') { endMarker = node; break; }
  }
  if (!startMarker || !endMarker) return null;
  const nodes = [];
  let inside = false;
  for (const node of head.childNodes) {
    if (node === startMarker) { inside = true; continue; }
    if (node === endMarker) break;
    if (inside) nodes.push(node);
  }
  return { startMarker, endMarker, nodes };
}
function __wizzStripHeadRun() {
  const run = __wizzFindHeadRun();
  if (!run) return;
  run.startMarker.parentNode.removeChild(run.startMarker);
  run.endMarker.parentNode.removeChild(run.endMarker);
  for (const node of run.nodes) {
    if (node.parentNode) node.parentNode.removeChild(node);
  }
}
// Removes a component's unclaimed server-delivered head slice (tagged with
// its owner path) before a fresh remount applies its head again.
function __wizzStripOwnedHeadSlice(owner) {
  const head = document.head;
  if (!head) return;
  for (const node of Array.prototype.slice.call(head.childNodes)) {
    if (node.getAttribute && node.getAttribute('data-wizz-head-id') === owner) {
      node.parentNode.removeChild(node);
    }
  }
}

// --- Persistent state (milestone 17) ---
// These four functions are emitted into generated modules via toString() the
// same way the head helpers are. The channel, per-key registry, and storage
// listener are shared through a globalThis singleton so one bus serves every
// module on the page; the functions themselves stay per-module definitions.
// Storage is untrusted input: reads parse defensively and fall back to the
// default, writes are guarded so quota or private-mode failures leave the
// in-memory state intact, and values replace wholesale (never merged), which
// keeps hostile stored objects away from any merge vector.

function __wizzStateBus() {
  if (globalThis.__wizzStateBus) return globalThis.__wizzStateBus;
  const bindings = new Map();
  const bus = { bindings };
  function deliver(key, value) {
    const subscribers = bindings.get(key);
    if (!subscribers) return;
    for (const subscriber of Array.from(subscribers)) subscriber(value);
  }
  bus.deliver = deliver;
  let channel = null;
  if (typeof BroadcastChannel === 'function') {
    try {
      channel = new BroadcastChannel('wizz-state');
      channel.onmessage = (event) => {
        const data = event.data;
        if (data && typeof data.key === 'string') deliver(data.key, data.value);
      };
    } catch (error) {
      channel = null;
    }
    // Node-style environments expose unref() so an idle bus never holds the
    // process open (tests, SSR); browsers have no unref and skip this.
    if (channel && typeof channel.unref === 'function') channel.unref();
  }
  bus.channel = channel;
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    // Fallback for environments without BroadcastChannel. A tab's own write
    // never fires its storage event (the writer already delivered locally),
    // and a removed key (newValue null) leaves mounted state alone until the
    // next mount reads storage.
    window.addEventListener('storage', (event) => {
      if (event.key === null || event.newValue === null || !bindings.has(event.key)) return;
      let value;
      try {
        value = JSON.parse(event.newValue);
      } catch (error) {
        return; // corrupt entry: mounted state stays; the next mount re-reads
      }
      deliver(event.key, value);
    });
  }
  globalThis.__wizzStateBus = bus;
  return bus;
}

function __wizzPersistRead(key, fallback) {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return fallback;
    const raw = storage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw);
  } catch (error) {
    return fallback; // absent, corrupted, or unreadable storage: the default wins
  }
}

function __wizzPersistWrite(key, value) {
  const bus = __wizzStateBus();
  try {
    const storage = globalThis.localStorage;
    if (storage) storage.setItem(key, JSON.stringify(value));
  } catch (error) {} // quota or private mode: in-memory state still updates
  if (bus.channel) {
    try {
      bus.channel.postMessage({ key, value });
    } catch (error) {}
  }
  bus.deliver(key, value); // same-tab components sharing the key converge
}

function __wizzPersistSubscribe(key, callback) {
  const bus = __wizzStateBus();
  let subscribers = bus.bindings.get(key);
  if (!subscribers) {
    subscribers = new Set();
    bus.bindings.set(key, subscribers);
  }
  subscribers.add(callback);
  return () => {
    const current = bus.bindings.get(key);
    if (!current) return;
    current.delete(callback);
    if (current.size === 0) bus.bindings.delete(key);
  };
}

/**
 * Wraps the parsed component into a single, importable Factory Closure.
 * @param {Object} astPayload - The Final Handoff Object (must include rawScript).
 * @param {Object} [options] - Generation options.
 * @param {boolean} [options.hydratable] - When true, the module additionally
 *   exports hydrateComponent(target, props, state) and hydrateRoot(rootNode,
 *   props, state), which adopt server-rendered markup instead of recreating
 *   it. Hydratable modules are restricted to the server-renderable component
 *   surface. Default generation is unchanged.
 * @param {Object<string, boolean>} [options.componentServerRenderable] -
 *   Import names vouched for as having server-renderable builds; required for
 *   component tags to pass the hydratable gate.
 * @param {Object<string, string>} [options.componentIneligibilityReasons] -
 *   Import names mapped to the child's own gate failure, chained into the
 *   thrown diagnostic.
 * @param {string} [options.filePath] - Path of the component file, used to
 *   qualify the `data-wizz-loc` diagnostics emitted on head nodes.
 * @returns {string} The final compiled JavaScript module.
 */
function generateComponent(astPayload, options = {}) {
  const hydratable = options.hydratable === true;
  if (hydratable) {
    // Hydratable modules are held to the same surface as the server target.
    assertServerRenderable(astPayload, {
      componentServerRenderable: options.componentServerRenderable,
      componentIneligibilityReasons: options.componentIneligibilityReasons
    });
  }
  const builder = new CodeBuilder();
      const componentImports = astPayload.imports || [];
  const props = astPayload.props || [];
  // Persistent state rides the ordinary reactive pipeline (same dependency
  // tracking, change flags, and update walk); only the initializer, the
  // storage write, and the cross-tab subscription differ.
  const persistentVars = astPayload.script.filter((declaration) => declaration.isPersistent);

  // Head machinery turns on when the component owns head markup (fresh mounts
  // apply and destroy releases it), owns a style block (styles hoist through
  // the same head lifecycle), or — for hydratable modules — when a nested
  // component's delivered head must be adopted through this module.
  // Gating on static presence keeps head-free, component-free output
  // byte-identical.
  const ownHead = astPayload.head != null;
  const ownStyle = astPayload.style != null;
  const hasRenderedComponentTags = componentImports.some(({ name }) => renderedImportNames(astPayload.template, name));
  const headActive = ownHead || ownStyle || (hydratable && hasRenderedComponentTags);
  // Conflict warnings name a title location when one exists (titles are what
  // conflict), falling back to the block's own location.
  const headLocLiteral = ownHead
    ? JSON.stringify((options.filePath ? `${options.filePath}:` : '')
      + (astPayload.head.children.find((child) => child.name === 'title') ?? astPayload.head).loc.start.line
      + ':' + (astPayload.head.children.find((child) => child.name === 'title') ?? astPayload.head).loc.start.column)
    : null;
  const styleLocLiteral = ownStyle
    ? JSON.stringify((options.filePath ? `${options.filePath}:` : '')
      + astPayload.style.loc.start.line + ':' + astPayload.style.loc.start.column)
    : null;

  // Prop bindings are parent-owned and read-only: any statement-level
  // mutation of a prop name inside the child script is a compile-time error.
  if (props.length > 0 && astPayload.rawScript) {
    const propMutations = findReactiveMutations(astPayload.rawScript, props.map((prop) => prop.name));
    if (propMutations.length > 0) {
      const first = propMutations[0];
      throw new SyntaxError(`Props are read-only: '${first.name}' cannot be assigned inside the component at ${first.line}:${first.column}.`);
    }
  }

  // Generated modules self-identify so artifacts stay traceable to the
  // compiler and contract versions that produced them.
  builder.add(`// Generated by Wizz ${VERSIONS.compiler} (component syntax ${VERSIONS.syntax}, generated output ${VERSIONS.output}). Edits will be overwritten.`);
  builder.add('');

      componentImports.forEach(({ name, source }) => {
            builder.add(`import ${name} from ${JSON.stringify(source.replace(/\.wizz$/, '.js'))};`);
      });
      if (hydratable) {
        // Nested hydration imports the child's hydratable module alongside
        // its browser module; only rendered tags are imported so an unused
        // import can never break module loading. Import statements must sit
        // on their own lines (see the parser's import handling).
        for (const { name, source } of componentImports) {
          if (!renderedImportNames(astPayload.template, name)) continue;
          builder.add(`import * as __wizzHydrate_${name} from ${JSON.stringify(source.replace(/\.wizz$/, '.hydrate.js'))};`);
        }
      }
      if (componentImports.length > 0) builder.add('');

  // The head helpers are emitted from their in-generator definitions so the
  // generated module carries exactly this implementation. createHeadNodes()
  // is emitted later, inside mountInstance, because it evaluates the
  // component's expressions at mount time.
  if (headActive) {
    builder.add('// --- Head Management ---');
    builder.add('let __wizzHeadOwnerSeq = 0;');
    builder.add(__wizzApplyHead.toString());
    builder.add('');
    builder.add(__wizzReleaseHead.toString());
    builder.add('');
    builder.add(__wizzClaimHead.toString());
    builder.add('');
    builder.add(__wizzFindHeadRun.toString());
    builder.add('');
    builder.add(__wizzStripHeadRun.toString());
    builder.add('');
    builder.add(__wizzStripOwnedHeadSlice.toString());
    builder.add('');
  }

  // Persistent state helpers are emitted from their in-generator definitions
  // (same pattern as the head helpers) so every generated module carries
  // exactly this implementation. Components without persistent state keep
  // byte-identical output.
  if (persistentVars.length > 0) {
    builder.add('// --- Persistent State Helpers ---');
    builder.add(__wizzStateBus.toString());
    builder.add('');
    builder.add(__wizzPersistRead.toString());
    builder.add('');
    builder.add(__wizzPersistWrite.toString());
    builder.add('');
    builder.add(__wizzPersistSubscribe.toString());
    builder.add('');
  }

  // 1. Factory Function Signature. `props` carries the values the parent
  // passed to the component tag; missing keys fall back to declared defaults.
  // Hydratable modules route both public entries through one mountInstance
  // closure; the default emission is unchanged.
  if (hydratable) {
    builder.add('export default function mountComponent(target, props = {}) {')
          .indent()
          .add('return mountInstance(target, props, false, null, false);')
          .dedent()
          .add('}')
          .add('')
          .add('export function hydrateComponent(target, props = {}, state = null) {')
          .indent()
          .add('return mountInstance(target, props, true, state, false);')
          .dedent()
          .add('}')
          .add('')
          .add(headActive
            ? 'export function hydrateRoot(rootNode, props = {}, state = null, headOwner = null) {'
            : 'export function hydrateRoot(rootNode, props = {}, state = null) {')
          .indent()
          .add('// Nested adoption entry: rootNode is already in the parent\'s DOM at')
          .add('// the component tag\'s position, so a mismatch remounts inside it')
          .add('// and never detaches anything from the parent tree.')
          .add(headActive
            ? 'return mountInstance(rootNode, props, true, state, true, headOwner);'
            : 'return mountInstance(rootNode, props, true, state, true);')
          .dedent()
          .add('}')
          .add('')
          .add(headActive
            ? 'function mountInstance(target, props, hydrate, state, adoptSelf, headOwner) {'
            : 'function mountInstance(target, props, hydrate, state, adoptSelf) {')
          .indent();
  } else {
    builder.add('export default function mountComponent(target, props = {}) {')
          .indent();
  }

      const reactiveVars = astPayload.script.filter(decl => decl.isReactive);

      builder.add('let isMounted = false;');
      if (ownHead || ownStyle) {
        // Head nodes applied on mount (or adopted during hydration) and
        // released on destroy; null until the initialization block runs.
        builder.add('let headNodes = null;');
      }
      builder.add('let isDestroyed = false;');
      builder.add('let batchScheduled = false;');
      builder.add('let pendingChanges = {};');
      builder.add('const mountHooks = [];');
      builder.add('const destroyHooks = [];');
      builder.add('function onMount(hook) { mountHooks.push(hook); }');
      builder.add('function onDestroy(hook) { destroyHooks.push(hook); }');
      builder.add('const trackedListeners = [];');
      builder.add('function trackListener(node, eventName, handler) {')
                    .indent()
                    .add('node.addEventListener(eventName, handler);')
                    .add('trackedListeners.push({ node, eventName, handler });')
                    .dedent()
                    .add('}');
      builder.add('function queueUpdate(changed) {')
                        .indent()
                        .add('if (!isMounted) return;')
                        .add('pendingChanges = { ...pendingChanges, ...changed };')
                        .add('if (batchScheduled) return;')
                        .add('batchScheduled = true;')
                        .add('queueMicrotask(() => {')
                            .indent()
                            .add('batchScheduled = false;')
                            .add('const changes = pendingChanges;')
                            .add('pendingChanges = {};')
                            .add('if (isDestroyed) return;')
                            .add('update(ctx, changes);')
                        .dedent()
                        .add('});')
                        .dedent()
                        .add('}');

  // 2. Paste the developer's original logic so it forms the lexical environment
  builder.add('// --- Developer Logic ---');

  // Prop bindings replace the removed `export let` statements, in declaration
  // order. `undefined` means "not provided", so the declared default applies.
  props.forEach(({ name, defaultValue }) => {
    builder.add(defaultValue === null
      ? `let ${name} = props.${name};`
      : `let ${name} = props.${name} !== undefined ? props.${name} : (${defaultValue});`);
  });

  if (astPayload.rawScript) {
    // Persistent markers are replaced first — the client target reads the
    // persisted value through the runtime helper at declaration time, before
    // the first create pass, so the first paint already shows it — then
    // assignments are intercepted, which for persistent names also writes
    // the new value back through storage.
    const clientScript = persistentVars.length > 0
      ? rewritePersistInitializers(
        astPayload.rawScript,
        astPayload.script,
        (declaration) => `__wizzPersistRead(${JSON.stringify(declaration.storageKey)}, (${declaration.defaultValue}))`
      )
      : astPayload.rawScript;
    // Split by newline and add to builder to maintain proper indentation
            const interceptedScript = interceptAssignments(
                  clientScript,
                  reactiveVars.map(decl => decl.name),
                  persistentVars.map((declaration) => ({ name: declaration.name, storageKey: declaration.storageKey }))
            );
            interceptedScript.split('\n').forEach(line => builder.add(line));
  }

  // Persistent state subscribes through the shared page bus: an incoming
  // value from another tab (or another mounted instance in this tab) is
  // adopted only when it differs, then rides the ordinary change-flag path.
  // Destroy hooks unregister the bindings so a destroyed instance never
  // receives values.
  if (persistentVars.length > 0) {
    builder.add('');
    builder.add('// --- Persistent State ---');
    builder.add('const __wizzPersistUnsubscribe = [];');
    for (const declaration of persistentVars) {
      builder.add(`__wizzPersistUnsubscribe.push(__wizzPersistSubscribe(${JSON.stringify(declaration.storageKey)}, (value) => {`).indent();
      builder.add(`if (Object.is(value, ${declaration.name})) return;`);
      builder.add(`${declaration.name} = value;`);
      builder.add(`queueUpdate({ ${declaration.name}: true });`);
      builder.dedent().add('}));');
    }
    builder.add('destroyHooks.push(() => { for (const unsubscribe of __wizzPersistUnsubscribe) unsubscribe(); });');
    if (hydratable) {
      // The adoption walk verifies the delivered markup by re-evaluating the
      // template's expressions, and the server rendered that markup from the
      // serialized state — so the seeding block below temporarily installs
      // the server's values. This captures the storage-read ones; the
      // initialization block restores them as soon as the walk returns,
      // handing authority back to client storage before the initial update
      // pass syncs the adopted markup to the persisted values.
      builder.add(`const __wizzPersistHydration = { ${persistentVars.map(declaration => `${declaration.name}: ${declaration.name}`).join(', ')} };`);
    }
  }

  // Hydration: server-rendered initial state overrides the script-computed
  // values. Props always win (they are re-applied by the parent), so prop
  // bindings are never seeded. The hasOwnProperty + bracket access pattern
  // means a hostile `__proto__` key in the serialized state cannot pollute
  // Object.prototype.
  if (hydratable) {
    // Persistent variables are seeded too: the delivered markup was rendered
    // from this state, so the adoption walk's expression checks must
    // re-evaluate against the server's values to verify it — evaluating them
    // against the storage-read value makes every stored value that differs
    // from the default fail the walk and fall back. Client storage stays
    // authoritative for the mounted instance: the captured storage-read
    // values are restored right after the walk returns, and the initial
    // update pass below syncs the adopted markup to them.
    const seedableVars = reactiveVars.filter(decl => !decl.isProp);
    if (seedableVars.length > 0) {
      builder.add('\n// --- Initial State ---');
      builder.add("if (hydrate && state && typeof state === 'object' && !Array.isArray(state)) {")
            .indent();
      seedableVars.forEach((declaration) => {
        builder.add(`if (Object.prototype.hasOwnProperty.call(state, ${JSON.stringify(declaration.name)})) ${declaration.name} = state[${JSON.stringify(declaration.name)}];`);
      });
      builder.dedent()
            .add('}');
    }
  }

  // 3. Build the Context Object dynamically
  // We use getters so the create() function always reads the latest memory reference
  builder.add('\n// --- Framework Context ---');
  builder.add('const ctx = {')
        .indent();
  
  reactiveVars.forEach(decl => {
    builder.add(`get ${decl.name}() { return ${decl.name}; },`);
  });
  
  builder.dedent()
        .add('};');

  // 4. Inject the generated DOM create() function
  builder.add('\n// --- DOM Creation ---');
      const createCode = generateCreateFunction(astPayload.template, componentImports);

  // Component instances with reactive props live in factory-scope references
  // shared by create() (which assigns them) and update() (which reads them).
  const componentRefNames = collectComponentRefNames(astPayload.template, componentImports);
  componentRefNames.forEach((refName) => builder.add(`let ${refName} = null;`));
  if (componentRefNames.length > 0) builder.add('');

  createCode.split('\n').forEach(line => builder.add(line));

  // 4a. Inject the head node factory inside mountInstance: it closes over the
  // author's bindings and evaluates dynamic head values at mount time, the
  // same way the server target evaluates them at render time. Event
  // directives are skipped — head nodes never receive listeners, since the
  // head follows navigation rather than state changes.
  if (ownHead) {
    builder.add('');
    builder.add('// --- Head Creation ---');
    builder.add('function createHeadNodes() {').indent();
    builder.add('const nodes = [];');

    const emitHeadAttribute = (nodeRef, attribute) => {
      if (attribute.name.startsWith('on:')) return;
      if (attribute.dynamic) {
        if (attribute.name === 'checked' || attribute.name === 'disabled') {
          // Absence is the false representation for boolean attributes.
          builder.add(`if (${attribute.value}) ${nodeRef}.setAttribute(${JSON.stringify(attribute.name)}, '');`);
          return;
        }
        builder.add(`${nodeRef}.setAttribute(${JSON.stringify(attribute.name)}, String(${attribute.value}));`);
        return;
      }
      builder.add(`${nodeRef}.setAttribute(${JSON.stringify(attribute.name)}, ${JSON.stringify(attribute.value === null ? '' : attribute.value)});`);
    };

    // Title is RCDATA in HTML, so its text runs coalesce into a single text
    // node instead of comment-separated adjacency markers.
    const emitTitleContent = (nodeRef, titleNode) => {
      const segments = [];
      let pendingText = '';
      for (const child of titleNode.children || []) {
        if (child.type === 'Text') {
          pendingText += child.value;
          continue;
        }
        if (child.type === 'Expression') {
          if (pendingText !== '') {
            segments.push(JSON.stringify(pendingText));
            pendingText = '';
          }
          segments.push(`String(${child.value})`);
          continue;
        }
        throw new SyntaxError(`<${child.name}> is not allowed inside <title> at ${child.loc?.start?.line ?? '?'}:${child.loc?.start?.column ?? '?'}.`);
      }
      if (pendingText !== '') segments.push(JSON.stringify(pendingText));
      builder.add(`${nodeRef}.textContent = ${segments.length === 0 ? "''" : segments.join(' + ')};`);
    };

    let headNodeCounter = 0;
    for (const child of astPayload.head.children || []) {
      const nodeRef = `__wizzHeadNode_${++headNodeCounter}`;
      builder.add(`const ${nodeRef} = document.createElement(${JSON.stringify(child.name)});`);
      if (child.name === 'title') {
        const at = `${child.loc.start.line}:${child.loc.start.column}`;
        builder.add(`${nodeRef}.setAttribute('data-wizz-loc', ${JSON.stringify((options.filePath ? `${options.filePath}:` : '') + at)});`);
        emitTitleContent(nodeRef, child);
      }
      (child.attributes || []).forEach((attribute) => emitHeadAttribute(nodeRef, attribute));
      builder.add(`nodes.push(${nodeRef});`);
    }
    builder.add('return nodes;');
    builder.dedent().add('}');
  }

  // 4a-styles. The scoped stylesheet is computed at compile time and baked in
  // as a literal: textContent (never innerHTML) keeps the author CSS out of
  // any markup parsing. __wizzApplyHead dedups by scope with refcounts, so a
  // component rendered by several instances injects one stylesheet.
  if (ownStyle) {
    builder.add('');
    builder.add('// --- Style Creation ---');
    builder.add('function createStyleNodes() {').indent();
    builder.add('const nodes = [];');
    builder.add(`const styleNode = document.createElement('style');`);
    builder.add(`styleNode.setAttribute('data-wizz-style', ${JSON.stringify(astPayload.style.scope)});`);
    builder.add(`styleNode.setAttribute('data-wizz-loc', ${styleLocLiteral});`);
    builder.add(`styleNode.textContent = ${JSON.stringify(scopeCss(astPayload.style.css, astPayload.style.scope))};`);
    builder.add('nodes.push(styleNode);');
    builder.add('return nodes;');
    builder.dedent().add('}');
  }

  // 4b. Inject the hydration adoption walk for hydratable modules. The style
  // block rides along so the run machinery activates for styled-only
  // components (their delivered stylesheet must not strand the run markers).
  if (hydratable) {
    const hydrationCode = generateHydrationFunction(astPayload.template, componentImports, astPayload.head, options, astPayload.style);
    hydrationCode.split('\n').forEach(line => builder.add(line));
  }

  // 5. Inject the generated Reactivity Engine update() function
  builder.add('\n// --- Reactivity Engine ---');
  const updateCode = generateUpdateFunction(astPayload.template);
  updateCode.split('\n').forEach(line => builder.add(line));

  // 6. Mount the component to the DOM. Hydration adopts the server-rendered
  // root instead of creating one and falls back to a full client mount when
  // the walk reports any mismatch. Head nodes and style nodes each acquire
  // their ref through __wizzApplyHead (styles dedup by scope); the combined
  // list is what destroy releases.
  builder.add('\n// --- Initialization ---');
  const emitHeadApply = (hydratePath) => {
    if (ownHead) {
      builder.add(hydratePath
        ? '// Adopt the delivered slice; when the run is absent (or this'
        + ' component\'s slice was not delivered) apply the head fresh instead —'
        + ' the adoption walk strips any stale delivery before returning null.'
        : '// Apply before mounting children so their heads prepend in front of'
        + ' this one — the deepest component\'s title is what document.title reads.');
      builder.add(hydratePath
        ? 'headNodes = adoptedHydration.headNodes || __wizzApplyHead(createHeadNodes(), ' + headLocLiteral + ');'
        : `headNodes = __wizzApplyHead(createHeadNodes(), ${headLocLiteral});`);
    }
    if (ownStyle) {
      builder.add(`const __wizzStyleNodes = __wizzApplyHead(createStyleNodes(), ${styleLocLiteral});`);
      builder.add('headNodes = headNodes ? headNodes.concat(__wizzStyleNodes) : __wizzStyleNodes;');
    }
  };
  const hydrateCreateCall = headActive
    ? 'const adoptedHydration = hydrate ? hydrateCreate(target, state, adoptSelf, headOwner) : null;'
    : 'const adoptedHydration = hydrate ? hydrateCreate(target, state, adoptSelf) : null;';
  if (!hydratable) {
    builder.add('const rootNode = create(ctx);')
          .add('const childComponents = rootNode.__wizzChildComponents;')
          .add('const listUpdates = rootNode.__wizzListUpdates;')
          .add('target.appendChild(rootNode);');
    if (ownHead || ownStyle) {
      emitHeadApply(false);
    }
    builder.add('rootNode.__wizzMountChildren();');
  } else {
    builder.add(hydrateCreateCall);
    if (hydratable && persistentVars.length > 0) {
      // Back to client storage as the source of truth. On the adopt path the
      // initial update pass below writes these over the verified markup; the
      // mismatch fallback re-enters mountComponent, whose script re-reads
      // storage. Restoring here is a no-op for plain mounts (hydrate false),
      // which never seeded in the first place.
      for (const declaration of persistentVars) {
        builder.add(`${declaration.name} = __wizzPersistHydration.${declaration.name};`);
      }
    }
    builder.add('if (hydrate && !adoptedHydration) return mountComponent(target, props);')
          .add('const rootNode = hydrate ? adoptedHydration.node : create(ctx);')
          .add('const childComponents = hydrate ? adoptedHydration.childComponents : rootNode.__wizzChildComponents;')
          .add('const listUpdates = hydrate ? adoptedHydration.listUpdates : rootNode.__wizzListUpdates;')
          .add('if (!hydrate) {')
          .indent();
    builder.add('target.appendChild(rootNode);');
    if (ownHead || ownStyle) {
      emitHeadApply(false);
    }
    builder.add('rootNode.__wizzMountChildren();');
    builder.dedent().add('} else {').indent();
    if (ownHead || ownStyle) {
      emitHeadApply(true);
    }
    builder.dedent().add('}');
  }

  const initialChanges = reactiveVars.map(decl => `${decl.name}: true`).join(', ');
      builder.add(`update(ctx, { ${initialChanges} });`)
        .add('isMounted = true;')
        .add('mountHooks.forEach((hook) => hook());');

  // 7. Return the public API (e.g., a way to unmount/destroy the component)
  builder.add('\nreturn {')
        .indent();

  if (props.length > 0) {
    // Receives new prop values from the parent. A missing key keeps the
    // current binding; an explicit `undefined` re-applies the declared
    // default, matching the mount-time contract. Values are compared with
    // Object.is so identical updates never rerender the child. The local
    // names use the reserved `__wizz` prefix, which prop names cannot use,
    // so a prop can never shadow the accumulator.
    builder.add('setProps(next) {')
          .indent()
          .add('if (isDestroyed) return;')
          .add('const __wizzChanges = {};');
    props.forEach(({ name, defaultValue }) => {
      builder.add(`if (${JSON.stringify(name)} in next) {`)
            .indent();
      if (defaultValue === null) {
        builder.add(`if (!Object.is(${name}, next.${name})) {`)
              .indent()
              .add(`${name} = next.${name};`)
              .add(`__wizzChanges.${name} = true;`)
              .dedent()
              .add('}');
      } else {
        builder.add(`const __wizzNext = next.${name} !== undefined ? next.${name} : (${defaultValue});`)
              .add(`if (!Object.is(${name}, __wizzNext)) {`)
              .indent()
              .add(`${name} = __wizzNext;`)
              .add(`__wizzChanges.${name} = true;`)
              .dedent()
              .add('}');
      }
      builder.dedent()
            .add('}');
    });
    builder.add('if (Object.keys(__wizzChanges).length > 0) queueUpdate(__wizzChanges);')
          .dedent()
          .add('},');
  }

  builder.add('destroy() {')
        .indent()
      .add('isDestroyed = true;')
      .add('destroyHooks.forEach((hook) => hook());')
      .add('childComponents.forEach((component) => component.destroy());');
  if (ownHead || ownStyle) {
    // Released after the child cascade so a child's head returns to the
    // document before this component's is removed; shared styles survive
    // until their last holder releases.
    builder.add('if (headNodes) __wizzReleaseHead(headNodes);');
  }
  builder.add('trackedListeners.forEach(({ node, eventName, handler }) => node.removeEventListener(eventName, handler));');
  if (hydratable) {
    // A self-adopted root (nested hydration) belongs to the parent's tree;
    // the parent's destroy removes it, so the child must leave it in place.
    // Fresh mounts and top-level adoption own their root and remove it.
    builder.add('if (!hydrate || !adoptSelf) target.removeChild(rootNode);');
  } else {
    builder.add('target.removeChild(rootNode);');
  }
  builder.dedent()
        .add('}')
        .dedent()
        .add('};');

  builder.dedent()
        .add('}');

  return builder.generate();
}

/**
 * Reports whether the template renders the named import. Component tags
 * cannot appear inside each bodies (the renderable gate refuses them), and
 * IfBlock.children aliases its consequent, so walking consequent plus
 * alternate covers every branch exactly once.
 */
function renderedImportNames(templateAST, name) {
  const scan = (node) => {
    if (node.type === 'Element') {
      if (node.name === name) return true;
      return (node.children || []).some((child) => scan(child));
    }
    if (node.type === 'IfBlock') {
      return (node.consequent || []).some(scan) || (node.alternate || []).some(scan);
    }
    return false;
  };
  return (templateAST.children || []).some(scan);
}

module.exports = { generateComponent };
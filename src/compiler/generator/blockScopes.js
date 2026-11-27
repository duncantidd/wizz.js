// src/compiler/generator/blockScopes.js
//
// Block scopes: the ownership model behind reactive `{#if}` branches and
// `on:` listeners inside `{#each}` items.
//
// Everything a branch creates belongs to a scope record:
//
//   { lists, drop, mounts, nodes }
//
//   - `lists`  block updaters (`(changed) => void`) for the each lists and
//              nested reactive if blocks inside the branch; the owning block
//              runs them while the branch is retained.
//   - `drop`   disposers (`(detach) => void`) for listeners, child component
//              instances, list records, and nested blocks.
//   - `mounts` deferred child-component mounts; they run once the branch's
//              nodes are attached to the document.
//   - `nodes`  the branch's own top-level DOM nodes, removed from the parent
//              when the branch is replaced.
//
// The component itself is the outermost scope: its disposers live in the
// factory-level `__wizzDrop` array, which destroy() runs with `detach` false
// (the root is removed as a whole, so individual nodes are left alone).
// Each-item records carry a `drop` array of their own for the same reason:
// a removed item must take its listeners and child component instances with
// it. A child inside an item mounts once the item's nodes are attached
// (deferred like a branch's `mounts`), receives setProps() from the record's
// update(), and keeps its identity when a keyed record moves.
//
// The functions below are emitted verbatim into generated modules through
// Function.prototype.toString (the pattern the head and persistence helpers
// use), so they must stay self-contained and flush-left.

function __wizzOn(node, eventName, handler) {
  node.addEventListener(eventName, handler);
  return () => node.removeEventListener(eventName, handler);
}

function __wizzDropScope(scope, parent) {
  for (const drop of scope.drop) drop(parent !== null);
  if (parent !== null) {
    for (const node of scope.nodes) parent.removeChild(node);
  }
}

function __wizzIfBlock(parent, anchor, test, makers, key, scope) {
  return {
    sync(changed, recheck, mounts) {
      const next = recheck ? (test() ? 1 : 0) : key;
      if (next === key) {
        if (scope) for (const update of scope.lists) update(changed);
        return;
      }
      const previous = scope;
      // Cleared first: if a disposer or the new branch throws, the block
      // holds no half-dropped scope that a later pass could drop twice.
      scope = null;
      key = next;
      if (previous) __wizzDropScope(previous, parent);
      if (!makers[next]) return;
      scope = makers[next](parent, anchor);
      if (mounts) mounts.push(...scope.mounts);
      else for (const mount of scope.mounts) mount();
    },
    drop(detach) {
      const previous = scope;
      scope = null;
      key = -1;
      if (previous) __wizzDropScope(previous, detach ? parent : null);
    }
  };
}

const isEventAttribute = (attribute) => attribute.name.startsWith('on:');

/** A reactive if block re-evaluates; one with no dependencies never changes. */
const isReactiveIf = (node) => node.type === 'IfBlock' && node.dependencies?.length > 0;

/**
 * Describes the block machinery a template needs, and numbers its reactive
 * if blocks. The create and hydration generators both call this, so the
 * branch-maker names they derive from the ids agree without being threaded
 * through the component generator.
 *
 * Only the root element's subtree is walked, matching what create() renders.
 * @param {Object} templateAST - The analyzed template AST.
 * @returns {{ifIds: Map<Object, number>, scopedListeners: boolean, needsDrop: boolean}}
 *   `ifIds` numbers reactive if blocks in template order; `scopedListeners`
 *   reports an `on:` directive inside a reactive branch or an each item (it
 *   attaches through `__wizzOn`); `needsDrop` reports that the component
 *   scope needs its `__wizzDrop` array.
 */
function analyzeBlocks(templateAST) {
  const ifIds = new Map();
  let scopedListeners = false;
  let listenersInEach = false;
  let componentsInEach = false;

  function walk(node, scoped, insideEach) {
    if (insideEach && node.componentId != null) componentsInEach = true;
    if (node.type === 'IfBlock') {
      const reactive = isReactiveIf(node);
      if (reactive) ifIds.set(node, ifIds.size + 1);
      // The parser's `children` alias repoints to the alternate at {:else},
      // so both branches are walked explicitly.
      (node.consequent || []).forEach((child) => walk(child, scoped || reactive, insideEach));
      (node.alternate || []).forEach((child) => walk(child, scoped || reactive, insideEach));
      return;
    }
    if (node.type === 'EachBlock') {
      (node.children || []).forEach((child) => walk(child, true, true));
      return;
    }
    if (node.type !== 'Element') return;
    if ((node.attributes || []).some(isEventAttribute)) {
      if (scoped) scopedListeners = true;
      if (insideEach) listenersInEach = true;
    }
    (node.children || []).forEach((child) => walk(child, scoped, insideEach));
  }

  const rootElement = (templateAST.children || []).find((node) => node.type === 'Element');
  if (rootElement) walk(rootElement, false, false);
  return { ifIds, scopedListeners, needsDrop: ifIds.size > 0 || listenersInEach || componentsInEach };
}

/** Reports whether an each body carries any `on:` directive. */
function eachHasListeners(eachNode) {
  const scan = (node) => node.type === 'Element'
    && ((node.attributes || []).some(isEventAttribute) || (node.children || []).some(scan));
  return (eachNode.children || []).some(scan);
}

/**
 * Reports whether an each body renders an imported component tag. Such
 * items own their child instances through the record's `drop` array, like
 * listeners. Component tags are recognized by the analyzer's `componentId`.
 */
function eachHasComponents(eachNode) {
  const scan = (node) => node.type === 'Element'
    && (node.componentId != null || (node.children || []).some(scan));
  return (eachNode.children || []).some(scan);
}

/**
 * The state-slice key of a component tag rendered inside an each item: the
 * tag's componentId and the item's position in the collection when it was
 * rendered, so every row's child gets its own slice. The server render and
 * the hydration walk both key by position (never by the author's item key,
 * which is arbitrary data), and the result is always `<digits>:<digits>`,
 * so it can never name a prototype property.
 * @param {Object} componentNode - The component tag.
 * @param {string} ordinalSource - Source of the item's numeric position.
 * @returns {string} Source of the key expression.
 */
const itemSliceKeySource = (componentNode, ordinalSource) => `${JSON.stringify(`${componentNode.componentId}:`)} + ${ordinalSource}`;

const makerName = (id, key) => `__wizzIfMake_${id}_${key}`;

/**
 * Source for the `recheck` argument of a block's sync(): true when one of the
 * test's dependencies changed in this pass.
 */
const ifRecheckSource = (node) => node.dependencies.map((name) => `__wizzChanged.${name}`).join(' || ');

module.exports = {
  __wizzOn,
  __wizzDropScope,
  __wizzIfBlock,
  analyzeBlocks,
  eachHasListeners,
  eachHasComponents,
  itemSliceKeySource,
  isEventAttribute,
  isReactiveIf,
  makerName,
  ifRecheckSource
};

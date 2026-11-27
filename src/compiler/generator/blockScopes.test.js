const assert = require('node:assert/strict');
const test = require('node:test');
const { assignNodeIds } = require('../analyzer/idAssigner');
const { analyzeDependencies } = require('../analyzer/dependencyAnalyzer');
const { parseComponent } = require('../parser');
const {
  __wizzOn,
  __wizzDropScope,
  __wizzIfBlock,
  analyzeBlocks,
  eachHasListeners,
  eachHasComponents,
  itemSliceKeySource,
  isReactiveIf,
  makerName,
  ifRecheckSource
} = require('./blockScopes');

const analyze = (source) => assignNodeIds(analyzeDependencies(parseComponent(source))).template;

// The emitted helpers must run exactly as their toString() source does: a
// generated module has no access to this file's closure.
const emitted = new Function(
  `${__wizzOn.toString()}\n${__wizzDropScope.toString()}\n${__wizzIfBlock.toString()}\nreturn { __wizzOn, __wizzDropScope, __wizzIfBlock };`
)();

function createParent() {
  return {
    childNodes: [],
    removed: [],
    insertBefore(node, reference) {
      const index = this.childNodes.indexOf(reference);
      this.childNodes.splice(index === -1 ? this.childNodes.length : index, 0, node);
    },
    removeChild(node) {
      const index = this.childNodes.indexOf(node);
      if (index === -1) throw new Error('NotFoundError: node is not a child');
      this.childNodes.splice(index, 1);
      this.removed.push(node);
    }
  };
}

// Builds a maker that inserts one labelled node and records what happens to
// its scope, so tests can observe ordering without a generated module.
function createMaker(label, log, extra = {}) {
  return (parent, anchor) => {
    const node = { label };
    parent.insertBefore(node, anchor);
    log.push(`make ${label}`);
    return {
      lists: [(changed) => log.push(`update ${label} ${Object.keys(changed).join(',')}`)],
      drop: [(detach) => log.push(`drop ${label} ${detach}`)],
      mounts: [() => log.push(`mount ${label}`)],
      nodes: [node],
      ...extra
    };
  };
}

function createBlock({ value = true, alternate = true } = {}) {
  const log = [];
  const parent = createParent();
  const anchor = { label: 'anchor' };
  parent.childNodes.push(anchor);
  const state = { value };
  const block = emitted.__wizzIfBlock(
    parent,
    anchor,
    () => state.value,
    [alternate ? createMaker('no', log) : null, createMaker('yes', log)],
    -1,
    null
  );
  return { block, log, parent, state, labels: () => parent.childNodes.map((node) => node.label) };
}

test('numbers reactive if blocks in template order and skips dependency-free ones', () => {
  const template = analyze(
    '<script>let a = 1; let b = 2; const fixed = 3;</script>'
    + '<main>{#if a === 1}<p>{#if b === 2}<b>x</b>{/if}</p>{:else}{#if fixed === 3}<i>y</i>{/if}{/if}{#if b === 1}<u>z</u>{/if}</main>'
  );
  const { ifIds, scopedListeners, needsDrop } = analyzeBlocks(template);
  const tests = [...ifIds.entries()].map(([node, id]) => [node.test, id]);
  assert.deepEqual(tests, [['a === 1', 1], ['b === 2', 2], ['b === 1', 3]]);
  assert.equal(scopedListeners, false);
  assert.equal(needsDrop, true);
});

test('a template with only dependency-free if blocks needs no block machinery', () => {
  const template = analyze("<script>const mode = 'a'; function go() {}</script><main>{#if mode === 'a'}<p on:click={go}>x</p>{/if}</main>");
  const result = analyzeBlocks(template);
  assert.equal(result.ifIds.size, 0);
  // The listener belongs to the component scope, as it always has.
  assert.equal(result.scopedListeners, false);
  assert.equal(result.needsDrop, false);
  assert.equal(isReactiveIf(template.children.find((node) => node.type === 'Element').children[0]), false);
});

test('reports scoped listeners inside reactive branches and each items', () => {
  const inBranch = analyzeBlocks(analyze('<script>let on = true; function go() {}</script><main>{#if on}<p on:click={go}>x</p>{/if}</main>'));
  assert.equal(inBranch.scopedListeners, true);
  assert.equal(inBranch.needsDrop, true);

  const inStaticInsideReactive = analyzeBlocks(analyze(
    "<script>let on = true; const k = 1; function go() {}</script><main>{#if on}{#if k === 1}<p on:click={go}>x</p>{/if}{/if}</main>"
  ));
  assert.equal(inStaticInsideReactive.scopedListeners, true);

  const inEach = analyzeBlocks(analyze('<script>let xs = []; function go() {}</script><ul>{#each xs as x}<li on:click={go}>{x}</li>{/each}</ul>'));
  assert.equal(inEach.ifIds.size, 0);
  assert.equal(inEach.scopedListeners, true);
  assert.equal(inEach.needsDrop, true);

  const plainEach = analyzeBlocks(analyze('<script>let xs = [];</script><ul>{#each xs as x}<li>{x}</li>{/each}</ul>'));
  assert.equal(plainEach.scopedListeners, false);
  assert.equal(plainEach.needsDrop, false);

  const outside = analyzeBlocks(analyze('<script>let n = 0; function go() {}</script><main><button on:click={go}>{n}</button></main>'));
  assert.deepEqual([outside.ifIds.size, outside.scopedListeners, outside.needsDrop], [0, false, false]);
});

test('only the rendered root element is analyzed, and a rootless template is safe', () => {
  assert.deepEqual([...analyzeBlocks({ children: [] }).ifIds], []);
  assert.equal(analyzeBlocks({}).needsDrop, false);
  // A second top-level element never renders, so its blocks get no id.
  const template = analyze('<script>let on = true;</script><main>a</main><aside>{#if on}<p>x</p>{/if}</aside>');
  assert.equal(analyzeBlocks(template).ifIds.size, 0);
});

test('eachHasListeners finds directives at any depth of the body', () => {
  const each = (body) => analyze(`<script>let xs = []; function go() {}</script><ul>{#each xs as x}${body}{/each}</ul>`)
    .children.find((node) => node.type === 'Element').children[0];
  assert.equal(eachHasListeners(each('<li>{x}</li>')), false);
  assert.equal(eachHasListeners(each('<li on:click={go}>{x}</li>')), true);
  assert.equal(eachHasListeners(each('<li><span><button on:click={go}>x</button></span></li>')), true);
});

test('eachHasComponents finds component tags at the item root or any depth', () => {
  const each = (body) => analyze(`<script>
import Row from "./Row.wizz";
let xs = [];
</script><ul>{#each xs as x}${body}{/each}</ul>`)
    .children.find((node) => node.type === 'Element').children[0];
  assert.equal(eachHasComponents(each('<li>{x}</li>')), false);
  assert.equal(eachHasComponents(each('<Row />')), true);
  assert.equal(eachHasComponents(each('<li><span><Row x={x} /></span></li>')), true);
  // An element merely named like a component is not one without the import.
  const unimported = analyze('<script>let xs = [];</script><ul>{#each xs as x}<li><Row /></li>{/each}</ul>')
    .children.find((node) => node.type === 'Element').children[0];
  assert.equal(eachHasComponents(unimported), false);
});

test('components in each items need the component-scope drop list', () => {
  const result = analyzeBlocks(analyze('<script>\nimport Row from "./Row.wizz";\nlet xs = [];\n</script><ul>{#each xs as x}<Row x={x} />{/each}</ul>'));
  assert.deepEqual([result.ifIds.size, result.scopedListeners, result.needsDrop], [0, false, true]);
  // A component outside any list keeps the plain child-list ownership.
  const outside = analyzeBlocks(analyze('<script>\nimport Row from "./Row.wizz";\n</script><main><Row /></main>'));
  assert.equal(outside.needsDrop, false);
});

test('item slice keys combine the componentId and the item position', () => {
  assert.equal(itemSliceKeySource({ componentId: 4 }, '__wizzOrdinal'), '"4:" + __wizzOrdinal');
  const key = new Function('__wizzOrdinal', `return ${itemSliceKeySource({ componentId: 12 }, '__wizzOrdinal')};`);
  assert.equal(key(0), '12:0');
  assert.equal(key(31), '12:31');
});

test('names makers by block id and branch key and builds the recheck guard', () => {
  assert.equal(makerName(3, 1), '__wizzIfMake_3_1');
  assert.equal(makerName(3, 0), '__wizzIfMake_3_0');
  assert.equal(ifRecheckSource({ dependencies: ['a'] }), '__wizzChanged.a');
  assert.equal(ifRecheckSource({ dependencies: ['a', 'b'] }), '__wizzChanged.a || __wizzChanged.b');
});

test('__wizzOn attaches the listener and returns its remover', () => {
  const calls = [];
  const node = {
    addEventListener: (name, handler) => calls.push(['add', name, handler]),
    removeEventListener: (name, handler) => calls.push(['remove', name, handler])
  };
  const handler = () => {};
  const remove = emitted.__wizzOn(node, 'click', handler);
  assert.deepEqual(calls, [['add', 'click', handler]]);
  remove();
  assert.deepEqual(calls[1], ['remove', 'click', handler]);
});

test('__wizzDropScope runs disposers before removing nodes, and only detaches with a parent', () => {
  const order = [];
  const parent = createParent();
  const node = { label: 'n' };
  parent.childNodes.push(node);
  const scope = { drop: [(detach) => order.push(`drop ${detach} ${parent.childNodes.length}`)], nodes: [node] };

  emitted.__wizzDropScope(scope, null);
  assert.deepEqual(order, ['drop false 1']);
  assert.equal(parent.childNodes.length, 1, 'no parent means the nodes stay');

  emitted.__wizzDropScope(scope, parent);
  // The disposer still saw the node attached.
  assert.deepEqual(order, ['drop false 1', 'drop true 1']);
  assert.deepEqual(parent.childNodes, []);
});

test('the first sync builds the selected branch in front of the anchor', () => {
  const { block, log, labels } = createBlock({ value: true });
  block.sync({}, true);
  assert.deepEqual(labels(), ['yes', 'anchor']);
  assert.deepEqual(log, ['make yes', 'mount yes']);
});

test('a changed test drops the old branch, detaching it, then builds the other', () => {
  const { block, log, state, parent, labels } = createBlock({ value: true });
  block.sync({}, true);
  log.length = 0;

  state.value = false;
  block.sync({ value: true }, true);
  assert.deepEqual(labels(), ['no', 'anchor']);
  assert.deepEqual(log, ['drop yes true', 'make no', 'mount no']);
  assert.deepEqual(parent.removed.map((node) => node.label), ['yes']);

  state.value = 'truthy';
  log.length = 0;
  block.sync({ value: true }, true);
  assert.deepEqual(labels(), ['yes', 'anchor']);
  assert.deepEqual(log, ['drop no true', 'make yes', 'mount yes']);
});

test('truthiness, not identity, selects the branch', () => {
  const { block, log, state } = createBlock({ value: 1 });
  block.sync({}, true);
  log.length = 0;
  for (const truthy of [2, 'x', {}, []]) {
    state.value = truthy;
    block.sync({ value: true }, true);
  }
  assert.deepEqual(log.filter((entry) => entry.startsWith('make')), [], 'truthy to truthy never rebuilds');
  for (const falsy of [0, '', null, undefined, NaN]) {
    state.value = falsy;
    block.sync({ value: true }, true);
  }
  assert.deepEqual(log.filter((entry) => entry.startsWith('make')), ['make no'], 'falsy to falsy never rebuilds');
});

test('a retained branch runs its inner updaters, with or without a recheck', () => {
  const { block, log, state } = createBlock({ value: true });
  block.sync({}, true);
  log.length = 0;

  block.sync({ other: true }, false);
  block.sync({ value: true }, true);
  assert.deepEqual(log, ['update yes other', 'update yes value']);

  // Without a recheck the test is not consulted at all, even if it changed.
  state.value = false;
  log.length = 0;
  block.sync({ other: true }, undefined);
  assert.deepEqual(log, ['update yes other']);
});

test('a missing alternate leaves nothing in the DOM and tolerates updates', () => {
  const { block, log, state, labels } = createBlock({ value: false, alternate: false });
  block.sync({}, true);
  assert.deepEqual(labels(), ['anchor']);
  assert.deepEqual(log, []);

  block.sync({ other: true }, false);
  assert.deepEqual(log, [], 'an empty branch has no updaters to run');

  state.value = true;
  block.sync({ value: true }, true);
  assert.deepEqual(labels(), ['yes', 'anchor']);

  state.value = false;
  block.sync({ value: true }, true);
  assert.deepEqual(labels(), ['anchor']);
  assert.deepEqual(log, ['make yes', 'mount yes', 'drop yes true']);
});

test('mounts are deferred into the given list instead of running', () => {
  const { block, log } = createBlock({ value: true });
  const deferred = [];
  block.sync({}, true, deferred);
  assert.deepEqual(log, ['make yes']);
  assert.equal(deferred.length, 1);
  deferred[0]();
  assert.deepEqual(log, ['make yes', 'mount yes']);
});

test('drop(false) releases the scope without touching the DOM; drop(true) detaches', () => {
  const kept = createBlock({ value: true });
  kept.block.sync({}, true);
  kept.log.length = 0;
  kept.block.drop(false);
  assert.deepEqual(kept.log, ['drop yes false']);
  assert.deepEqual(kept.labels(), ['yes', 'anchor']);

  const detached = createBlock({ value: true });
  detached.block.sync({}, true);
  detached.block.drop(true);
  assert.deepEqual(detached.labels(), ['anchor']);
});

test('dropping twice, or dropping an empty block, is a no-op', () => {
  const { block, log } = createBlock({ value: true });
  block.drop(true);
  assert.deepEqual(log, []);
  block.sync({}, true);
  log.length = 0;
  block.drop(true);
  block.drop(true);
  block.drop(false);
  assert.deepEqual(log, ['drop yes true']);
});

test('a dropped block rebuilds on its next recheck instead of trusting a stale key', () => {
  const { block, log, labels } = createBlock({ value: true });
  block.sync({}, true);
  block.drop(true);
  log.length = 0;
  block.sync({}, true);
  assert.deepEqual(log, ['make yes', 'mount yes']);
  assert.deepEqual(labels(), ['yes', 'anchor']);
});

test('adopts a given key and scope without calling a maker', () => {
  const log = [];
  const parent = createParent();
  const adopted = { label: 'adopted' };
  const anchor = { label: 'anchor' };
  parent.childNodes.push(adopted, anchor);
  const state = { value: true };
  const scope = { lists: [() => log.push('adopted update')], drop: [() => log.push('adopted drop')], mounts: [], nodes: [adopted] };
  const block = emitted.__wizzIfBlock(parent, anchor, () => state.value, [createMaker('no', log), createMaker('yes', log)], 1, scope);

  block.sync({ value: true }, true);
  assert.deepEqual(log, ['adopted update'], 'the delivered branch is kept while the test agrees');

  state.value = false;
  log.length = 0;
  block.sync({ value: true }, true);
  assert.deepEqual(log, ['adopted drop', 'make no', 'mount no']);
  assert.deepEqual(parent.childNodes.map((node) => node.label), ['no', 'anchor']);
});

test('a throwing maker leaves the block empty rather than holding a dropped scope', () => {
  const log = [];
  const parent = createParent();
  const anchor = { label: 'anchor' };
  parent.childNodes.push(anchor);
  const state = { value: true };
  const failing = () => { throw new Error('branch failed'); };
  const block = emitted.__wizzIfBlock(parent, anchor, () => state.value, [failing, createMaker('yes', log)], -1, null);
  block.sync({}, true);
  log.length = 0;

  state.value = false;
  assert.throws(() => block.sync({ value: true }, true), /branch failed/);
  assert.deepEqual(log, ['drop yes true'], 'the old branch was dropped exactly once');

  // Neither a later pass nor destroy drops the old scope again.
  block.sync({ other: true }, false);
  block.drop(false);
  assert.deepEqual(log, ['drop yes true']);

  // Flipping back recovers.
  state.value = true;
  block.sync({ value: true }, true);
  assert.deepEqual(parent.childNodes.map((node) => node.label), ['yes', 'anchor']);
});

test('a throwing test leaves the current branch in place', () => {
  const { block, log, labels } = createBlock({ value: true });
  block.sync({}, true);
  log.length = 0;
  const parent = createParent();
  const failing = emitted.__wizzIfBlock(parent, {}, () => { throw new Error('test failed'); }, [null, createMaker('yes', log)], -1, null);
  assert.throws(() => failing.sync({}, true), /test failed/);
  assert.deepEqual(log, []);
  assert.deepEqual(labels(), ['yes', 'anchor']);
});

test('repeated toggling never accumulates nodes or scopes', () => {
  const { block, log, state, parent, labels } = createBlock({ value: true });
  block.sync({}, true);
  for (let i = 0; i < 500; i++) {
    state.value = !state.value;
    block.sync({ value: true }, true);
  }
  assert.deepEqual(labels(), ['yes', 'anchor']);
  assert.equal(log.filter((entry) => entry.startsWith('make')).length, 501);
  assert.equal(log.filter((entry) => entry.startsWith('drop')).length, 500);
  assert.equal(parent.removed.length, 500);
});

test('the emitted helpers reference nothing outside their own source', () => {
  for (const helper of [__wizzOn, __wizzDropScope, __wizzIfBlock]) {
    const source = helper.toString();
    assert.match(source, /^function __wizz/);
    assert.doesNotMatch(source, /require\(|module\.|innerHTML|eval\(|new Function/);
  }
  // __wizzIfBlock's only free name is the scope dropper emitted beside it.
  assert.match(__wizzIfBlock.toString(), /__wizzDropScope\(previous, parent\)/);
});

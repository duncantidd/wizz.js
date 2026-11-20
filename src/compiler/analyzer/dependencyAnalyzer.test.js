const assert = require('node:assert/strict');
const test = require('node:test');
const { analyzeDependencies } = require('./dependencyAnalyzer');
const { parseComponent } = require('../parser');

test('tags expressions with the reactive state they depend on', () => {
  const payload = parseComponent(
    '<script>let count = 0; let user = 1; const title = 2;</script><main>{count + count}<p>{user.name + count}</p><span>{title}</span></main>'
  );
  const analyzedPayload = analyzeDependencies(payload);
  const [countExpression, paragraph, span] = analyzedPayload.template.children[0].children;

  assert.strictEqual(analyzedPayload, payload);
  assert.deepEqual(countExpression.dependencies, ['count']);
  assert.deepEqual(paragraph.children[0].dependencies, ['user', 'count']);
  assert.deepEqual(span.children[0].dependencies, []);
});

test('tags nested expressions throughout the template tree', () => {
  const payload = parseComponent(
    '<script>let user = 1; let total = 0;</script><section><div><p>{user.name}</p></div><footer>{total * 2}</footer></section>'
  );
  const section = analyzeDependencies(payload).template.children[0];

  assert.deepEqual(section.children[0].children[0].children[0].dependencies, ['user']);
  assert.deepEqual(section.children[1].children[0].dependencies, ['total']);
});

test('tags expressions in both branches of an if block with an else', () => {
  // The parser's `children` alias repoints to the alternate at {:else}, so
  // both branches must be walked explicitly or consequent content in
  // if-with-else templates would never receive dependency metadata (and the
  // generated update code would never rerender it).
  const payload = parseComponent(
    '<script>let flag = false; let on = 1; let off = 2;</script><main>{#if flag}<p>{on}</p>{:else}<span>{off}</span>{/if}</main>'
  );
  const block = analyzeDependencies(payload).template.children[0].children[0];

  assert.deepEqual(block.consequent[0].children[0].dependencies, ['on']);
  assert.deepEqual(block.alternate[0].children[0].dependencies, ['off']);
});

test('leaves non-expression template nodes unchanged', () => {
  const payload = parseComponent('<script>let count = 0;</script><p>Static text</p>');
  const paragraph = analyzeDependencies(payload).template.children[0];

  assert.equal(paragraph.dependencies, undefined);
  assert.equal(paragraph.children[0].dependencies, undefined);
});
test('treats declared props as reactive dependencies', () => {
  const payload = analyzeDependencies(parseComponent(
    "<script>export let name = 'Guest';</script><h1>Hello {name}</h1>"
  ));
  const heading = payload.template.children[0];

  assert.deepEqual(heading.children[1].dependencies, ['name']);
});

test('tracks prop dependencies in dynamic attributes', () => {
  const payload = analyzeDependencies(parseComponent(
    "<script>export let start = 0;</script><p class={start}>x</p>"
  ));
  const paragraph = payload.template.children[0];

  assert.deepEqual(paragraph.attributes[0].dependencies, ['start']);
});

test('tags if blocks with the reactive dependencies of their test', () => {
  const payload = analyzeDependencies(parseComponent(
    "<script>let a = 1; let b = { c: 2 }; const fixed = 3;</script>"
    + "<main>{#if a === b.c}<p>x</p>{:else}<i>y</i>{/if}{#if fixed === 3}<u>z</u>{/if}{#if a + a === 2}<s>w</s>{/if}</main>"
  ));
  const [both, constant, repeated] = payload.template.children[0].children;

  // Member access depends on its root object; each name is listed once.
  assert.deepEqual(both.dependencies, ['a', 'b']);
  assert.deepEqual(repeated.dependencies, ['a']);
  // A test reading no reactive state gets an empty array, never undefined:
  // the generators treat that as "selected once, at mount".
  assert.deepEqual(constant.dependencies, []);
});

test('still analyzes both branches of an if block after tagging its test', () => {
  const payload = analyzeDependencies(parseComponent(
    "<script>let open = true; let label = 'a'; export let tone = 'x';</script>"
    + "<main>{#if open}<p title={tone}>{label}</p>{:else}<i>{tone}</i>{/if}</main>"
  ));
  const block = payload.template.children[0].children[0];

  assert.deepEqual(block.dependencies, ['open']);
  assert.deepEqual(block.consequent[0].attributes[0].dependencies, ['tone']);
  assert.deepEqual(block.consequent[0].children[0].dependencies, ['label']);
  assert.deepEqual(block.alternate[0].children[0].dependencies, ['tone']);
});

test('a nested if block and an if test over a prop are tagged too', () => {
  const payload = analyzeDependencies(parseComponent(
    "<script>export let visible = true; let inner = 1;</script>"
    + "<main>{#if visible}<div>{#if inner === 1}<b>x</b>{/if}</div>{/if}</main>"
  ));
  const outer = payload.template.children[0].children[0];

  assert.deepEqual(outer.dependencies, ['visible']);
  assert.deepEqual(outer.consequent[0].children[0].dependencies, ['inner']);
});

test('conditional expressions depend on the test and on every branch', () => {
  // The branch not taken at mount must be wired too: flipping the test
  // selects it, and an update guard keyed only on the test would then render
  // a stale value from the other branch's state.
  const payload = analyzeDependencies(parseComponent(
    "<script>let n = 0; let one = 'a'; let many = 'b'; const fixed = 'c';</script>"
    + "<p>{n === 0 ? fixed : n === 1 ? one : many}</p>"
  ));
  assert.deepEqual(payload.template.children[0].children[0].dependencies, ['n', 'one', 'many']);
});

test('logical and unary operands are dependencies, short-circuited or not', () => {
  const payload = analyzeDependencies(parseComponent(
    "<script>let a = 0; let b = 1; let c = 2;</script>"
    + "<p>{!a && b || -c}</p><p>{true && null}</p>"
  ));
  const [first, second] = payload.template.children;
  assert.deepEqual(first.children[0].dependencies, ['a', 'b', 'c']);
  // `true`/`false`/`null` are literals, never treated as names.
  assert.deepEqual(second.children[0].dependencies, []);
});

test('calls depend on their arguments and on a reactive callee, not on plain functions', () => {
  const payload = analyzeDependencies(parseComponent(
    "<script>let entries = []; let formatter = (x) => x; let user = { name: 'a' };"
    + " function plural(n) { return n === 1 ? '' : 's'; }</script>"
    + "<p>{plural(entries.length)}</p><p>{formatter(1)}</p><p>{user.name.toUpperCase()}</p><p>{plural(1)}</p>"
  ));
  const [args, callee, method, none] = payload.template.children;
  assert.deepEqual(args.children[0].dependencies, ['entries']);
  assert.deepEqual(callee.children[0].dependencies, ['formatter']);
  assert.deepEqual(method.children[0].dependencies, ['user']);
  // A function reading state internally is invisible to the analyzer: with
  // no reactive argument the call is evaluated at mount and never again.
  assert.deepEqual(none.children[0].dependencies, []);
});

test('new expression forms are tracked in dynamic attributes and if tests', () => {
  const payload = analyzeDependencies(parseComponent(
    "<script>let items = []; let active = false;</script>"
    + "<ul class={items.length === 0 ? 'entries is-empty' : 'entries'}>{#if !active && items.length > 0}<li>x</li>{/if}</ul>"
  ));
  const list = payload.template.children[0];
  assert.deepEqual(list.attributes[0].dependencies, ['items']);
  assert.deepEqual(list.children[0].dependencies, ['active', 'items']);
});

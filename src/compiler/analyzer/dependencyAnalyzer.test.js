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

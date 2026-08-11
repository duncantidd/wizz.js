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

test('leaves non-expression template nodes unchanged', () => {
  const payload = parseComponent('<script>let count = 0;</script><p>Static text</p>');
  const paragraph = analyzeDependencies(payload).template.children[0];

  assert.equal(paragraph.dependencies, undefined);
  assert.equal(paragraph.children[0].dependencies, undefined);
});
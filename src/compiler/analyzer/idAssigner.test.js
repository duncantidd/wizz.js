const assert = require('node:assert/strict');
const test = require('node:test');
const { analyzeDependencies } = require('./dependencyAnalyzer');
const { assignNodeIds } = require('./idAssigner');
const { parseComponent } = require('../parser');

const getAttribute = (node, name) => node.attributes.find((attribute) => attribute.name === name);

test('adds sequential IDs to elements with immediate reactive expression children', () => {
  const payload = analyzeDependencies(parseComponent(
    '<script>let count = 0; let user = 1;</script><main><h1>{count}</h1><p>{user.name} {count}</p></main>'
  ));
  const assignedPayload = assignNodeIds(payload);
  const main = assignedPayload.template.children[0];
  const [heading, paragraph] = main.children;

  assert.strictEqual(assignedPayload, payload);
  assert.equal(getAttribute(main, 'data-wizz-id'), undefined);
  assert.deepEqual(getAttribute(heading, 'data-wizz-id'), {
    name: 'data-wizz-id',
    value: '1'
  });
  assert.deepEqual(getAttribute(paragraph, 'data-wizz-id'), {
    name: 'data-wizz-id',
    value: '2'
  });
  assert.equal(paragraph.attributes.filter((attribute) => attribute.name === 'data-wizz-id').length, 1);
});

test('does not mark ancestors or elements with only non-reactive expressions', () => {
  const payload = analyzeDependencies(parseComponent(
    '<script>let count = 0; const title = 1;</script><section><div><p>{count}</p></div><span>{title}</span></section>'
  ));
  const section = assignNodeIds(payload).template.children[0];
  const [container, span] = section.children;
  const paragraph = container.children[0];

  assert.equal(getAttribute(section, 'data-wizz-id'), undefined);
  assert.equal(getAttribute(container, 'data-wizz-id'), undefined);
  assert.deepEqual(getAttribute(paragraph, 'data-wizz-id'), {
    name: 'data-wizz-id',
    value: '1'
  });
  assert.equal(getAttribute(span, 'data-wizz-id'), undefined);
});

test('does not duplicate IDs when called more than once for the same payload', () => {
  const payload = analyzeDependencies(parseComponent('<script>let count = 0;</script><p>{count}</p>'));
  const paragraph = assignNodeIds(payload).template.children[0];

  assignNodeIds(payload);

  assert.deepEqual(paragraph.attributes.filter((attribute) => attribute.name === 'data-wizz-id'), [
    { name: 'data-wizz-id', value: '1' }
  ]);
});
test('assigns componentIds to imported component tags instead of data-wizz-id', () => {
  const payload = analyzeDependencies(parseComponent(
    "<script>\nimport Counter from './Counter.wizz';\nlet start = 0;\n</script>"
    + '<main><Counter start={start} label="Total" /></main>'
  ));
  const assigned = assignNodeIds(payload);
  const main = assigned.template.children[0];
  const componentTag = main.children[0];

  assert.equal(componentTag.name, 'Counter');
  assert.equal(componentTag.componentId, 1);
  assert.equal(getAttribute(componentTag, 'data-wizz-id'), undefined);

  const sibling = analyzeDependencies(parseComponent(
    "<script>\nimport A from './A.wizz';\nimport B from './B.wizz';\n</script><main><A /><B /></main>"
  ));
  const [tagA, tagB] = assignNodeIds(sibling).template.children[0].children;
  assert.equal(tagA.componentId, 1);
  assert.equal(tagB.componentId, 2);
});

test('keeps assigning element data-wizz-ids around component tags', () => {
  const payload = analyzeDependencies(parseComponent(
    "<script>\nimport Counter from './Counter.wizz';\nlet count = 0;\n</script>"
    + '<main><Counter /><p>{count}</p></main>'
  ));
  const main = assignNodeIds(payload).template.children[0];
  const [componentTag, paragraph] = main.children;

  assert.equal(componentTag.componentId, 1);
  assert.deepEqual(getAttribute(paragraph, 'data-wizz-id'), { name: 'data-wizz-id', value: '1' });
});

test('ignores same-named tags that were not imported', () => {
  const payload = analyzeDependencies(parseComponent('<main><Counter /></main>'));
  const counter = assignNodeIds(payload).template.children[0].children[0];

  assert.equal(counter.componentId, undefined);
});

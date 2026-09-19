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

test('assigns ids inside the consequent of an if block that has an else', () => {
  // The parser's `children` alias repoints to the alternate at {:else}, so a
  // children-only walk would leave consequent elements without data-wizz-id
  // and consequent component tags without a componentId ("Component <Counter>
  // is missing its componentId" at generation time).
  const payload = analyzeDependencies(parseComponent(
    "<script>\nimport Counter from './Counter.wizz';\nlet flag = false; let count = 0;\n</script>"
    + '<main>{#if flag}<Counter start={count} /><p>{count}</p>{:else}<p>off</p>{/if}</main>'
  ));
  const main = assignNodeIds(payload).template.children[0];
  const block = main.children[0];

  assert.equal(block.consequent[0].componentId, 1);
  assert.deepEqual(getAttribute(block.consequent[1], 'data-wizz-id'), {
    name: 'data-wizz-id',
    value: '1'
  });
});

test('stamps the style scope on every rendered element of styled components', () => {
  const payload = analyzeDependencies(parseComponent(
    '<script>let count = 0;</script><main><h2>{count}</h2><p>Static</p></main><wizz:style>h2 { font-size: 30px }</wizz:style>'
  ));
  const assigned = assignNodeIds(payload);
  const main = assigned.template.children[0];
  const [heading, paragraph] = main.children;
  const scope = assigned.style.scope;

  assert.equal(getAttribute(main, 'data-wizz-s').value, scope);
  assert.equal(getAttribute(heading, 'data-wizz-s').value, scope);
  assert.equal(getAttribute(paragraph, 'data-wizz-s').value, scope);
  // Reactive IDs are stamped alongside the scope attribute.
  assert.deepEqual(getAttribute(heading, 'data-wizz-id'), { name: 'data-wizz-id', value: '1' });
  // The scope attribute precedes the reactive one in emission order.
  assert.deepEqual(heading.attributes.map((attribute) => attribute.name),
    ['data-wizz-s', 'data-wizz-id']);
});

test('components without a style block receive no scope attributes', () => {
  const payload = analyzeDependencies(parseComponent(
    '<script>let count = 0;</script><main><h2>{count}</h2></main>'
  ));
  const main = assignNodeIds(payload).template.children[0];
  const heading = main.children[0];

  assert.equal(payload.style, null);
  assert.equal(getAttribute(main, 'data-wizz-s'), undefined);
  assert.equal(getAttribute(heading, 'data-wizz-s'), undefined);
  assert.deepEqual(getAttribute(heading, 'data-wizz-id'), { name: 'data-wizz-id', value: '1' });
});

test('imported component tags never receive the scope attribute', () => {
  const payload = analyzeDependencies(parseComponent(
    '<script>import Counter from "./Counter.wizz";</script><main><Counter /></main><wizz:style>main { padding: 0 }</wizz:style>'
  ));
  const main = assignNodeIds(payload).template.children[0];
  const counterTag = main.children[0];

  assert.equal(counterTag.componentId, 1);
  assert.equal(getAttribute(counterTag, 'data-wizz-s'), undefined);
  assert.equal(getAttribute(main, 'data-wizz-s').value, payload.style.scope);
});

test('an author-written data-wizz-s attribute wins over the generated value', () => {
  const payload = analyzeDependencies(parseComponent(
    '<main data-wizz-s="custom"><p>Hi</p></main><wizz:style>p { color: red }</wizz:style>'
  ));
  const main = assignNodeIds(payload).template.children[0];

  assert.equal(getAttribute(main, 'data-wizz-s').value, 'custom');
  assert.equal(getAttribute(main.children[0], 'data-wizz-s').value, payload.style.scope);
});

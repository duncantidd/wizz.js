const assert = require('node:assert/strict');
const test = require('node:test');
const { generateUpdateFunction } = require('./updateGenerator');

function createUpdate(template, elements, scope = {}) {
  const document = {
    querySelector(selector) {
      return elements[selector] || null;
    }
  };
  const names = Object.keys(scope);
  const update = new Function('document', ...names, `${generateUpdateFunction(template)}\nreturn update;`)(
    document,
    ...names.map((name) => scope[name])
  );

  return update;
}

test('updates the exact expression child when its dependency changes', () => {
  const target = {
    childNodes: [{ nodeValue: 'Static' }, { nodeValue: '' }, { nodeValue: '' }]
  };
  const update = createUpdate({
    type: 'Root',
    children: [{
      type: 'Element',
      name: 'main',
      attributes: [],
      children: [{
        type: 'Element',
        name: 'p',
        attributes: [{ name: 'data-wizz-id', value: '1' }],
        children: [
          { type: 'Text', value: 'Static' },
          { type: 'Expression', value: 'count + 1', dependencies: ['count'] },
          { type: 'Expression', value: 'title', dependencies: ['title'] }
        ]
      }]
    }]
  }, {
    '[data-wizz-id="1"]': target
  }, {
    count: 4,
    title: 'Total'
  });

  update({}, { count: true });

  assert.equal(target.childNodes[0].nodeValue, 'Static');
  assert.equal(target.childNodes[1].nodeValue, '5');
  assert.equal(target.childNodes[2].nodeValue, '');
});

test('generates an update block for every dependency of one expression', () => {
  const target = { childNodes: [{ nodeValue: '' }] };
  const update = createUpdate({
    type: 'Root',
    children: [{
      type: 'Element',
      name: 'p',
      attributes: [{ name: 'data-wizz-id', value: '2' }],
      children: [{
        type: 'Expression',
        value: 'user.name + count',
        dependencies: ['user', 'count']
      }]
    }]
  }, {
    '[data-wizz-id="2"]': target
  }, {
    user: { name: 'Ada' },
    count: 2
  });

  update({}, { user: true });
  assert.equal(target.childNodes[0].nodeValue, 'Ada2');

  target.childNodes[0].nodeValue = '';
  update({}, { count: true });
  assert.equal(target.childNodes[0].nodeValue, 'Ada2');
});

test('does not emit DOM queries for templates without reactive expressions', () => {
  const source = generateUpdateFunction({
    type: 'Root',
    children: [{
      type: 'Element',
      name: 'p',
      attributes: [],
      children: [{ type: 'Text', value: 'Static' }]
    }]
  });

  assert.doesNotMatch(source, /querySelector/);
  assert.doesNotThrow(() => new Function(`${source}\nreturn update;`));
});
test('routes reactive prop changes to component instances through setProps', () => {
  const calls = [];
  const instance = { setProps(next) { calls.push({ ...next }); } };
  const update = createUpdate({
    type: 'Root',
    children: [{
      type: 'Element',
      name: 'main',
      attributes: [],
      children: [{
        type: 'Element',
        name: 'Counter',
        componentId: 1,
        attributes: [
          { name: 'start', value: 'count', dynamic: true, dependencies: ['count'] },
          { name: 'label', value: 'Total' }
        ],
        children: []
      }]
    }]
  }, {}, { count: 9, component_1: instance });

  update({}, { count: true });
  update({}, { other: true });

  assert.deepEqual(calls, [{ start: 9 }]);
});

test('skips setProps when the instance has not mounted or the attribute is static', () => {
  const update = createUpdate({
    type: 'Root',
    children: [{
      type: 'Element',
      name: 'main',
      attributes: [],
      children: [{
        type: 'Element',
        name: 'Counter',
        componentId: 1,
        attributes: [
          { name: 'start', value: 'count', dynamic: true, dependencies: ['count'] },
          { name: 'label', value: 'total', dynamic: true, dependencies: [] }
        ],
        children: []
      }]
    }]
  }, {}, { count: 2, component_1: null });

  // No mounted instance: the null guard makes this a no-op instead of a crash.
  assert.doesNotThrow(() => update({}, { count: true }));

  const source = generateUpdateFunction({
    type: 'Root',
    children: [{
      type: 'Element',
      name: 'main',
      attributes: [],
      children: [{
        type: 'Element',
        name: 'Counter',
        componentId: 1,
        attributes: [{ name: 'label', value: 'total', dynamic: true, dependencies: [] }],
        children: []
      }]
    }]
  });
  assert.doesNotMatch(source, /setProps/);
});

test('emits setProps for component tags inside conditional branches', () => {
  const calls = [];
  const instance = { setProps(next) { calls.push({ ...next }); } };
  const update = createUpdate({
    type: 'Root',
    children: [{
      type: 'IfBlock',
      test: 'visible',
      consequent: [{
        type: 'Element',
        name: 'Counter',
        componentId: 1,
        attributes: [{ name: 'start', value: 'count', dynamic: true, dependencies: ['count'] }],
        children: []
      }],
      alternate: null
    }]
  }, {}, { count: 5, component_1: instance });

  update({}, { count: true });

  assert.deepEqual(calls, [{ start: 5 }]);
});

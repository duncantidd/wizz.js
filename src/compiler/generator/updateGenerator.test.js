const assert = require('node:assert/strict');
const test = require('node:test');
const { generateUpdateFunction, collectUpdateTargets } = require('./updateGenerator');
const { __wizzAttr } = require('./attributePolicy');

// Everything update() closes over is supplied by name: reactive bindings,
// component instances, and the __wizzTarget_N variables create() would assign.
function createUpdate(template, scope = {}) {
  const names = Object.keys(scope);
  return new Function(...names, `${__wizzAttr.toString()}\n${generateUpdateFunction(template)}\nreturn __wizzUpdate;`)(
    ...names.map((name) => scope[name])
  );
}

const element = (name, children = [], attributes = []) => ({ type: 'Element', name, attributes, children });
const expression = (value, dependencies = [value]) => ({ type: 'Expression', value, dependencies });
const reactiveAttribute = (name, value) => ({ name, value, dynamic: true, dependencies: [value] });
const root = (...children) => ({ type: 'Root', children });

test('updates the exact expression text node when its dependency changes', () => {
  const countText = { nodeValue: '' };
  const titleText = { nodeValue: '' };
  const update = createUpdate(root(element('main', [
    element('p', [
      { type: 'Text', value: 'Static' },
      expression('count + 1', ['count']),
      expression('title')
    ])
  ])), {
    __wizzTarget_1: countText,
    __wizzTarget_2: titleText,
    count: 4,
    title: 'Total'
  });

  update({}, { count: true });

  assert.equal(countText.nodeValue, '5');
  assert.equal(titleText.nodeValue, '');
});

test('generates an update block for every dependency of one expression', () => {
  const text = { nodeValue: '' };
  const update = createUpdate(root(element('p', [expression('user.name + count', ['user', 'count'])])), {
    __wizzTarget_1: text,
    user: { name: 'Ada' },
    count: 2
  });

  update({}, { user: true });
  assert.equal(text.nodeValue, 'Ada2');

  text.nodeValue = '';
  update({}, { count: true });
  assert.equal(text.nodeValue, 'Ada2');
});

test('assigns value, checked, and disabled as properties and the rest as attributes', () => {
  const input = { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
  const update = createUpdate(root(element('input', [], [
    reactiveAttribute('value', 'draft'),
    reactiveAttribute('title', 'hint')
  ])), { __wizzTarget_1: input, draft: 'x', hint: 7 });

  update({}, { draft: true, hint: true });

  assert.equal(input.value, 'x');
  assert.deepEqual(input.attributes, { title: '7' });
});

test('emits no target writes for templates without reactive content', () => {
  const source = generateUpdateFunction(root(element('p', [{ type: 'Text', value: 'Static' }])));

  assert.doesNotMatch(source, /__wizzTarget|querySelector/);
  assert.doesNotThrow(() => new Function(`${source}\nreturn __wizzUpdate;`));
});

test('writes through captured targets and never queries the DOM', () => {
  const source = generateUpdateFunction(root(element('p', [expression('count')], [
    { name: 'data-wizz-id', value: '1' },
    reactiveAttribute('title', 'count')
  ])));

  assert.match(source, /__wizzAttr\(__wizzTarget_1, "title", count\);/);
  assert.match(source, /__wizzTarget_2\.nodeValue = String\(count\);/);
  assert.doesNotMatch(source, /querySelector|childNodes|__wizzRoot|data-wizz-id/);
});

test('guards writes inside a branch and only those', () => {
  const template = root(element('main', [
    { type: 'IfBlock', test: 'open', consequent: [element('p', [expression('count')], [reactiveAttribute('title', 'count')])], alternate: [expression('other')] },
    expression('count')
  ]));
  const update = createUpdate(template, {
    __wizzTarget_1: undefined,
    __wizzTarget_2: undefined,
    __wizzTarget_3: undefined,
    __wizzTarget_4: { nodeValue: '' },
    count: 1,
    other: 2
  });

  // An untaken branch leaves its targets unassigned: skipping them must not
  // abort the write that follows.
  assert.doesNotThrow(() => update({}, { count: true, other: true }));

  const source = generateUpdateFunction(template);
  assert.match(source, /if \(__wizzTarget_1\) __wizzAttr\(__wizzTarget_1, /);
  assert.match(source, /if \(__wizzTarget_3\) __wizzTarget_3\.nodeValue/);
  assert.match(source, /^\s*__wizzTarget_4\.nodeValue/m);
});

test('collectUpdateTargets numbers each reactive node once in template order', () => {
  const paragraph = element('p', [expression('a'), expression('b')], [reactiveAttribute('title', 'a')]);
  const { names, conditional } = collectUpdateTargets(root(element('main', [paragraph])));

  assert.deepEqual([...names.values()], ['__wizzTarget_1', '__wizzTarget_2', '__wizzTarget_3']);
  assert.equal(names.get(paragraph), '__wizzTarget_1');
  assert.equal(names.get(paragraph.children[1]), '__wizzTarget_3');
  assert.equal(conditional.size, 0);
});

test('collectUpdateTargets skips static content, list bodies, and component tags', () => {
  const { names } = collectUpdateTargets(root(element('main', [
    { type: 'Text', value: 'x' },
    expression('literal', []),
    element('p', [], [{ name: 'title', value: 'x', dynamic: true, dependencies: [] }]),
    { type: 'EachBlock', item: 'row', collection: 'rows', children: [element('li', [expression('row')])] },
    { type: 'Element', name: 'Counter', componentId: 1, attributes: [reactiveAttribute('start', 'count')], children: [] }
  ])));

  assert.equal(names.size, 0);
});

test('collectUpdateTargets marks both branches, and their descendants, as conditional', () => {
  const taken = expression('a');
  const nested = expression('b');
  const { names, conditional } = collectUpdateTargets(root(element('main', [{
    type: 'IfBlock',
    test: 'open',
    // The parser aliases children to the most recent branch.
    children: [element('i', [nested])],
    consequent: [taken],
    alternate: [element('i', [nested])]
  }])));

  assert.equal(names.size, 2);
  assert.ok(conditional.has(taken));
  assert.ok(conditional.has(nested));
});

test('only the rendered root element contributes targets', () => {
  const template = root(
    expression('before'),
    element('main', [expression('count')]),
    element('aside', [expression('after')])
  );

  // create() ignores everything but the first element, so a write to these
  // would dereference a variable nothing assigned.
  assert.equal(collectUpdateTargets(template).names.size, 1);
  assert.doesNotThrow(() => createUpdate(template, { __wizzTarget_1: { nodeValue: '' }, count: 1, before: 2, after: 3 })({}, { before: true, count: true, after: true }));
});

test('an empty template generates an update with no writes', () => {
  assert.equal(collectUpdateTargets(root()).names.size, 0);
  assert.doesNotThrow(() => createUpdate(root())({}, {}));
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
  }, { count: 9, __wizzComponent_1: instance });

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
  }, { count: 2, __wizzComponent_1: null });

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
      type: 'Element',
      name: 'main',
      attributes: [],
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
    }]
  }, { count: 5, __wizzComponent_1: instance });

  update({}, { count: true });

  assert.deepEqual(calls, [{ start: 5 }]);
});

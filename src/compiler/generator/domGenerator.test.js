const assert = require('node:assert/strict');
const test = require('node:test');
const { generateCreateFunction } = require('./domGenerator');

function createDocument() {
  const createNode = (type, value) => ({
    type,
    ...(value === undefined ? {} : { value }),
    attributes: {},
    children: [],
    setAttribute(name, attributeValue) {
      this.attributes[name] = attributeValue;
    },
    appendChild(child) {
      this.children.push(child);
    }
  });

  return {
    createElement(name) {
      return createNode('Element', name);
    },
    createTextNode(value) {
      return createNode('Text', value);
    }
  };
}

function createFrom(template) {
  const document = createDocument();
  const create = new Function('document', `${generateCreateFunction(template)}\nreturn create;`)(document);
  return create({});
}

test('generates create() code that builds a nested DOM tree', () => {
  const root = createFrom({
    type: 'Root',
    children: [{
      type: 'Element',
      name: 'main',
      attributes: [{ name: 'class', value: 'page' }],
      children: [
        { type: 'Text', value: 'Hello ', children: [] },
        { type: 'Element', name: 'p', attributes: [{ name: 'hidden', value: null }], children: [
          { type: 'Expression', value: '1 + 1', dependencies: [] }
        ] }
      ]
    }]
  });

  assert.equal(root.type, 'Element');
  assert.equal(root.value, 'main');
  assert.deepEqual(root.attributes, { class: 'page' });
  assert.deepEqual(root.children[0], {
    type: 'Text',
    value: 'Hello ',
    attributes: {},
    children: [],
    setAttribute: root.children[0].setAttribute,
    appendChild: root.children[0].appendChild
  });
  assert.equal(root.children[1].value, 'p');
  assert.deepEqual(root.children[1].attributes, { hidden: '' });
  assert.equal(root.children[1].children[0].value, '2');
});

test('preserves quotes, backslashes, and newlines in text and attribute values', () => {
  const root = createFrom({
    type: 'Root',
    children: [{
      type: 'Element',
      name: 'p',
      attributes: [{ name: 'title', value: 'He said "hello"' }],
      children: [{ type: 'Text', value: 'C:\\work\nnext line' }]
    }]
  });

  assert.equal(root.attributes.title, 'He said "hello"');
  assert.equal(root.children[0].value, 'C:\\work\nnext line');
});

test('emits event directives as DOM listeners rather than inline attributes', () => {
  const source = generateCreateFunction({
    type: 'Root',
    children: [{
      type: 'Element',
      name: 'button',
      attributes: [{ name: 'on:click', value: 'handleClick' }],
      children: []
    }]
  });

  assert.match(source, /trackListener\(\w+, "click", handleClick\)/);
  assert.doesNotMatch(source, /setAttribute\("on:click"/);
  assert.doesNotMatch(source, /\w+\.addEventListener/);
});

test('emits event handler expressions with arguments', () => {
  const source = generateCreateFunction({
    type: 'Root',
    children: [{
      type: 'Element',
      name: 'button',
      attributes: [{ name: 'on:click', value: '(event) => increment(event.detail)' }],
      children: []
    }]
  });

  assert.match(source, /trackListener\(\w+, "click", \(event\) => increment\(event\.detail\)\)/);
});

test('rejects event directives without a handler expression', () => {
  assert.throws(
    () => generateCreateFunction({
      type: 'Root',
      children: [{
        type: 'Element',
        name: 'button',
        attributes: [{ name: 'on:click', value: '   ' }],
        children: []
      }]
    }),
    /Event directive 'on:click' requires a handler expression\./
  );
});

test('requires a root element for component creation', () => {
  assert.throws(
    () => generateCreateFunction({ type: 'Root', children: [{ type: 'Text', value: 'Only text' }] }),
    /Component template must contain a root element\./
  );
});

function createEachTemplate(key, children) {
  return {
    type: 'Root',
    children: [{
      type: 'Element',
      name: 'ul',
      attributes: [],
      children: [{
        type: 'EachBlock',
        collection: 'items',
        item: 'item',
        key,
        children
      }]
    }]
  };
}

const listItem = () => ({ type: 'Element', name: 'li', attributes: [], children: [{ type: 'Expression', value: 'item.name' }] });

test('emits item key lookups for keyed each blocks', () => {
  const source = generateCreateFunction(createEachTemplate('id', [listItem()]));

  assert.match(source, /items\.forEach\(\(item\) => \{/);
  assert.match(source, /const key = item\.id;/);
});

test('emits index-based keys for keyless each blocks', () => {
  const source = generateCreateFunction(createEachTemplate(null, [listItem()]));

  assert.match(source, /items\.forEach\(\(item, index_\d+\) => \{/);
  assert.match(source, /const key = index_\d+;/);
  assert.doesNotMatch(source, /const key = item\./);
});

test('ignores formatting whitespace when counting each block root elements', () => {
  assert.doesNotThrow(
    () => generateCreateFunction(createEachTemplate(null, [
      { type: 'Text', value: '\n        ' },
      listItem(),
      { type: 'Text', value: '\n      ' }
    ]))
  );
});

test('rejects each blocks without exactly one root element', () => {
  assert.throws(
    () => generateCreateFunction(createEachTemplate(null, [listItem(), listItem()])),
    /Each blocks must contain exactly one root element\./
  );
  assert.throws(
    () => generateCreateFunction(createEachTemplate(null, [{ type: 'Expression', value: 'item' }])),
    /Each blocks must contain exactly one root element\./
  );
});

test('rejects event directives inside each block bodies', () => {
  assert.throws(
    () => generateCreateFunction(createEachTemplate(null, [{
      type: 'Element',
      name: 'li',
      attributes: [{ name: 'on:click', value: 'select' }],
      children: []
    }])),
    /Event directive 'on:click' is not supported inside each blocks yet\./
  );
});

test('rejects nested blocks inside each block bodies', () => {
  const nestedIf = createEachTemplate(null, [{
    type: 'Element',
    name: 'li',
    attributes: [],
    children: [{ type: 'IfBlock', test: 'item.active', consequent: [], alternate: null, children: [] }]
  }]);
  assert.throws(() => generateCreateFunction(nestedIf), /Each block bodies do not support 'IfBlock' nodes yet\./);

  const nestedEach = createEachTemplate(null, [{
    type: 'Element',
    name: 'li',
    attributes: [],
    children: [{ type: 'EachBlock', collection: 'inner', item: 'sub', key: null, children: [] }]
  }]);
  assert.throws(() => generateCreateFunction(nestedEach), /Each block bodies do not support 'EachBlock' nodes yet\./);
});
test('emits component tags with attributes as mount calls carrying props', () => {
  const source = generateCreateFunction({
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
          { name: 'label', value: 'Total' },
          { name: 'disabled', value: null },
          { name: 'start', value: 'count', dynamic: true, dependencies: ['count'] }
        ],
        children: []
      }]
    }]
  }, [{ name: 'Counter', source: './Counter.wizz' }]);

  assert.match(source, /mountChildren\.push\(\(\) => \{/);
  assert.match(source, /component_1 = Counter\(node_1, \{ "label": "Total", "disabled": true, "start": count \}\);/);
  assert.match(source, /childComponents\.push\(component_1\);/);
});

test('mounts prop-less component tags with a single expression and no instance reference', () => {
  const source = generateCreateFunction({
    type: 'Root',
    children: [{
      type: 'Element',
      name: 'main',
      attributes: [],
      children: [{ type: 'Element', name: 'Counter', componentId: 1, attributes: [], children: [] }]
    }]
  }, [{ name: 'Counter', source: './Counter.wizz' }]);

  assert.match(source, /mountChildren\.push\(\(\) => childComponents\.push\(Counter\(node_1, \{\}\)\)\);/);
  assert.doesNotMatch(source, /component_1/);
});

test('passes reactive prop values to the child at mount time', () => {
  const source = generateCreateFunction({
    type: 'Root',
    children: [{
      type: 'Element',
      name: 'main',
      attributes: [],
      children: [{
        type: 'Element',
        name: 'Counter',
        componentId: 1,
        attributes: [{ name: 'start', value: 'count', dynamic: true, dependencies: ['count'] }],
        children: []
      }]
    }]
  }, [{ name: 'Counter', source: './Counter.wizz' }]);

  const mounts = [];
  const instance = { destroy() {} };
  const Counter = (target, props) => {
    mounts.push({ target, props });
    return instance;
  };
  const create = new Function('document', 'Counter', 'count', `${source}\nreturn create;`)(
    { createElement: (name) => ({ name, childNodes: [], appendChild() {}, setAttribute() {} }) },
    Counter,
    7
  );
  const root = create({});
  root.__wizzMountChildren();

  assert.equal(mounts.length, 1);
  assert.deepEqual(mounts[0].props, { start: 7 });
  // The mounted instance is registered for the parent-owned teardown cascade.
  assert.deepEqual(root.__wizzChildComponents, [instance]);
});

test('collectComponentRefNames lists refs only for tags with reactive props', () => {
  const { collectComponentRefNames } = require('./domGenerator');
  const template = {
    type: 'Root',
    children: [{
      type: 'Element',
      name: 'main',
      attributes: [],
      children: [
        { type: 'Element', name: 'A', componentId: 1, attributes: [{ name: 'x', value: 'count', dynamic: true, dependencies: ['count'] }], children: [] },
        { type: 'Element', name: 'B', componentId: 2, attributes: [{ name: 'label', value: 'Hi' }], children: [] }
      ]
    }]
  };

  assert.deepEqual(collectComponentRefNames(template, [{ name: 'A' }, { name: 'B' }]), ['component_1']);
  assert.deepEqual(collectComponentRefNames(template, [{ name: 'A' }, { name: 'B' }]), collectComponentRefNames(template, [{ name: 'A' }, { name: 'B' }]));
});

test('collectComponentRefNames walks both branches of an if block with an else', () => {
  // The parser's `children` alias repoints to the alternate at {:else}, so a
  // children-only walk missed consequent component tags — their reactive prop
  // updates silently never generated a ref.
  const { collectComponentRefNames } = require('./domGenerator');
  const template = {
    type: 'Root',
    children: [{
      type: 'Element',
      name: 'main',
      attributes: [],
      children: [{
        type: 'IfBlock',
        test: 'flag',
        consequent: [
          { type: 'Element', name: 'A', componentId: 3, attributes: [{ name: 'x', value: 'count', dynamic: true, dependencies: ['count'] }], children: [] }
        ],
        alternate: [
          { type: 'Element', name: 'B', componentId: 4, attributes: [{ name: 'x', value: 'count', dynamic: true, dependencies: ['count'] }], children: [] }
        ]
      }]
    }]
  };

  assert.deepEqual(collectComponentRefNames(template, [{ name: 'A' }, { name: 'B' }]), ['component_3', 'component_4']);
});

test('rejects children, event directives, and prototype keys on component tags', () => {
  const generate = (componentNode) => () => generateCreateFunction({
    type: 'Root',
    children: [{ type: 'Element', name: 'main', attributes: [], children: [componentNode] }]
  }, [{ name: 'Counter', source: './Counter.wizz' }]);

  assert.throws(
    generate({ type: 'Element', name: 'Counter', componentId: 1, attributes: [], children: [{ type: 'Text', value: 'x' }] }),
    /Component <Counter> does not support children\./
  );
  assert.throws(
    generate({ type: 'Element', name: 'Counter', componentId: 1, attributes: [{ name: 'on:click', value: 'handle' }], children: [] }),
    /Event directive 'on:click' is not supported on component <Counter>/
  );
  assert.throws(
    generate({ type: 'Element', name: 'Counter', componentId: 1, attributes: [{ name: '__proto__', value: 'x' }], children: [] }),
    /'__proto__' cannot be used as a prop name/
  );
});

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
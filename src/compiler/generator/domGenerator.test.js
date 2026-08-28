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

  assert.match(source, /addEventListener\("click", handleClick\)/);
  assert.doesNotMatch(source, /setAttribute\("on:click"/);
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

  assert.match(source, /addEventListener\("click", \(event\) => increment\(event\.detail\)\)/);
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
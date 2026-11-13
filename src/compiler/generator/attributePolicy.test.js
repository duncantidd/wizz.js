const assert = require('node:assert/strict');
const test = require('node:test');
const {
  PROPERTY_ATTRIBUTES,
  BOOLEAN_ATTRIBUTES,
  isBooleanAttribute,
  attributeWriteSource,
  attributeValueSource,
  needsAttributeHelper,
  __wizzAttr
} = require('./attributePolicy');

// A minimal element recording attribute presence the way the DOM does.
function createNode() {
  return {
    attributes: Object.create(null),
    calls: [],
    setAttribute(name, value) { this.calls.push(['set', name, value]); this.attributes[name] = value; },
    removeAttribute(name) { this.calls.push(['remove', name]); delete this.attributes[name]; }
  };
}

const run = (source, scope) => new Function(...Object.keys(scope), '__wizzAttr', source)(...Object.values(scope), __wizzAttr);

test('recognizes HTML boolean attributes case-insensitively and nothing else', () => {
  for (const name of ['hidden', 'required', 'readonly', 'open', 'inert', 'multiple', 'selected', 'checked', 'disabled', 'autofocus', 'novalidate']) {
    assert.equal(isBooleanAttribute(name), true, name);
  }
  assert.equal(isBooleanAttribute('HIDDEN'), true);
  assert.equal(isBooleanAttribute('ReadOnly'), true);
  for (const name of ['aria-hidden', 'aria-expanded', 'draggable', 'spellcheck', 'contenteditable', 'class', 'title', 'data-hidden', 'value', '__proto__', 'constructor', 'toString', '']) {
    assert.equal(isBooleanAttribute(name), false, name);
  }
  // Inherited Object members are not set members.
  assert.equal(BOOLEAN_ATTRIBUTES.has('hasOwnProperty'), false);
});

test('boolean attributes are present for truthy values and absent for falsy values', () => {
  for (const value of [true, 1, 'yes', 'false', '0', [], {}, -1]) {
    const node = createNode();
    __wizzAttr(node, 'hidden', value, 1);
    assert.equal(node.attributes.hidden, '', `truthy ${JSON.stringify(value)}`);
  }
  for (const value of [false, 0, -0, '', null, undefined, NaN, 0n]) {
    const node = createNode();
    node.attributes.hidden = '';
    __wizzAttr(node, 'hidden', value, 1);
    assert.equal('hidden' in node.attributes, false, `falsy ${String(value)}`);
  }
});

test('non-boolean attributes are removed only for null and undefined', () => {
  const cases = [
    [false, 'false'],
    [true, 'true'],
    [0, '0'],
    ['', ''],
    [NaN, 'NaN'],
    ['x', 'x'],
    [{ toString: () => 'custom' }, 'custom']
  ];
  for (const [value, expected] of cases) {
    const node = createNode();
    __wizzAttr(node, 'aria-expanded', value);
    assert.equal(node.attributes['aria-expanded'], expected);
  }
  for (const value of [null, undefined]) {
    const node = createNode();
    node.attributes.title = 'old';
    __wizzAttr(node, 'title', value);
    assert.equal('title' in node.attributes, false);
  }
});

test('toggling repeatedly converges and removing an absent attribute is harmless', () => {
  const node = createNode();
  for (let index = 0; index < 1000; index++) __wizzAttr(node, 'hidden', index % 2 === 0, 1);
  assert.equal('hidden' in node.attributes, false);
  __wizzAttr(node, 'hidden', false, 1);
  __wizzAttr(node, 'title', null);
  assert.deepEqual(Object.keys(node.attributes), []);
});

test('the helper only touches setAttribute/removeAttribute and never markup sinks', () => {
  const source = __wizzAttr.toString();
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|eval|Function/);
  // Hostile values arrive as plain strings, never parsed.
  const node = createNode();
  __wizzAttr(node, 'title', '"><img src=x onerror=alert(1)>');
  assert.equal(node.attributes.title, '"><img src=x onerror=alert(1)>');
  // A hostile attribute name reaches the node's own API; no object writes.
  const pollutionNode = createNode();
  __wizzAttr(pollutionNode, '__proto__', { polluted: true });
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});

test('writes property attributes as properties and everything else through the helper', () => {
  for (const name of PROPERTY_ATTRIBUTES) {
    assert.equal(attributeWriteSource('n', name, 'v'), `n.${name} = v;`);
    // Head nodes opt out of the property path.
    const headSource = attributeWriteSource('n', name, 'v', { properties: false });
    assert.match(headSource, /^__wizzAttr\(n, /);
  }
  assert.equal(attributeWriteSource('n', 'checked', 'v', { properties: false }), '__wizzAttr(n, "checked", v, 1);');
  assert.equal(attributeWriteSource('n', 'value', 'v', { properties: false }), '__wizzAttr(n, "value", v);');
  assert.equal(attributeWriteSource('n', 'hidden', 'a && b'), '__wizzAttr(n, "hidden", a && b, 1);');
  assert.equal(attributeWriteSource('n', 'title', 'tip'), '__wizzAttr(n, "title", tip);');
  // Names are emitted as JSON string literals, so quotes cannot escape them.
  assert.equal(attributeWriteSource('n', 'a"b', 'v'), '__wizzAttr(n, "a\\"b", v);');
});

test('generated write statements behave per the policy when executed', () => {
  const node = createNode();
  run(attributeWriteSource('node', 'hidden', 'flag'), { node, flag: false });
  run(attributeWriteSource('node', 'title', 'tip'), { node, tip: undefined });
  run(attributeWriteSource('node', 'aria-pressed', 'flag'), { node, flag: false });
  run(attributeWriteSource('node', 'value', 'text'), { node, text: 'typed' });
  assert.deepEqual({ ...node.attributes }, { 'aria-pressed': 'false' });
  assert.equal(node.value, 'typed');
});

test('attributeValueSource yields the serialized value or null for absence', () => {
  const evaluate = (name, value) => new Function('v', `return ${attributeValueSource(name, 'v')};`)(value);
  assert.equal(evaluate('hidden', true), '');
  assert.equal(evaluate('hidden', 'false'), '');
  assert.equal(evaluate('hidden', false), null);
  assert.equal(evaluate('hidden', undefined), null);
  assert.equal(evaluate('content', 'D'), 'D');
  assert.equal(evaluate('content', 0), '0');
  assert.equal(evaluate('content', false), 'false');
  assert.equal(evaluate('content', null), null);
  assert.equal(evaluate('content', undefined), null);
  // The author expression is evaluated exactly once.
  let reads = 0;
  new Function('read', `return ${attributeValueSource('content', 'read()')};`)(() => { reads += 1; return 'x'; });
  assert.equal(reads, 1);
});

test('needsAttributeHelper finds helper-written dynamic attributes anywhere in the tree', () => {
  const element = (name, attributes = [], children = []) => ({ type: 'Element', name, attributes, children });
  const dynamic = (name) => ({ name, value: 'x', dynamic: true });
  const root = (...children) => ({ type: 'Root', children });

  assert.equal(needsAttributeHelper(root(element('p', [{ name: 'class', value: 'a' }]))), false);
  assert.equal(needsAttributeHelper(root(element('button', [{ name: 'on:click', value: 'go', dynamic: true }]))), false);
  assert.equal(needsAttributeHelper(root(element('input', [dynamic('value'), dynamic('checked'), dynamic('disabled')]))), false);
  assert.equal(needsAttributeHelper(element('meta', [dynamic('value')]), { properties: false }), true);
  assert.equal(needsAttributeHelper(root(element('p', [dynamic('hidden')]))), true);
  // Component tags take props, not attributes.
  assert.equal(needsAttributeHelper(root(element('Card', [dynamic('title')])), { componentNames: new Set(['Card']) }), false);
  assert.equal(needsAttributeHelper(root({ ...element('Card', [dynamic('title')]), componentId: 1 })), false);
  // Nested in branches and each bodies.
  assert.equal(needsAttributeHelper(root(element('main', [], [{ type: 'IfBlock', test: 'a', consequent: [], alternate: [element('p', [dynamic('open')])] }]))), true);
  assert.equal(needsAttributeHelper(root(element('ul', [], [{ type: 'EachBlock', children: [element('li', [dynamic('title')])] }]))), true);
  // Cycles and empty input terminate.
  const cyclic = root();
  cyclic.children.push(cyclic);
  assert.equal(needsAttributeHelper(cyclic), false);
  assert.equal(needsAttributeHelper(null), false);
});

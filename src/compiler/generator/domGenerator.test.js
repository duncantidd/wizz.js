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
  const create = new Function('document', `${generateCreateFunction(template)}\nreturn __wizzCreate;`)(document);
  return create({});
}

test('assigns update targets from the nodes it creates, in branches too', () => {
  const paragraph = { type: 'Element', name: 'p', attributes: [], children: [] };
  const text = { type: 'Expression', value: 'count', dependencies: ['count'] };
  const source = generateCreateFunction({
    type: 'Root',
    children: [{
      type: 'Element',
      name: 'main',
      attributes: [],
      children: [paragraph, { type: 'IfBlock', test: 'open', consequent: [text], alternate: null }]
    }]
  }, [], new WeakMap(), new Map([[paragraph, '__wizzTarget_1'], [text, '__wizzTarget_2']]));

  assert.match(source, /const (__wizzNode_\d+) = document\.createElement\("p"\);\n\s*__wizzTarget_1 = \1;/);
  assert.match(source, /const (__wizzNode_\d+) = document\.createTextNode\(String\(count\)\);\n\s*__wizzTarget_2 = \1;/);
});

test('emits list locals with the reserved prefix so author names cannot collide', () => {
  const source = generateCreateFunction({
    type: 'Root',
    children: [{
      type: 'Element',
      name: 'ul',
      attributes: [],
      children: [{
        type: 'EachBlock',
        item: 'row',
        collection: 'rows',
        key: 'id',
        children: [{ type: 'Element', name: 'li', attributes: [], children: [] }]
      }]
    }]
  });
  const code = source.replace(/"[^"]*"/g, '""');

  assert.match(code, /__wizzItems\.forEach/);
  assert.doesNotMatch(code, /\b(?:items|nextRecords|seenKeys|record|key|parentRef|startIndex)\b/);
});

test('assigns no targets by default', () => {
  const source = generateCreateFunction({
    type: 'Root',
    children: [{ type: 'Element', name: 'main', attributes: [], children: [] }]
  });

  assert.doesNotMatch(source, /__wizzTarget/);
});

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

  assert.match(source, /__wizzListen\(\w+, "click", handleClick\)/);
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

  assert.match(source, /__wizzListen\(\w+, "click", \(event\) => increment\(event\.detail\)\)/);
});

test('emits the instrumented handler source when one is supplied for the attribute', () => {
  const attribute = { name: 'on:input', value: '(e) => name = e.target.value' };
  const template = { type: 'Root', children: [{ type: 'Element', name: 'input', attributes: [attribute], children: [] }] };
  const handlerSources = new WeakMap([[attribute, '(e) => { name = e.target.value; __wizzQueueUpdate({ name: true }); }']]);

  assert.match(generateCreateFunction(template, [], handlerSources), /__wizzListen\(\w+, "input", \(e\) => \{ name = e\.target\.value; __wizzQueueUpdate\(\{ name: true \}\); \}\);/);
  // Without an entry (or a map) the raw directive value is emitted.
  assert.match(generateCreateFunction(template), /__wizzListen\(\w+, "input", \(e\) => name = e\.target\.value\);/);
  assert.match(generateCreateFunction(template, [], new WeakMap()), /__wizzListen\(\w+, "input", \(e\) => name = e\.target\.value\);/);
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

  assert.match(source, /__wizzItems\.forEach\(\(item\) => \{/);
  assert.match(source, /const __wizzKey = item\.id;/);
});

test('emits index-based keys for keyless each blocks', () => {
  const source = generateCreateFunction(createEachTemplate(null, [listItem()]));

  assert.match(source, /__wizzItems\.forEach\(\(item, __wizzIndex_\d+\) => \{/);
  assert.match(source, /const __wizzKey = __wizzIndex_\d+;/);
  assert.doesNotMatch(source, /const __wizzKey = item\./);
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

const listenerItem = (attributes) => ({
  type: 'Element',
  name: 'li',
  attributes,
  children: [{ type: 'Element', name: 'button', attributes: [{ name: 'on:click', value: '() => pick(item)' }], children: [] }]
});

test('emits each-item listeners through the scoped helper and a per-record drop list', () => {
  const source = generateCreateFunction(createEachTemplate('id', [listenerItem([{ name: 'on:focus', value: 'select' }])]));

  // Item listeners never join the component-wide list: a removed item must
  // release its own.
  assert.doesNotMatch(source, /__wizzListen\(/);
  assert.match(source, /function __wizzCreateItem_2\(item\) \{\n {4}const __wizzDrop = \[\];/);
  assert.match(source, /__wizzDrop\.push\(__wizzOn\(__wizzNode_3, "focus", select\)\);/);
  assert.match(source, /__wizzDrop\.push\(__wizzOn\(__wizzNode_4, "click", \(\) => pick\(item\)\)\);/);
  assert.doesNotMatch(source, /setAttribute\("on:/, 'directives never become attributes');
  // The record exposes its disposers and rebinds the item its handlers read.
  assert.match(source, /drop: __wizzDrop,\n {6}update\(__wizzItem\) \{\n {8}item = __wizzItem;/);
  // A removed record drops its listeners; the owning scope drops the rest.
  assert.match(source, /if \(!__wizzNext\.has\(__wizzKey\)\) \{ __wizzNode_1\.removeChild\(__wizzRecord\.node\); for \(const __wizzDropItem of __wizzRecord\.drop\) __wizzDropItem\(\); \}/);
  assert.match(source, /__wizzDrop\.push\(\(__wizzDetach\) => \{\n {4}__wizzRecords_2\.forEach\(\(__wizzRecord\) => \{\n {6}for \(const __wizzDropItem of __wizzRecord\.drop\) __wizzDropItem\(\);\n {4}\}\);\n {4}__wizzRecords_2\.clear\(\);\n {2}\}\);/);
});

test('each items without listeners keep the listener-free record shape', () => {
  const source = generateCreateFunction(createEachTemplate('id', [listItem()]));
  assert.doesNotMatch(source, /__wizzDrop|__wizzOn|__wizzItem\b/);
  assert.match(source, /update\(item\) \{/);
});

// Milestone 25 step 1: component tags inside each bodies (WIZZ-G004 retired).
const rowImports = [{ name: 'Row', source: './Row.wizz' }];
const rowTag = (attributes = [{ name: 'todo', value: 'item', dynamic: true, dependencies: [] }], extra = {}) => ({
  type: 'Element', name: 'Row', componentId: 1, attributes, children: [], ...extra
});

test('a nested each-body component mounts per item after attachment and is owned by the record', () => {
  const source = generateCreateFunction(createEachTemplate('id', [
    { type: 'Element', name: 'li', attributes: [], children: [{ type: 'Expression', value: 'item.name' }, rowTag()] }
  ]), rowImports);

  assert.match(source, /function __wizzCreateItem_2\(item, __wizzMounts\) \{\n {4}const __wizzDrop = \[\];/);
  // A placeholder holds the position; the mount resolves its parent then.
  assert.match(source, /const __wizzNode_5 = document\.createTextNode\(""\);\n {4}let __wizzChild_1 = null;\n {4}__wizzNode_3\.appendChild\(__wizzNode_5\);/);
  assert.match(source, /__wizzMounts\.push\(\(\) => \{\n {6}const __wizzMountParent = __wizzNode_5\.parentNode;\n {6}__wizzChild_1 = Row\(__wizzMountParent, \{ "todo": item \}, __wizzNode_5\);\n {6}__wizzMountParent\.removeChild\(__wizzNode_5\);\n {6}__wizzDrop\.push\(\(\) => __wizzChild_1\.destroy\(\)\);\n {4}\}\);/);
  assert.doesNotMatch(source, /__wizzRecord\.node = /, 'only a root component repoints the record');
  // The record rebinds the item and hands the row its props.
  assert.match(source, /update\(__wizzItem\) \{\n {8}item = __wizzItem;\n {8}__wizzNode_3\.childNodes\[0\]\.nodeValue = String\(item\.name\);\n {8}if \(__wizzChild_1\) __wizzChild_1\.setProps\(\{ "todo": item \}\);/);
  // First pass defers mounts to the component scope; later passes run them.
  assert.match(source, /__wizzUpdateList_2\(items, __wizzChildMounts\);/);
  assert.match(source, /__wizzLists\.push\(\(__wizzChanged\) => \{ if \(__wizzChanged\.items\) __wizzUpdateList_2\(items\); \}\);/);
  assert.match(source, /if \(!__wizzMounts\) for \(const __wizzMount of __wizzPendingMounts\) __wizzMount\(\);/);
  // Removal drops first (a fresh child removes its own root), then detaches what is left.
  assert.match(source, /\{ for \(const __wizzDropItem of __wizzRecord\.drop\) __wizzDropItem\(\); if \(__wizzRecord\.node\.parentNode === __wizzNode_1\) __wizzNode_1\.removeChild\(__wizzRecord\.node\); \}/);
  // Row instances are never factory-scope references or component-wide children.
  assert.doesNotMatch(source, /__wizzComponent_1|__wizzChildren\.push/);
});

test('a component as the item root becomes the record node once it mounts', () => {
  const source = generateCreateFunction(createEachTemplate('id', [{ type: 'Text', value: '\n' }, rowTag()]), rowImports);
  assert.match(source, /const __wizzNode_3 = document\.createTextNode\(""\);\n {4}let __wizzChild_1 = null;\n {4}__wizzMounts\.push/);
  assert.match(source, /__wizzRecord\.node = __wizzNode_3\.previousSibling;\n {6}__wizzMountParent\.removeChild\(__wizzNode_3\);/);
  assert.match(source, /const __wizzRecord = \{\n {6}node: __wizzNode_3,\n {6}drop: __wizzDrop,/);
  assert.match(source, /\n {4}return __wizzRecord;\n {2}\}/);
});

test('static props never reach setProps, and a prop-less row gets no update call', () => {
  const mixed = generateCreateFunction(createEachTemplate(null, [rowTag([
    { name: 'label', value: 'fixed', dynamic: false },
    { name: 'on', value: null, dynamic: false },
    { name: 'todo', value: 'item', dynamic: true, dependencies: [] }
  ])]), rowImports);
  assert.match(mixed, /Row\(__wizzMountParent, \{ "label": "fixed", "on": true, "todo": item \}, __wizzNode_3\)/);
  assert.match(mixed, /__wizzChild_1\.setProps\(\{ "todo": item \}\);/);

  const bare = generateCreateFunction(createEachTemplate(null, [rowTag([])]), rowImports);
  assert.match(bare, /Row\(__wizzMountParent, \{\}, __wizzNode_3\)/);
  assert.doesNotMatch(bare, /setProps/);
});

test('an each list of components directly in a branch detaches only roots still attached', () => {
  const template = { type: 'Root', children: [{ type: 'Element', name: 'main', attributes: [], children: [{
    type: 'IfBlock', test: 'open', dependencies: ['open'],
    consequent: [{ type: 'EachBlock', collection: 'items', item: 'item', key: 'id', children: [rowTag()] }],
    alternate: null
  }] }] };
  const source = generateCreateFunction(template, rowImports);
  // Inside the maker, the first pass hands mounts to the branch's deferred list.
  assert.match(source, /__wizzUpdateList_\d+\(items, __wizzChildMounts\);/);
  assert.match(source, /if \(__wizzDetach && __wizzRecord\.node\.parentNode === __wizzParent\) __wizzParent\.removeChild\(__wizzRecord\.node\);/);
});

test('each-body component tags keep the component-tag rules', () => {
  const cases = [
    [rowTag(undefined, { children: [{ type: 'Text', value: 'x' }] }), 'WIZZ-G008', /does not support children/],
    [rowTag([{ name: '__proto__', value: 'item', dynamic: true }]), 'WIZZ-G007', /cannot be used as a prop name/],
    [rowTag([{ name: 'on:click', value: 'go' }]), 'WIZZ-G011', /not supported on component <Row>/],
    [rowTag(undefined, { componentId: undefined }), 'WIZZ-G009', /missing its componentId/]
  ];
  for (const [tag, code, message] of cases) {
    assert.throws(
      () => generateCreateFunction(createEachTemplate(null, [{ type: 'Element', name: 'li', attributes: [], children: [tag] }]), rowImports),
      (error) => error.code === code && message.test(error.message),
      code
    );
    assert.throws(() => generateCreateFunction(createEachTemplate(null, [tag]), rowImports), (error) => error.code === code, `${code} at the item root`);
  }
});

test('lists without components keep their exact emission', () => {
  const source = generateCreateFunction(createEachTemplate('id', [listItem()]), rowImports);
  assert.doesNotMatch(source, /__wizzMounts|__wizzPendingMounts|const __wizzRecord =|parentNode/);
  assert.match(source, /__wizzUpdateList_2\(items\);/);
});

test('uses the instrumented handler source for an each-item directive', () => {
  const attribute = { name: 'on:click', value: '() => total += item' };
  const handlerSources = new WeakMap([[attribute, '() => { total += item; __wizzQueueUpdate({ total: true }); }']]);
  const source = generateCreateFunction(createEachTemplate(null, [{ type: 'Element', name: 'li', attributes: [attribute], children: [] }]), [], handlerSources);
  assert.match(source, /__wizzOn\(__wizzNode_3, "click", \(\) => \{ total \+= item; __wizzQueueUpdate\(\{ total: true \}\); \}\)/);
});

test('validates event directives inside each block bodies', () => {
  const withDirective = (attribute) => createEachTemplate(null, [{ type: 'Element', name: 'li', attributes: [attribute], children: [] }]);
  assert.throws(
    () => generateCreateFunction(withDirective({ name: 'on:click', value: null })),
    (error) => error.code === 'WIZZ-G012' && /Event directive 'on:click' requires a handler expression\./.test(error.message)
  );
  assert.throws(
    () => generateCreateFunction(withDirective({ name: 'on:click', value: '   ' })),
    (error) => error.code === 'WIZZ-G012'
  );
  assert.throws(
    () => generateCreateFunction(withDirective({ name: 'on:bad-name', value: 'go' })),
    (error) => error.code === 'WIZZ-G013' && /Invalid event directive 'on:bad-name'\./.test(error.message)
  );
});

const reactiveIf = (consequent, alternate = null, test = 'open') => ({
  type: 'Root',
  children: [{
    type: 'Element',
    name: 'main',
    attributes: [],
    children: [{ type: 'IfBlock', test, dependencies: ['open'], consequent, alternate, children: alternate || consequent }]
  }]
});

test('emits a reactive if block as an anchor, a block, and one maker per branch', () => {
  const source = generateCreateFunction(reactiveIf(
    [{ type: 'Element', name: 'p', attributes: [], children: [{ type: 'Text', value: 'yes' }] }],
    [{ type: 'Text', value: 'no' }]
  ));

  // create() holds only the anchor and the block wiring.
  assert.match(source, /const __wizzIfAnchor_1 = document\.createTextNode\(""\);\n {2}__wizzNode_1\.appendChild\(__wizzIfAnchor_1\);/);
  assert.match(source, /const __wizzIf_1 = __wizzIfBlock\(__wizzNode_1, __wizzIfAnchor_1, \(\) => \(open\), \[__wizzIfMake_1_0, __wizzIfMake_1_1\], -1, null\);/);
  assert.match(source, /__wizzIf_1\.sync\(\{\}, true, __wizzChildMounts\);/);
  assert.match(source, /__wizzLists\.push\(\(__wizzChanged\) => __wizzIf_1\.sync\(__wizzChanged, __wizzChanged\.open\)\);/);
  assert.match(source, /__wizzDrop\.push\(__wizzIf_1\.drop\);/);
  assert.doesNotMatch(source, /if \(open\) \{/, 'no inline branch selection for a reactive test');

  // Makers follow create() and insert their own top-level nodes in front of
  // the anchor, tracking them for removal; deeper nodes are appended.
  const createEnd = source.indexOf('\n}\n');
  const consequent = source.indexOf('function __wizzIfMake_1_1(__wizzParent, __wizzAnchor) {');
  const alternate = source.indexOf('function __wizzIfMake_1_0(__wizzParent, __wizzAnchor) {');
  assert.ok(createEnd !== -1 && createEnd < consequent && consequent < alternate);
  assert.match(source, /const __wizzNode_2 = document\.createElement\("p"\);\n {2}__wizzParent\.insertBefore\(__wizzNode_2, __wizzAnchor\);\n {2}__wizzNodes\.push\(__wizzNode_2\);/);
  assert.match(source, /__wizzNode_2\.appendChild\(__wizzNode_3\);/);
  assert.match(source, /return \{ lists: __wizzLists, drop: __wizzDrop, mounts: __wizzChildMounts, nodes: __wizzNodes \};/);
});

test('a reactive if block without an else passes null for the falsy maker', () => {
  const source = generateCreateFunction(reactiveIf([{ type: 'Text', value: 'yes' }]));
  assert.match(source, /\[null, __wizzIfMake_1_1\]/);
  assert.doesNotMatch(source, /__wizzIfMake_1_0/);
});

test('a maker scopes its listeners, clears its update targets, and owns its components', () => {
  const expression = { type: 'Expression', value: 'label', dependencies: ['label'] };
  const paragraph = {
    type: 'Element',
    name: 'p',
    attributes: [{ name: 'on:click', value: 'go' }],
    children: [expression]
  };
  const component = {
    type: 'Element',
    name: 'Badge',
    componentId: 1,
    attributes: [{ name: 'label', value: 'label', dynamic: true, dependencies: ['label'] }],
    children: []
  };
  const targets = new Map([[expression, '__wizzTarget_1']]);
  const source = generateCreateFunction(reactiveIf([paragraph, component]), [{ name: 'Badge' }], new WeakMap(), targets);
  const maker = source.slice(source.indexOf('function __wizzIfMake_1_1'));

  assert.match(maker, /__wizzDrop\.push\(__wizzOn\(__wizzNode_2, "click", go\)\);/);
  assert.doesNotMatch(maker, /__wizzListen\(/);
  assert.match(maker, /__wizzTarget_1 = __wizzNode_3;/);
  assert.match(maker, /__wizzDrop\.push\(\(\) => \{ __wizzTarget_1 = null; \}\);/);
  // The placeholder goes in front of the anchor but is never tracked: the
  // mount removes it.
  assert.match(maker, /__wizzParent\.insertBefore\(__wizzNode_4, __wizzAnchor\);\n {2}__wizzChildMounts\.push\(\(\) => \{/);
  assert.doesNotMatch(maker, /__wizzNodes\.push\(__wizzNode_4\)/);
  assert.match(maker, /const __wizzChild = Badge\(__wizzParent, \{ "label": label \}, __wizzNode_4\);\n {4}__wizzComponent_1 = __wizzChild;\n {4}__wizzDrop\.push\(\(\) => \{ __wizzChild\.destroy\(\); __wizzComponent_1 = null; \}\);\n {4}__wizzParent\.removeChild\(__wizzNode_4\);/);
  assert.doesNotMatch(maker, /__wizzChildren\.push/, 'a branch child is not in the component-wide list');
});

test('a list directly in a branch detaches its records; a deeper one leaves with its element', () => {
  const each = () => ({ type: 'EachBlock', collection: 'items', item: 'item', key: null, children: [listItem()] });
  const direct = generateCreateFunction(reactiveIf([each()]));
  assert.match(direct, /__wizzParent\.insertBefore\(__wizzAnchor_2, __wizzAnchor\);\n {2}__wizzNodes\.push\(__wizzAnchor_2\);/);
  assert.match(direct, /__wizzParent\.insertBefore\(__wizzRecord\.node, __wizzAnchor_2\);/);
  assert.match(direct, /__wizzRecords_2\.forEach\(\(__wizzRecord\) => \{\n {6}if \(__wizzDetach\) __wizzParent\.removeChild\(__wizzRecord\.node\);\n {4}\}\);/);

  const nested = generateCreateFunction(reactiveIf([{ type: 'Element', name: 'ul', attributes: [], children: [each()] }]));
  assert.doesNotMatch(nested, /__wizzDetach/, 'the list element carries its items out');
});

test('nested reactive blocks get their own makers and anchors inside the outer maker', () => {
  const inner = { type: 'IfBlock', test: 'deep', dependencies: ['deep'], consequent: [{ type: 'Text', value: 'in' }], alternate: null, children: [] };
  const template = reactiveIf([inner]);
  const source = generateCreateFunction(template);
  const outerMaker = source.slice(source.indexOf('function __wizzIfMake_1_1'));
  // The nested anchor is one of the outer branch's own nodes.
  assert.match(outerMaker, /__wizzParent\.insertBefore\(__wizzIfAnchor_2, __wizzAnchor\);\n {2}__wizzNodes\.push\(__wizzIfAnchor_2\);/);
  assert.match(outerMaker, /__wizzIfBlock\(__wizzParent, __wizzIfAnchor_2, \(\) => \(deep\), \[null, __wizzIfMake_2_1\], -1, null\);/);
  assert.match(source, /function __wizzIfMake_2_1\(__wizzParent, __wizzAnchor\) \{/);
});

test('an if block without dependencies is selected inline at mount', () => {
  const template = reactiveIf([{ type: 'Text', value: 'yes' }], [{ type: 'Text', value: 'no' }]);
  template.children[0].children[0].dependencies = [];
  const source = generateCreateFunction(template);
  assert.match(source, /if \(open\) \{\n {4}const __wizzNode_2 = document\.createTextNode\("yes"\);\n {4}__wizzNode_1\.appendChild\(__wizzNode_2\);\n {2}\} else \{/);
  assert.doesNotMatch(source, /__wizzIfBlock|__wizzIfMake|__wizzAnchor/);
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

  assert.match(source, /__wizzChildMounts\.push\(\(\) => \{/);
  assert.match(source, /__wizzComponent_1 = Counter\(__wizzNode_1, \{ "label": "Total", "disabled": true, "start": count \}, __wizzNode_\d+\);/);
  assert.match(source, /__wizzChildren\.push\(__wizzComponent_1\);/);
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

  assert.match(source, /__wizzChildren\.push\(Counter\(__wizzNode_1, \{\}, __wizzNode_\d+\)\);/);
  assert.doesNotMatch(source, /__wizzComponent_1/);
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
  const create = new Function('document', 'Counter', 'count', `${source}\nreturn __wizzCreate;`)(
    {
      createElement: (name) => ({ name, childNodes: [], appendChild() {}, removeChild() {}, setAttribute() {} }),
      createTextNode: () => ({})
    },
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

test('holds a child position with a placeholder it removes once the child mounts', () => {
  const placed = [];
  const parent = {
    nodes: [],
    setAttribute() {},
    appendChild(node) { this.nodes.push(node); },
    removeChild(node) { this.nodes.splice(this.nodes.indexOf(node), 1); }
  };
  const source = generateCreateFunction({
    type: 'Root',
    children: [{
      type: 'Element',
      name: 'main',
      attributes: [],
      children: [
        { type: 'Element', name: 'Counter', componentId: 1, attributes: [], children: [] },
        { type: 'Text', value: 'after' }
      ]
    }]
  }, [{ name: 'Counter', source: './Counter.wizz' }]);
  const Counter = (target, props, anchor) => {
    placed.push({ target, anchor, nodes: [...target.nodes] });
    return { destroy() {} };
  };
  const create = new Function('document', 'Counter', `${source}\nreturn __wizzCreate;`)(
    { createElement: () => parent, createTextNode: (value) => ({ value }) },
    Counter
  );

  const root = create({});
  assert.deepEqual(root.nodes.map((node) => node.value), ['', 'after']);

  root.__wizzMountChildren();

  assert.equal(placed[0].anchor, placed[0].nodes[0], 'the child receives the node at its position');
  assert.equal(placed[0].target, root);
  assert.deepEqual(root.nodes.map((node) => node.value), ['after']);
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

  assert.deepEqual(collectComponentRefNames(template, [{ name: 'A' }, { name: 'B' }]), ['__wizzComponent_1']);
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

  assert.deepEqual(collectComponentRefNames(template, [{ name: 'A' }, { name: 'B' }]), ['__wizzComponent_3', '__wizzComponent_4']);
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

// --- Dynamic attribute policy (issue #72) ---

const { __wizzAttr } = require('./attributePolicy');

// Executes create() with the module-scope helper and author bindings in scope,
// against nodes that track attribute presence like the DOM.
function createWithScope(template, scope) {
  const document = {
    createElement(name) {
      return {
        type: 'Element', name, attributes: Object.create(null), children: [],
        setAttribute(attributeName, value) { this.attributes[attributeName] = value; },
        removeAttribute(attributeName) { delete this.attributes[attributeName]; },
        appendChild(child) { this.children.push(child); }
      };
    },
    createTextNode(value) { return { type: 'Text', value }; }
  };
  const names = Object.keys(scope);
  return new Function('document', '__wizzAttr', ...names, `${generateCreateFunction(template)}\nreturn __wizzCreate;`)(
    document, __wizzAttr, ...names.map((name) => scope[name])
  )({});
}

const dynamicAttribute = (name, value) => ({ name, value, dynamic: true, dependencies: [value] });
const rootWith = (name, attributes) => ({ type: 'Root', children: [{ type: 'Element', name, attributes, children: [] }] });

test('create() applies the boolean, nullable, and property attribute policy', () => {
  const node = createWithScope(rootWith('input', [
    dynamicAttribute('hidden', 'off'),
    dynamicAttribute('required', 'on'),
    dynamicAttribute('title', 'missing'),
    dynamicAttribute('aria-invalid', 'off'),
    dynamicAttribute('data-count', 'zero'),
    dynamicAttribute('value', 'text'),
    dynamicAttribute('checked', 'on')
  ]), { off: false, on: 'yes', missing: undefined, zero: 0, text: 'typed' });

  assert.deepEqual({ ...node.attributes }, { required: '', 'aria-invalid': 'false', 'data-count': '0' });
  assert.equal(node.value, 'typed');
  assert.equal(node.checked, 'yes');
});

test('create() emits helper calls, never stringified boolean attributes', () => {
  const source = generateCreateFunction(rootWith('p', [dynamicAttribute('hidden', 'a'), dynamicAttribute('title', 'b')]));
  assert.match(source, /__wizzAttr\(__wizzNode_1, "hidden", a, 1\);/);
  assert.match(source, /__wizzAttr\(__wizzNode_1, "title", b\);/);
  assert.doesNotMatch(source, /setAttribute\("hidden"|String\(a\)|innerHTML/);
});

test('mixed-case property names still assign the lowercase DOM property', () => {
  const node = createWithScope(rootWith('input', [dynamicAttribute('DISABLED', 'on'), dynamicAttribute('Value', 'text')]), { on: true, text: 'v' });
  assert.equal(node.disabled, true);
  assert.equal(node.value, 'v');
  assert.equal(node.DISABLED, undefined);
  assert.deepEqual({ ...node.attributes }, {});
});

test('each item creation and positional updates both go through the policy', () => {
  const item = {
    type: 'Element', name: 'li',
    attributes: [dynamicAttribute('hidden', 'item.done'), dynamicAttribute('title', 'item.note'), dynamicAttribute('checked', 'item.done')],
    children: []
  };
  const source = generateCreateFunction(createEachTemplate('id', [item]));
  const create = source.slice(0, source.indexOf('update(item)'));
  const update = source.slice(source.indexOf('update(item)'));

  for (const part of [create, update]) {
    assert.match(part, /__wizzAttr\(__wizzNode_\d+, "hidden", item\.done, 1\);/);
    assert.match(part, /__wizzAttr\(__wizzNode_\d+, "title", item\.note\);/);
    assert.match(part, /__wizzNode_\d+\.checked = item\.done;/);
  }
});

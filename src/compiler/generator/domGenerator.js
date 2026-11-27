// src/compiler/generator/domGenerator.js
const { CodeBuilder } = require('./codeBuilder');
const { CODES, compilerDiagnostic } = require('../diagnostics.js');
const { attributeWriteSource } = require('./attributePolicy');
const { analyzeBlocks, eachHasListeners, eachHasComponents, isEventAttribute, isReactiveIf, makerName, ifRecheckSource } = require('./blockScopes');

/**
 * Validates an `on:` directive and returns its listener parts.
 * @param {Object} attribute - The `on:` attribute.
 * @param {WeakMap<Object, string>} handlerSources - Instrumented handler sources.
 * @returns {{eventName: string, handler: string}}
 */
function eventListenerParts(attribute, handlerSources) {
  const eventName = attribute.name.slice(3);
  const handlerExpression = attribute.value?.trim();
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(eventName)) {
    throw compilerDiagnostic(CODES.generator.invalidEventDirective, `Invalid event directive '${attribute.name}'.`);
  }
  if (!handlerExpression) {
    throw compilerDiagnostic(CODES.generator.eventMissingHandler, `Event directive '${attribute.name}' requires a handler expression.`);
  }
  return { eventName, handler: handlerSources.get(attribute) ?? handlerExpression };
}

// Component attributes are props, not DOM attributes: imported component tags
// create no element, so native attribute semantics never apply to them.
// Static attributes pass their string, bare attributes pass `true`, dynamic
// attributes pass the evaluated expression.
function buildComponentPropsSource(node) {
  const entries = [];
  for (const attribute of node.attributes || []) {
    if (attribute.name === '__proto__') {
      throw compilerDiagnostic(CODES.generator.propAttributeNameInvalid, `'${attribute.name}' cannot be used as a prop name on <${node.name}>.`);
    }
    if (attribute.name.startsWith('on:')) {
      throw compilerDiagnostic(CODES.generator.eventOnComponent, `Event directive '${attribute.name}' is not supported on component <${node.name}>; component attributes become props.`);
    }
    if (attribute.dynamic) {
      entries.push(`${JSON.stringify(attribute.name)}: ${attribute.value}`);
    } else if (attribute.value === null) {
      entries.push(`${JSON.stringify(attribute.name)}: true`);
    } else {
      entries.push(`${JSON.stringify(attribute.name)}: ${JSON.stringify(attribute.value)}`);
    }
  }
  return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`;
}

/**
 * Validates a component tag rendered inside an each item and returns what the
 * list generators (create() and the hydration walk's fresh items) emit for it.
 * The child instance lives in a variable local to the item, not in a
 * factory-scope reference: every row has its own. update() hands it every
 * dynamic prop through setProps(), whose Object.is check skips unchanged
 * values, so a row whose props did not change does not re-render. A child
 * that declares no props has no setProps() (the parent compiles without
 * seeing the child), so the call is guarded: undeclared attributes are
 * ignored, as the component-tag contract says.
 * @param {Object} node - The component tag.
 * @returns {{propsSource: string, childVar: string, setPropsSource: string|null}}
 */
function itemComponentParts(node) {
  if (node.componentId == null) {
    throw compilerDiagnostic(CODES.generator.missingComponentId, `Component <${node.name}> is missing its componentId; run the analyzer before generation.`);
  }
  if (node.children.length > 0) {
    throw compilerDiagnostic(CODES.generator.componentChildrenUnsupported, `Component <${node.name}> does not support children.`);
  }
  // Validates prop names (no `__proto__`) and rejects `on:` before any of
  // the names below are spliced into an object literal.
  const propsSource = buildComponentPropsSource(node);
  const childVar = `__wizzChild_${node.componentId}`;
  const dynamic = (node.attributes || []).filter((attribute) => attribute.dynamic);
  const setPropsSource = dynamic.length === 0
    ? null
    : `if (${childVar} && ${childVar}.setProps) ${childVar}.setProps({ ${dynamic.map((attribute) => `${JSON.stringify(attribute.name)}: ${attribute.value}`).join(', ')} });`;
  return { propsSource, childVar, setPropsSource };
}

/**
 * Lines of the deferred mount for a component inside an each item. The
 * placeholder holds the tag's position until the item is attached; the child
 * then inserts its root before it, the placeholder leaves, and the item's
 * `drop` array takes ownership of the instance. A component that is the
 * item's root becomes the record's node, so keyed moves and removals act on
 * the child's own root. mountComponent inserts the root synchronously before
 * its anchor, so the anchor's previous sibling is that root.
 * @param {Object} node - The component tag.
 * @param {string} placeholderVar - The placeholder text node variable.
 * @param {ReturnType<typeof itemComponentParts>} parts - From itemComponentParts.
 * @param {boolean} isRoot - Whether the tag is the item's root.
 * @returns {string[]} Source lines, unindented.
 */
function itemComponentMountLines(node, placeholderVar, parts, isRoot) {
  return [
    '__wizzMounts.push(() => {',
    `  const __wizzMountParent = ${placeholderVar}.parentNode;`,
    `  ${parts.childVar} = ${node.name}(__wizzMountParent, ${parts.propsSource}, ${placeholderVar});`,
    ...(isRoot ? [`  __wizzRecord.node = ${placeholderVar}.previousSibling;`] : []),
    `  __wizzMountParent.removeChild(${placeholderVar});`,
    `  __wizzDrop.push(() => ${parts.childVar}.destroy());`,
    '});'
  ];
}

/**
 * Source that drops one removed record. Records with children run their
 * disposers first: a freshly mounted child's destroy() removes its own root,
 * while an adopted (hydrated) child leaves it in place, so the node is
 * removed only if it is still attached to the list's parent.
 * @param {string} parentSource - The list parent expression.
 * @param {boolean} ownsScope - Whether records carry a `drop` array.
 * @param {boolean} hasComponents - Whether items render component tags.
 * @returns {string} Statements for a `__wizzRecord` in scope.
 */
function removeRecordSource(parentSource, ownsScope, hasComponents) {
  if (hasComponents) {
    return `for (const __wizzDropItem of __wizzRecord.drop) __wizzDropItem(); if (__wizzRecord.node.parentNode === ${parentSource}) ${parentSource}.removeChild(__wizzRecord.node);`;
  }
  return ownsScope
    ? `${parentSource}.removeChild(__wizzRecord.node); for (const __wizzDropItem of __wizzRecord.drop) __wizzDropItem();`
    : `${parentSource}.removeChild(__wizzRecord.node);`;
}

/**
 * Collects the factory-scope reference variable names for component tags that
 * carry reactive props. The generated create() assigns the mounted instance
 * and the generated update() reads it to deliver prop updates.
 * @param {Object} templateAST - The analyzed template AST.
 * @param {Array<{name: string}>} componentImports - The component's imports.
 * @returns {string[]} Reference variable names in template order.
 */
function collectComponentRefNames(templateAST, componentImports = []) {
  const importedComponents = new Set(componentImports.map((component) => component.name));
  const refNames = [];

  function walk(node) {
    // Components inside an each item belong to their record (one instance
    // per row) and receive setProps() from the record's update().
    if (node.type === 'EachBlock') return;
    if (node.type === 'Element' && importedComponents.has(node.name)
      && (node.attributes || []).some((attribute) => attribute.dynamic && attribute.dependencies?.length > 0)) {
      refNames.push(`__wizzComponent_${node.componentId}`);
    }
    if (node.type === 'IfBlock') {
      // The parser's `children` alias repoints to the alternate at {:else},
      // so both branches are walked explicitly.
      (node.consequent || []).forEach(walk);
      (node.alternate || []).forEach(walk);
      return;
    }
    (node.children || []).forEach(walk);
    (node.alternate || []).forEach(walk);
  }

  walk(templateAST);
  return refNames;
}

/**
 * Generates the create() lifecycle function for a component, followed by one
 * branch-maker function per branch of every reactive `{#if}` block.
 *
 * Makers sit beside create() at factory scope and take `(parent, anchor)`,
 * so the hydration walk can call the same ones when an adopted block later
 * changes branch. Each returns the scope record described in blockScopes.js.
 * Inside a maker (and inside an each item) listeners attach through
 * `__wizzOn` and are owned by the enclosing scope's `__wizzDrop` array rather
 * than the component-wide `__wizzListeners`, so a replaced branch or a
 * removed item takes its listeners with it.
 * @param {Object} templateAST - The enriched template AST.
 * @param {Array} [componentImports] - Imported component descriptors.
 * @param {WeakMap<Object, string>} [handlerSources] - Instrumented `on:`
 *   handler sources keyed by attribute; absent entries emit the raw value.
 * @param {Map<Object, string>} [updateTargets] - update() target variables by
 *   AST node (`collectUpdateTargets().names`); create() assigns each one.
 * @returns {string} The generated JavaScript string.
 */
function generateCreateFunction(templateAST, componentImports = [], handlerSources = new WeakMap(), updateTargets = new Map()) {
  let builder = new CodeBuilder();
  let nodeCounter = 0;
  const { ifIds } = analyzeBlocks(templateAST);
  const makerSources = [];
  // The block scope being emitted: null for the component scope, otherwise
  // the update-target variables the current branch maker assigns.
  let scope = null;
  const importedComponents = new Set(componentImports.map((component) => component.name));

  builder.add('function __wizzCreate(__wizzCtx) {')
        .indent()
      .add('const __wizzChildren = [];')
      .add('const __wizzChildMounts = [];')
      .add('const __wizzLists = [];');

  // A map to keep track of which JS variable name corresponds to which AST node
  const nodeVariables = new Map();

  // Attaches a created node. A branch's own top-level nodes go in front of the
  // block anchor and are tracked for removal; everything else is appended.
  function attach(parentVarName, varName, top, track = true) {
    if (!top) {
      builder.add(`${parentVarName}.appendChild(${varName});`);
      return;
    }
    builder.add(`${parentVarName}.insertBefore(${varName}, __wizzAnchor);`);
    if (track) builder.add(`__wizzNodes.push(${varName});`);
  }

  function emitMaker(id, key, children) {
    const outerBuilder = builder;
    const outerScope = scope;
    builder = new CodeBuilder();
    scope = { targets: [] };
    const name = makerName(id, key);
    builder.add(`function ${name}(__wizzParent, __wizzAnchor) {`)
      .indent()
      .add('const __wizzLists = [];')
      .add('const __wizzDrop = [];')
      .add('const __wizzChildMounts = [];')
      .add('const __wizzNodes = [];');
    children.forEach((child) => walk(child, '__wizzParent', true));
    if (scope.targets.length > 0) {
      // update() guards its writes on these, so a dropped branch is skipped.
      builder.add(`__wizzDrop.push(() => { ${scope.targets.join(' = ')} = null; });`);
    }
    builder.add('return { lists: __wizzLists, drop: __wizzDrop, mounts: __wizzChildMounts, nodes: __wizzNodes };')
      .dedent()
      .add('}');
    makerSources.push(builder.generate());
    builder = outerBuilder;
    scope = outerScope;
    return name;
  }

  function walk(node, parentVarName, top = false) {
    if (node.type === 'EachBlock') {
      if (!parentVarName) throw compilerDiagnostic(CODES.generator.eachOutsideElement, 'Each blocks must be nested inside an element.');
      const contentNodes = node.children.filter((child) => child.type !== 'Text' || child.value.trim() !== '');
      if (contentNodes.length !== 1 || contentNodes[0].type !== 'Element') {
        throw compilerDiagnostic(CODES.generator.eachRootCount, 'Each blocks must contain exactly one root element.');
      }

      const listId = ++nodeCounter;
      const anchorName = `__wizzAnchor_${listId}`;
      const recordsName = `__wizzRecords_${listId}`;
      const createName = `__wizzCreateItem_${listId}`;
      const updateName = `__wizzUpdateList_${listId}`;
      const itemRoot = contentNodes[0];
      // Items with listeners or child components own them through a
      // per-record `drop` array.
      const hasListeners = eachHasListeners(node);
      const hasComponents = eachHasComponents(node);
      const ownsScope = hasListeners || hasComponents;
      const rootIsComponent = importedComponents.has(itemRoot.name);
      // Child components inside items mount once the item is attached:
      // createItem queues them on `__wizzMounts`, which updateList runs after
      // inserting its records (or hands to the enclosing scope's deferred
      // mounts on the first pass, before this tree is in the document).
      const itemComponents = new Map();

      builder.add(`const ${anchorName} = document.createTextNode("");`);
      attach(parentVarName, anchorName, top);
      builder.add(`const ${recordsName} = new Map();`)
        .add(`function ${createName}(${node.item}${hasComponents ? ', __wizzMounts' : ''}) {`).indent();
      if (ownsScope) builder.add('const __wizzDrop = [];');

      const listNodeVariables = new Map();
      function walkListNode(listNode, listParentName) {
        const listVarName = `__wizzNode_${++nodeCounter}`;
        listNodeVariables.set(listNode, listVarName);
        if (listNode.type === 'Element' && importedComponents.has(listNode.name)) {
          const parts = itemComponentParts(listNode);
          itemComponents.set(listNode, parts);
          builder.add(`const ${listVarName} = document.createTextNode("");`)
            .add(`let ${parts.childVar} = null;`);
          if (listParentName) builder.add(`${listParentName}.appendChild(${listVarName});`);
          itemComponentMountLines(listNode, listVarName, parts, listNode === itemRoot).forEach((line) => builder.add(line));
          return listVarName;
        }
        if (listNode.type === 'Element') {
          builder.add(`const ${listVarName} = document.createElement(${JSON.stringify(listNode.name)});`);
          for (const attribute of listNode.attributes || []) {
            if (attribute.dynamic) {
              builder.add(attributeWriteSource(listVarName, attribute.name, attribute.value, { bind: attribute.bind }));
            } else if (isEventAttribute(attribute)) {
              // The handler expression is evaluated once per item, with the
              // item variable in scope; update() below keeps that variable
              // pointing at the item's latest value.
              const { eventName, handler } = eventListenerParts(attribute, handlerSources);
              builder.add(`__wizzDrop.push(__wizzOn(${listVarName}, ${JSON.stringify(eventName)}, ${handler}));`);
            } else {
              builder.add(attribute.value === null
                ? `${listVarName}.setAttribute(${JSON.stringify(attribute.name)}, "");`
                : `${listVarName}.setAttribute(${JSON.stringify(attribute.name)}, ${JSON.stringify(attribute.value)});`);
            }
          }
        } else if (listNode.type === 'Text') {
          builder.add(`const ${listVarName} = document.createTextNode(${JSON.stringify(listNode.value)});`);
        } else if (listNode.type === 'Expression') {
          builder.add(`const ${listVarName} = document.createTextNode(String(${listNode.value}));`);
        } else {
          throw compilerDiagnostic(CODES.generator.eachBodyUnsupported, `Each block bodies do not support '${listNode.type}' nodes yet.`);
        }
        if (listParentName) builder.add(`${listParentName}.appendChild(${listVarName});`);
        (listNode.children || []).forEach((child) => walkListNode(child, listVarName));
        return listVarName;
      }
      const itemRootName = walkListNode(itemRoot, null);
      // The record is named when a root component's mount must repoint its
      // node at the child's root.
      builder.add(hasComponents ? 'const __wizzRecord = {' : 'return {')
        .indent()
        .add(`node: ${itemRootName},`);
      if (ownsScope) {
        // Handlers and deferred child mounts close over the item parameter,
        // so an update rebinds it: a keyed item replaced by a new object must
        // not leave them reading the old one.
        builder.add('drop: __wizzDrop,')
          .add('update(__wizzItem) {').indent()
          .add(`${node.item} = __wizzItem;`);
      } else {
        builder.add(`update(${node.item}) {`).indent();
      }

      function emitListUpdates(listNode) {
        const listVarName = listNodeVariables.get(listNode);
        if (itemComponents.has(listNode)) {
          const { setPropsSource } = itemComponents.get(listNode);
          if (setPropsSource) builder.add(setPropsSource);
          return;
        }
        if (listNode.type === 'Element') {
          for (const attribute of listNode.attributes || []) {
            if (!attribute.dynamic) continue;
            builder.add(attributeWriteSource(listVarName, attribute.name, attribute.value, { bind: attribute.bind }));
          }
          (listNode.children || []).forEach((child, childIndex) => {
            if (child.type === 'Expression') builder.add(`${listVarName}.childNodes[${childIndex}].nodeValue = String(${child.value});`);
            emitListUpdates(child);
          });
        }
      }
      emitListUpdates(itemRoot);
      builder.dedent().add('}')
        .dedent().add('};');
      if (hasComponents) builder.add('return __wizzRecord;');
      const removeRecord = removeRecordSource(parentVarName, ownsScope, hasComponents);
      builder.dedent().add('}')
        // The `__wizz` prefix keeps these locals clear of the author's item and
        // collection names, which share this scope.
        .add(`function ${updateName}(__wizzItems${hasComponents ? ', __wizzMounts' : ''}) {`).indent();
      // Without a deferred list, mounts run once this pass placed its records.
      if (hasComponents) builder.add('const __wizzPendingMounts = __wizzMounts || [];');
      builder.add('const __wizzNext = new Map();')
        .add('const __wizzSeen = new Set();')
        .add(`__wizzItems.forEach((${node.item}${node.key ? '' : `, __wizzIndex_${listId}`}) => {`).indent()
        .add(node.key ? `const __wizzKey = ${node.item}.${node.key};` : `const __wizzKey = __wizzIndex_${listId};`)
        .add('if (__wizzSeen.has(__wizzKey)) throw new Error("Each block keys must be unique.");')
        .add('__wizzSeen.add(__wizzKey);')
        .add(`let __wizzRecord = ${recordsName}.get(__wizzKey);`)
        .add(`if (__wizzRecord) __wizzRecord.update(${node.item});`)
        .add(`else __wizzRecord = ${createName}(${node.item}${hasComponents ? ', __wizzPendingMounts' : ''});`)
        .add(`${parentVarName}.insertBefore(__wizzRecord.node, ${anchorName});`)
        .add('__wizzNext.set(__wizzKey, __wizzRecord);')
        .dedent().add('});')
        .add(`${recordsName}.forEach((__wizzRecord, __wizzKey) => { if (!__wizzNext.has(__wizzKey)) ${ownsScope ? `{ ${removeRecord} }` : removeRecord} });`)
        .add(`${recordsName}.clear();`)
        .add(`__wizzNext.forEach((__wizzRecord, __wizzKey) => ${recordsName}.set(__wizzKey, __wizzRecord));`);
      if (hasComponents) builder.add('if (!__wizzMounts) for (const __wizzMount of __wizzPendingMounts) __wizzMount();');
      builder.dedent().add('}')
        .add(`${updateName}(${node.collection}${hasComponents ? ', __wizzChildMounts' : ''});`)
        .add(`__wizzLists.push((__wizzChanged) => { if (__wizzChanged.${node.collection}) ${updateName}(${node.collection}); });`);
      if (ownsScope || top) {
        // The owning scope releases the live records: their listeners and
        // children always, and their nodes when the list sits directly in a
        // replaced branch (deeper lists leave the DOM with the element that
        // holds them).
        builder.add('__wizzDrop.push((__wizzDetach) => {').indent()
          .add(`${recordsName}.forEach((__wizzRecord) => {`).indent();
        if (ownsScope) builder.add('for (const __wizzDropItem of __wizzRecord.drop) __wizzDropItem();');
        if (top) {
          builder.add(hasComponents
            ? `if (__wizzDetach && __wizzRecord.node.parentNode === ${parentVarName}) ${parentVarName}.removeChild(__wizzRecord.node);`
            : `if (__wizzDetach) ${parentVarName}.removeChild(__wizzRecord.node);`);
        }
        builder.dedent().add('});')
          .add(`${recordsName}.clear();`)
          .dedent().add('});');
      }
      return null;
    }
    if (node.type === 'IfBlock') {
      if (isReactiveIf(node)) {
        // The anchor marks the block's position; branch nodes always sit in
        // front of it.
        const id = ifIds.get(node);
        const anchorName = `__wizzIfAnchor_${id}`;
        const blockName = `__wizzIf_${id}`;
        builder.add(`const ${anchorName} = document.createTextNode("");`);
        attach(parentVarName, anchorName, top);
        const consequentMaker = emitMaker(id, 1, node.consequent || []);
        const alternateMaker = node.alternate ? emitMaker(id, 0, node.alternate) : 'null';
        builder.add(`const ${blockName} = __wizzIfBlock(${parentVarName}, ${anchorName}, () => (${node.test}), [${alternateMaker}, ${consequentMaker}], -1, null);`)
          // Child mounts are deferred with the rest of this scope's.
          .add(`${blockName}.sync({}, true, __wizzChildMounts);`)
          .add(`__wizzLists.push((__wizzChanged) => ${blockName}.sync(__wizzChanged, ${ifRecheckSource(node)}));`)
          .add(`__wizzDrop.push(${blockName}.drop);`);
        return null;
      }
      // No reactive dependency: the test can never change after mount, so the
      // branch is selected inline and its content belongs to the enclosing scope.
      builder.add(`if (${node.test}) {`).indent();
      node.consequent.forEach((child) => walk(child, parentVarName, top));
      builder.dedent();
      if (node.alternate) {
        builder.add('} else {').indent();
        node.alternate.forEach((child) => walk(child, parentVarName, top));
        builder.dedent();
      }
      builder.add('}');
      return null;
    }
    nodeCounter++;
    const varName = `__wizzNode_${nodeCounter}`;
    nodeVariables.set(node, varName);

    if (node.type === 'Element') {
      if (importedComponents.has(node.name)) {
        if (!parentVarName) {
          throw compilerDiagnostic(CODES.generator.componentOutsideElement, `Component <${node.name}> must be nested inside an element.`);
        }
        if (node.children.length > 0) {
          throw compilerDiagnostic(CODES.generator.componentChildrenUnsupported, `Component <${node.name}> does not support children.`);
        }
        const propsSource = buildComponentPropsSource(node);
        const hasReactiveProps = (node.attributes || []).some((attribute) => attribute.dynamic && attribute.dependencies?.length > 0);

        // Children mount after this tree is attached, so a placeholder holds
        // the tag's position until the child inserts its root before it. It is
        // removed straight after, leaving the DOM hydration would adopt.
        if (hasReactiveProps && node.componentId == null) {
          throw compilerDiagnostic(CODES.generator.missingComponentId, `Component <${node.name}> is missing its componentId; run the analyzer before generation.`);
        }
        builder.add(`const ${varName} = document.createTextNode("");`);
        // The placeholder is never tracked: the mount below removes it.
        attach(parentVarName, varName, top, false);
        builder.add('__wizzChildMounts.push(() => {').indent();
        if (scope) {
          // A child mounted in a branch is owned by that branch's scope, not
          // the component-wide list, so replacing the branch destroys it.
          builder.add(`const __wizzChild = ${node.name}(${parentVarName}, ${propsSource}, ${varName});`);
          if (hasReactiveProps) {
            builder.add(`__wizzComponent_${node.componentId} = __wizzChild;`)
              .add(`__wizzDrop.push(() => { __wizzChild.destroy(); __wizzComponent_${node.componentId} = null; });`);
          } else {
            builder.add('__wizzDrop.push(() => __wizzChild.destroy());');
          }
        } else if (hasReactiveProps) {
          // The mounted instance is kept in a factory-scope reference so
          // update() can deliver prop changes without remounting.
          const refName = `__wizzComponent_${node.componentId}`;
          builder.add(`${refName} = ${node.name}(${parentVarName}, ${propsSource}, ${varName});`);
          builder.add(`__wizzChildren.push(${refName});`);
        } else {
          builder.add(`__wizzChildren.push(${node.name}(${parentVarName}, ${propsSource}, ${varName}));`);
        }
        builder.add(`${parentVarName}.removeChild(${varName});`)
          .dedent().add('});');
        return null;
      }

      builder.add(`const ${varName} = document.createElement(${JSON.stringify(node.name)});`);

      // Add attributes (including your data-wizz-id)
      if (node.attributes) {
        node.attributes.forEach(attr => {
          if (attr.dynamic) {
            builder.add(attributeWriteSource(varName, attr.name, attr.value, { bind: attr.bind }));
            return;
          }
          if (isEventAttribute(attr)) {
            const { eventName, handler } = eventListenerParts(attr, handlerSources);
            builder.add(scope
              ? `__wizzDrop.push(__wizzOn(${varName}, ${JSON.stringify(eventName)}, ${handler}));`
              : `__wizzListen(${varName}, ${JSON.stringify(eventName)}, ${handler});`);
            return;
          }

          // If it's a boolean attribute like 'hidden', value is null
          if (attr.value === null) {
            builder.add(`${varName}.setAttribute(${JSON.stringify(attr.name)}, "");`);
          } else {
            builder.add(`${varName}.setAttribute(${JSON.stringify(attr.name)}, ${JSON.stringify(attr.value)});`);
          }
        });
      }
    } else if (node.type === 'Text') {
      builder.add(`const ${varName} = document.createTextNode(${JSON.stringify(node.value)});`);
    } else if (node.type === 'Expression') {
      builder.add(`const ${varName} = document.createTextNode(String(${node.value}));`);
    }

    if (updateTargets.has(node)) {
      builder.add(`${updateTargets.get(node)} = ${varName};`);
      if (scope) scope.targets.push(updateTargets.get(node));
    }

    // If this node has a parent, attach it immediately
    if (parentVarName && varName) attach(parentVarName, varName, top);

    // Traverse children
    if (node.children && Array.isArray(node.children)) {
      node.children.forEach(child => {
        walk(child, varName);
      });
    }

    return varName;
  }

  // Components currently require one top-level element; ignore formatting text around it.
  const rootNode = templateAST.children.find(node => node.type === 'Element');
  if (!rootNode) {
    throw compilerDiagnostic(CODES.generator.missingRootElement, 'Component template must contain a root element.');
  }
  const rootVarName = walk(rootNode, null);

    builder.add(`${rootVarName}.__wizzChildComponents = __wizzChildren;`)
      .add(`${rootVarName}.__wizzMountChildren = () => __wizzChildMounts.forEach((mount) => mount());`)
      .add(`${rootVarName}.__wizzListUpdates = __wizzLists;`)
      .add(`return ${rootVarName};`)
        .dedent()
        .add('}');

  return [builder.generate(), ...makerSources].join('\n');
}

module.exports = {
  generateCreateFunction,
  collectComponentRefNames,
  buildComponentPropsSource,
  eventListenerParts,
  itemComponentParts,
  itemComponentMountLines,
  removeRecordSource
};
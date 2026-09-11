// src/compiler/generator/hydrationGenerator.js
const { CodeBuilder } = require('./codeBuilder');
const { buildComponentPropsSource } = require('./domGenerator');

// Attributes the browser target assigns as properties rather than attributes.
const PROPERTY_ATTRIBUTES = new Set(['value', 'checked', 'disabled']);

/**
 * Generates the hydrateCreate() adoption walk for hydratable components.
 * The emitted function attaches to the server-rendered DOM in the same
 * pre-order the create() walk builds it, verifies each position against the
 * template AST, collects event listeners for deferred attachment, and reports
 * any mismatch once before falling back to a full client render.
 *
 * The walk relies on three invariants of the server target:
 * - adjacency markers (`<!-- -->`) separate text-like siblings and bracket
 *   block boundaries; they are stripped per element before positions are
 *   compared, leaving childNodes aligned one-to-one with the template AST;
 * - `data-wizz-id` attributes appear on the same elements the analyzer
 *   stamped, and are verified from the AST attribute, never from a counter;
 * - text content is rendered from the same expressions this walk re-evaluates
 *   against the seeded reactive bindings.
 *
 * Milestone 14 extends adoption to the full template surface: `{#if}` blocks
 * are adopted by re-evaluating the test against the seeded state (the same
 * expression the server evaluated at render time, so both targets select the
 * same branch unless the author's script is nondeterministic), `{#each}`
 * lists are adopted per item with their records map rebuilt and the list
 * anchor created (an empty text node cannot survive HTML serialization), and
 * imported component tags are adopted through the child module's hydrateRoot
 * export, which remounts inside the child's own root on mismatch so a nested
 * fallback never fails the parent.
 * @param {Object} templateAST - The analyzed template AST.
 * @param {Array<{name: string}>} componentImports - The component's imports;
 *   rendered tags adopt the matching child hydratable module.
 * @returns {string} The hydration section source for the factory closure.
 */
function generateHydrationFunction(templateAST, componentImports = []) {
  const builder = new CodeBuilder();
  let referenceCounter = 0;
  const nextReference = () => `node_${++referenceCounter}`;
  let listCounter = 0;

  const rootNode = templateAST.children.find(node => node.type === 'Element');
  if (!rootNode) {
    throw new SyntaxError('Component template must contain a root element.');
  }

  const importedNames = new Set(componentImports.map((component) => component.name));

  builder.add('// --- Hydration ---');
  builder.add('function __wizzNodeTag(node) {');
  builder.add("  return typeof node.tagName === 'string' ? node.tagName.toLowerCase() : null;");
  builder.add('}');
  builder.add('function __wizzStripComments(node) {');
  builder.add('  for (let i = node.childNodes.length - 1; i >= 0; i--) {');
  builder.add('    if (node.childNodes[i].nodeType === 8) node.removeChild(node.childNodes[i]);');
  builder.add('  }');
  builder.add('}');
  builder.add('function __wizzDescribe(node) {');
  builder.add("  if (!node) return 'nothing';");
  builder.add("  if (node.nodeType === 8) return 'a comment';");
  builder.add("  if (node.nodeType === 3) return 'text ' + JSON.stringify(node.nodeValue);");
  builder.add("  return '<' + (__wizzNodeTag(node) ?? 'unknown') + '>';");
  builder.add('}');

  // Prototype-safe lookup of a nested component's state slice. Serialized
  // state is author-influenced data, so every level is guarded with
  // hasOwnProperty before access.
  if (componentTagsExist(templateAST, importedNames)) {
    builder.add('function __wizzReadSlice(state, key) {');
    builder.add("  if (!state || typeof state !== 'object' || Array.isArray(state)) return {};");
    builder.add('  const __wizz = state.__wizz;');
    builder.add("  if (!__wizz || typeof __wizz !== 'object' || !Object.prototype.hasOwnProperty.call(__wizz, 'components')) return {};");
    builder.add('  const components = __wizz.components;');
    builder.add("  if (!components || typeof components !== 'object' || !Object.prototype.hasOwnProperty.call(components, key)) return {};");
    builder.add('  const slice = components[key];');
    builder.add("  return (slice && typeof slice === 'object' && !Array.isArray(slice)) ? slice : {};");
    builder.add('}');
  }

  builder.add('function hydrateCreate(target, state, adoptSelf) {');
  builder.add('  const problems = [];');
  builder.add('  const pendingListeners = [];');
  builder.add('  const childComponents = [];');
  builder.add('  const listUpdates = [];');

  // The mount point's first element is adopted as the component root; a
  // self-adopted root (nested hydration) is the given node itself, which is
  // already in the parent's DOM at the component's position.
  builder.add('  const rootNode = adoptSelf ? target : target.firstElementChild;');
  builder.add('  if (!rootNode) {');
  builder.add(`    problems.push('expected root <${rootNode.name}>, found nothing');`);
  builder.add(`  } else if (__wizzNodeTag(rootNode) !== '${rootNode.name.toLowerCase()}') {`);
  builder.add(`    problems.push('expected root <${rootNode.name}>, found ' + __wizzDescribe(rootNode));`);
  builder.add('  }');

  const expectedTextLiteral = (value) => JSON.stringify(JSON.stringify(value));

  function emitDataWizzIdCheck(ref, elementNode) {
    const idAttribute = (elementNode.attributes || []).find(attribute => attribute.name === 'data-wizz-id');
    if (!idAttribute) return;
    builder.add(`  if (problems.length === 0 && ${ref}.getAttribute('data-wizz-id') !== ${JSON.stringify(idAttribute.value)}) {`);
    builder.add(`    problems.push('expected data-wizz-id="${idAttribute.value}" on <${elementNode.name}>, found ' + JSON.stringify(${ref}.getAttribute('data-wizz-id')));`);
    builder.add('  }');
  }

  function emitListenerCollection(ref, elementNode) {
    for (const attribute of elementNode.attributes || []) {
      if (!attribute.name.startsWith('on:')) continue;
      builder.add('  if (problems.length === 0) {');
      builder.add(`    pendingListeners.push([${ref}, ${JSON.stringify(attribute.name.slice(3))}, ${attribute.value}]);`);
      builder.add('  }');
    }
  }

  function emitTextChild(child, parentRef, cursorRef) {
    const ref = nextReference();
    builder.add('  if (problems.length === 0) {');
    builder.add(`    const ${ref} = ${parentRef}.childNodes[${cursorRef}];`);
    builder.add(`    if (!${ref} || ${ref}.nodeType !== 3 || ${ref}.nodeValue !== ${JSON.stringify(child.value)}) {`);
    builder.add(`      problems.push('expected text ' + ${expectedTextLiteral(child.value)} + ' at index ' + ${cursorRef} + ' of <' + __wizzNodeTag(${parentRef}) + '>, found ' + __wizzDescribe(${ref}));`);
    builder.add('    }');
    builder.add(`    ${cursorRef} += 1;`);
    builder.add('  }');
  }

  function emitExpressionChild(child, parentRef, cursorRef) {
    const ref = nextReference();
    builder.add('  if (problems.length === 0) {');
    builder.add(`    const ${ref} = ${parentRef}.childNodes[${cursorRef}];`);
    // The delivered markup escaped this expression's output; the browser's
    // parser has decoded it again, so compare against the raw runtime value.
    builder.add(`    if (!${ref} || ${ref}.nodeType !== 3 || ${ref}.nodeValue !== String(${child.value})) {`);
    builder.add(`      problems.push('expected expression text at index ' + ${cursorRef} + ' of <' + __wizzNodeTag(${parentRef}) + '>, found ' + __wizzDescribe(${ref}));`);
    builder.add('    }');
    builder.add(`    ${cursorRef} += 1;`);
    builder.add('  }');
  }

  function emitElementChild(elementNode, parentRef, cursorRef) {
    const ref = nextReference();
    builder.add(`  let ${ref} = null;`);
    builder.add('  if (problems.length === 0) {');
    builder.add(`    ${ref} = ${parentRef}.childNodes[${cursorRef}];`);
    builder.add(`    if (__wizzNodeTag(${ref}) !== '${elementNode.name.toLowerCase()}') {`);
    builder.add(`      problems.push('expected <${elementNode.name}> at index ' + ${cursorRef} + ' of <' + __wizzNodeTag(${parentRef}) + '>, found ' + __wizzDescribe(${ref}));`);
    builder.add('    }');
    builder.add(`    ${cursorRef} += 1;`);
    builder.add('  }');
    emitDataWizzIdCheck(ref, elementNode);
    emitListenerCollection(ref, elementNode);
    walkChildren(elementNode, ref);
  }

  // A component tag creates no element of its own: its rendered root occupies
  // exactly one child position. Only the presence of an element is verified
  // here — tag verification is the child's own first check, and structural
  // problems inside the child remount inside the child's root without
  // failing this parent. Adoption itself runs after the whole walk passes.
  function emitComponentChild(componentNode, parentRef, cursorRef) {
    if (componentNode.componentId == null) {
      throw new SyntaxError(`Component <${componentNode.name}> is missing its componentId; run the analyzer before generation.`);
    }
    const ref = nextReference();
    builder.add(`  let ${ref} = null;`);
    builder.add('  if (problems.length === 0) {');
    builder.add(`    ${ref} = ${parentRef}.childNodes[${cursorRef}];`);
    builder.add(`    if (!${ref} || ${ref}.nodeType !== 1) {`);
    builder.add(`      problems.push('expected <${componentNode.name}> at index ' + ${cursorRef} + ' of <' + __wizzNodeTag(${parentRef}) + '>, found ' + __wizzDescribe(${ref}));`);
    builder.add('    }');
    builder.add(`    ${cursorRef} += 1;`);
    builder.add('  }');
    return ref;
  }

  function emitIfBlock(node, parentRef, cursorRef, emitFlattenedChild) {
    // The server selected its branch by evaluating this same test against the
    // render-time state; re-evaluating it against the seeded state selects
    // the same branch, so the flattened positions align. (A nondeterministic
    // author script can diverge here; the walk then falls back cleanly.)
    builder.add('  if (problems.length === 0) {').indent();
    builder.add(`    if (${node.test}) {`).indent();
    (node.consequent || []).forEach(child => emitFlattenedChild(child, parentRef, cursorRef));
    builder.dedent();
    if (node.alternate) {
      builder.add('    } else {').indent();
      (node.alternate || []).forEach(child => emitFlattenedChild(child, parentRef, cursorRef));
      builder.dedent();
    }
    builder.add('    }');
    builder.dedent().add('  }');
  }

  function emitEachBlock(node, parentRef, cursorRef) {
    const listId = ++listCounter;
    emitListMachinery(listId, node);
    builder.add('  if (problems.length === 0) {');
    builder.add(`    ${cursorRef} += hydrateList_${listId}(${parentRef}, ${cursorRef});`);
    builder.add('  }');
  }

  /**
   * Emits the per-list adoption machinery for one EachBlock, mirroring the
   * browser target's list implementation: item roots are verified and adopted
   * positionally, the records map is rebuilt with key-aware update closures,
   * and the list anchor (an empty text node that cannot survive HTML
   * serialization) is created after the adopted run. Fresh items created by
   * later client updates reuse the same record shape the browser target
   * builds, so updateList semantics match exactly.
   */
  function emitListMachinery(listId, node) {
    const itemVar = node.item;
    const recordsRef = `records_${listId}`;
    const anchorRef = `anchor_${listId}`;
    const contentNodes = node.children.filter((child) => child.type !== 'Text' || child.value.trim() !== '');
    const itemRoot = contentNodes[0];
    const keylessIndex = `index_${listId}`;

    const itemVars = new Map();

    builder.add(`  const ${recordsRef} = new Map();`);
    builder.add(`  let ${anchorRef} = null;`);

    // Per-item verification: the item variable is in scope, so expression
    // text is re-evaluated per item exactly as the server rendered it.
    builder.add(`  function hydrateListItem_${listId}(${itemVar}, parentRef, index) {`).indent();
    const rootVar = `node_${listId}_root`;
    builder.add(`    const ${rootVar} = parentRef.childNodes[index];`);
    builder.add(`    if (!${rootVar} || ${rootVar}.nodeType !== 1 || __wizzNodeTag(${rootVar}) !== '${itemRoot.name.toLowerCase()}') {`).indent();
    builder.add(`      problems.push('expected <${itemRoot.name}> at index ' + index + ' of <' + __wizzNodeTag(parentRef) + '>, found ' + __wizzDescribe(${rootVar}));`);
    builder.add('      return null;');
    builder.dedent().add('    }');
    itemVars.set(itemRoot, rootVar);

    const walkItemNode = (listNode, parentVar) => {
      builder.add(`    __wizzStripComments(${parentVar});`);
      (listNode.children || []).forEach((child, childIndex) => {
        const childVar = `node_${listId}_${childIndex}_${itemVars.size}`;
        if (child.type === 'Element') {
          builder.add(`    const ${childVar} = ${parentVar}.childNodes[${childIndex}];`);
          builder.add(`    if (!${childVar} || ${childVar}.nodeType !== 1 || __wizzNodeTag(${childVar}) !== '${child.name.toLowerCase()}') {`).indent();
          builder.add(`      problems.push('expected <${child.name}> at index ${childIndex} of <' + __wizzNodeTag(${parentVar}) + '>, found ' + __wizzDescribe(${childVar}));`);
          builder.add('      return null;');
          builder.dedent().add('    }');
          itemVars.set(child, childVar);
          walkItemNode(child, childVar);
          return;
        }
        if (child.type === 'Text') {
          builder.add(`    if (!${parentVar}.childNodes[${childIndex}] || ${parentVar}.childNodes[${childIndex}].nodeType !== 3 || ${parentVar}.childNodes[${childIndex}].nodeValue !== ${JSON.stringify(child.value)}) {`).indent();
          builder.add(`      problems.push('expected text at index ${childIndex} of <' + __wizzNodeTag(${parentVar}) + '>, found ' + __wizzDescribe(${parentVar}.childNodes[${childIndex}]));`);
          builder.add('      return null;');
          builder.dedent().add('    }');
          return;
        }
        if (child.type === 'Expression') {
          builder.add(`    if (!${parentVar}.childNodes[${childIndex}] || ${parentVar}.childNodes[${childIndex}].nodeType !== 3 || ${parentVar}.childNodes[${childIndex}].nodeValue !== String(${child.value})) {`).indent();
          builder.add(`      problems.push('expected expression text at index ${childIndex} of <' + __wizzNodeTag(${parentVar}) + '>, found ' + __wizzDescribe(${parentVar}.childNodes[${childIndex}]));`);
          builder.add('      return null;');
          builder.dedent().add('    }');
          return;
        }
        // The renderable gate rejects every other node type inside each
        // bodies before a hydratable module is generated.
        throw new SyntaxError(`Hydration does not support ${child.type} nodes inside each blocks.`);
      });
    };
    walkItemNode(itemRoot, rootVar);

    builder.add('    return {').indent();
    builder.add(`      node: ${rootVar},`);
    builder.add(`      update(${itemVar}) {`).indent();
    emitItemUpdates(itemRoot);
    builder.dedent().add('      }');
    builder.dedent().add('    };');
    builder.dedent().add('  }');

    // Positional writes into an adopted (or freshly created) item root,
    // matching the browser target's emitListUpdates exactly.
    function emitItemUpdates(listNode) {
      const varName = itemVars.get(listNode);
      if (listNode.type !== 'Element' || !varName) return;
      for (const attribute of listNode.attributes || []) {
        if (!attribute.dynamic) continue;
        if (PROPERTY_ATTRIBUTES.has(attribute.name)) {
          builder.add(`        ${varName}.${attribute.name} = ${attribute.value};`);
        } else {
          builder.add(`        ${varName}.setAttribute(${JSON.stringify(attribute.name)}, String(${attribute.value}));`);
        }
      }
      (listNode.children || []).forEach((child, childIndex) => {
        if (child.type === 'Expression') builder.add(`        ${varName}.childNodes[${childIndex}].nodeValue = String(${child.value});`);
        emitItemUpdates(child);
      });
    }

    // Fresh item creation for items the client adds after hydration; the
    // emission mirrors the browser target's createItem.
    const freshVars = new Map();
    builder.add(`  function hydrateCreateFreshItem_${listId}(${itemVar}) {`).indent();
    const buildFreshNode = (listNode, listParentName) => {
      const varName = `fresh_${listId}_${freshVars.size}`;
      freshVars.set(listNode, varName);
      if (listNode.type === 'Element') {
        builder.add(`    const ${varName} = document.createElement(${JSON.stringify(listNode.name)});`);
        for (const attribute of listNode.attributes || []) {
          if (attribute.dynamic) {
            if (PROPERTY_ATTRIBUTES.has(attribute.name)) builder.add(`    ${varName}.${attribute.name} = ${attribute.value};`);
            else builder.add(`    ${varName}.setAttribute(${JSON.stringify(attribute.name)}, String(${attribute.value}));`);
          } else {
            builder.add(attribute.value === null
              ? `    ${varName}.setAttribute(${JSON.stringify(attribute.name)}, "");`
              : `    ${varName}.setAttribute(${JSON.stringify(attribute.name)}, ${JSON.stringify(attribute.value)});`);
          }
        }
      } else if (listNode.type === 'Text') {
        builder.add(`    const ${varName} = document.createTextNode(${JSON.stringify(listNode.value)});`);
      } else {
        builder.add(`    const ${varName} = document.createTextNode(String(${listNode.value}));`);
      }
      if (listParentName) builder.add(`    ${listParentName}.appendChild(${varName});`);
      (listNode.children || []).forEach((child) => buildFreshNode(child, varName));
      return varName;
    };
    const freshRoot = buildFreshNode(itemRoot, null);
    builder.add('    return {').indent();
    builder.add(`      node: ${freshRoot},`);
    builder.add(`      update(${itemVar}) {`).indent();
    const emitFreshUpdates = (listNode) => {
      const varName = freshVars.get(listNode);
      if (listNode.type === 'Element') {
        for (const attribute of listNode.attributes || []) {
          if (!attribute.dynamic) continue;
          if (PROPERTY_ATTRIBUTES.has(attribute.name)) builder.add(`        ${varName}.${attribute.name} = ${attribute.value};`);
          else builder.add(`        ${varName}.setAttribute(${JSON.stringify(attribute.name)}, String(${attribute.value}));`);
        }
        (listNode.children || []).forEach((child, childIndex) => {
          if (child.type === 'Expression') builder.add(`        ${varName}.childNodes[${childIndex}].nodeValue = String(${child.value});`);
          emitFreshUpdates(child);
        });
      }
    };
    emitFreshUpdates(itemRoot);
    builder.dedent().add('      }');
    builder.dedent().add('    };');
    builder.dedent().add('  }');

    builder.add(`  function hydrateUpdateList_${listId}() {`).indent();
    builder.add(`    const items = ${node.collection};`);
    builder.add('    const nextRecords = new Map();');
    builder.add('    const seenKeys = new Set();');
    builder.add(`    items.forEach((${itemVar}${node.key ? '' : `, ${keylessIndex}`}) => {`).indent();
    builder.add(node.key ? `      const key = ${itemVar}.${node.key};` : `      const key = ${keylessIndex};`);
    builder.add('      if (seenKeys.has(key)) throw new Error("Each block keys must be unique.");');
    builder.add('      seenKeys.add(key);');
    builder.add(`      let record = ${recordsRef}.get(key);`);
    builder.add(`      if (record) record.update(${itemVar});`);
    builder.add(`      else record = hydrateCreateFreshItem_${listId}(${itemVar});`);
    builder.add(`      ${anchorRef}.parentNode.insertBefore(record.node, ${anchorRef});`);
    builder.add('      nextRecords.set(key, record);');
    builder.dedent().add('    });');
    builder.add(`    ${recordsRef}.forEach((record, key) => { if (!nextRecords.has(key)) ${anchorRef}.parentNode.removeChild(record.node); });`);
    builder.add(`    ${recordsRef}.clear();`);
    builder.add(`    nextRecords.forEach((record, key) => ${recordsRef}.set(key, record));`);
    builder.dedent().add('  }');

    builder.add(`  function hydrateList_${listId}(parentRef, startIndex) {`).indent();
    builder.add(`    const items = ${node.collection};`);
    builder.add('    let index = startIndex;');
    builder.add(`    items.forEach((${itemVar}${node.key ? '' : `, ${keylessIndex}`}) => {`).indent();
    builder.add('      if (problems.length > 0) return;');
    builder.add(node.key ? `      const key = ${itemVar}.${node.key};` : `      const key = ${keylessIndex};`);
    builder.add(`      if (${recordsRef}.has(key)) problems.push('Each block keys must be unique.');`);
    builder.add(`      const record = hydrateListItem_${listId}(${itemVar}, parentRef, index);`);
    builder.add('      if (record) {');
    builder.add(`        ${recordsRef}.set(key, record);`);
    builder.add('        index += 1;');
    builder.add('      }');
    builder.dedent().add('    });');
    // The anchor must exist for future positional updates but cannot survive
    // HTML serialization, so hydration creates it after the adopted run.
    builder.add(`    ${anchorRef} = document.createTextNode('');`);
    builder.add(`    parentRef.insertBefore(${anchorRef}, parentRef.childNodes[index] || null);`);
    builder.add(`    listUpdates.push((changed) => { if (changed.${node.collection}) hydrateUpdateList_${listId}(); });`);
    // The created anchor occupies a real child position of parentRef (and
    // shifts any following siblings), so the consumed count includes it.
    builder.add('    return index - startIndex + 1;');
    builder.dedent().add('  }');
  }

  function walkChildren(elementNode, parentRef) {
    const children = elementNode.children || [];
    // Hydration markers are stripped before anything else so the remaining
    // childNodes align one-to-one with the flattened template children.
    builder.add('  if (problems.length === 0) {');
    builder.add(`    __wizzStripComments(${parentRef});`);
    builder.add('  }');
    const cursorRef = nextReference();
    builder.add(`  let ${cursorRef} = 0;`);

    const emitFlattenedChild = (child) => {
      if (child.type === 'Text') {
        emitTextChild(child, parentRef, cursorRef);
        return;
      }
      if (child.type === 'Expression') {
        emitExpressionChild(child, parentRef, cursorRef);
        return;
      }
      if (child.type === 'Element') {
        if (importedNames.has(child.name)) {
          const ref = emitComponentChild(child, parentRef, cursorRef);
          componentAdoptions.push({ node: child, ref });
          return;
        }
        emitElementChild(child, parentRef, cursorRef);
        return;
      }
      if (child.type === 'IfBlock') {
        emitIfBlock(child, parentRef, cursorRef, emitFlattenedChild);
        return;
      }
      if (child.type === 'EachBlock') {
        emitEachBlock(child, parentRef, cursorRef);
        return;
      }
      throw new SyntaxError(`Hydration does not support ${child.type} nodes.`);
    };

    children.forEach(emitFlattenedChild);

    // Every template position was consumed: the flattened child count must
    // match exactly, including the empty run an untaken branch leaves behind.
    builder.add('  if (problems.length === 0) {');
    builder.add(`    if (${cursorRef} !== ${parentRef}.childNodes.length) {`);
    builder.add(`      problems.push('expected ' + ${cursorRef} + ' child nodes in <' + __wizzNodeTag(${parentRef}) + '>, found ' + ${parentRef}.childNodes.length);`);
    builder.add('    }');
    builder.add('  }');
  }

  const componentAdoptions = [];
  emitDataWizzIdCheck('rootNode', rootNode);
  emitListenerCollection('rootNode', rootNode);
  walkChildren(rootNode, 'rootNode');

  // Component adoption runs only after the whole walk passes: a mismatching
  // parent falls back to a full client render, which mounts its own children.
  for (const adoption of componentAdoptions) {
    const componentNode = adoption.node;
    const idLiteral = JSON.stringify(String(componentNode.componentId));
    builder.add('  if (problems.length === 0) {').indent();
    builder.add(`    const __wizzSlice_${componentNode.componentId} = __wizzReadSlice(state, ${idLiteral});`);
    builder.add(`    const __wizzChild_${componentNode.componentId} = __wizzHydrate_${componentNode.name}.hydrateRoot(${adoption.ref}, ${buildComponentPropsSource(componentNode)}, __wizzSlice_${componentNode.componentId});`);
    builder.add(`    childComponents.push(__wizzChild_${componentNode.componentId});`);
    const hasReactiveProps = (componentNode.attributes || []).some((attribute) => attribute.dynamic && attribute.dependencies?.length > 0);
    if (hasReactiveProps) {
      builder.add(`    component_${componentNode.componentId} = __wizzChild_${componentNode.componentId};`);
    }
    builder.dedent().add('  }');
  }

  builder.add('  if (problems.length > 0) {');
  builder.add("    console.warn('[wizz] hydration mismatch: ' + problems.join('; ') + '. Falling back to client rendering.');");
  builder.add('    while (target.childNodes.length > 0) target.removeChild(target.childNodes[0]);');
  builder.add('    return null;');
  builder.add('  }');
  builder.add('  pendingListeners.forEach((pending) => trackListener(pending[0], pending[1], pending[2]));');
  builder.add('  return { node: rootNode, childComponents, listUpdates };');
  builder.add('}');

  return builder.generate();
}

/**
 * Reports whether the template renders any imported component tag. Component
 * tags cannot appear inside each bodies (the renderable gate refuses them),
 * and IfBlock.children aliases its consequent, so walking consequent plus
 * alternate covers every branch exactly once.
 */
function componentTagsExist(templateAST, importedNames) {
  let found = false;
  const scan = (node) => {
    if (node.type === 'Element') {
      if (importedNames.has(node.name)) return true;
      return (node.children || []).some(scan);
    }
    if (node.type === 'IfBlock') {
      return (node.consequent || []).some(scan) || (node.alternate || []).some(scan);
    }
    return false;
  };
  return (templateAST.children || []).some(scan);
}

module.exports = { generateHydrationFunction };

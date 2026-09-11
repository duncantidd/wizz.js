// src/compiler/generator/domGenerator.js
const { CodeBuilder } = require('./codeBuilder');

// Component attributes are props, not DOM attributes: imported component tags
// create no element, so native attribute semantics never apply to them.
// Static attributes pass their string, bare attributes pass `true`, dynamic
// attributes pass the evaluated expression.
function buildComponentPropsSource(node) {
  const entries = [];
  for (const attribute of node.attributes || []) {
    if (attribute.name === '__proto__') {
      throw new SyntaxError(`'${attribute.name}' cannot be used as a prop name on <${node.name}>.`);
    }
    if (attribute.name.startsWith('on:')) {
      throw new SyntaxError(`Event directive '${attribute.name}' is not supported on component <${node.name}>; component attributes become props.`);
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
    if (node.type === 'Element' && importedComponents.has(node.name)
      && (node.attributes || []).some((attribute) => attribute.dynamic && attribute.dependencies?.length > 0)) {
      refNames.push(`component_${node.componentId}`);
    }
    // IfBlock.children aliases its consequent, so walking children plus
    // alternate covers every branch exactly once.
    (node.children || []).forEach(walk);
    (node.alternate || []).forEach(walk);
  }

  walk(templateAST);
  return refNames;
}

/**
 * Generates the create() lifecycle function for a component.
 * @param {Object} templateAST - The enriched template AST.
 * @returns {string} The generated JavaScript string.
 */
function generateCreateFunction(templateAST, componentImports = []) {
  const builder = new CodeBuilder();
  let nodeCounter = 0;
  const importedComponents = new Set(componentImports.map((component) => component.name));

  builder.add('function create(ctx) {')
        .indent()
      .add('const childComponents = [];')
      .add('const mountChildren = [];')
      .add('const listUpdates = [];');

  // A map to keep track of which JS variable name corresponds to which AST node
  const nodeVariables = new Map();

  function walk(node, parentVarName) {
    if (node.type === 'EachBlock') {
      if (!parentVarName) throw new SyntaxError('Each blocks must be nested inside an element.');
      const contentNodes = node.children.filter((child) => child.type !== 'Text' || child.value.trim() !== '');
      if (contentNodes.length !== 1 || contentNodes[0].type !== 'Element') {
        throw new SyntaxError('Each blocks must contain exactly one root element.');
      }

      const listId = ++nodeCounter;
      const anchorName = `anchor_${listId}`;
      const recordsName = `records_${listId}`;
      const createName = `createItem_${listId}`;
      const updateName = `updateList_${listId}`;
      const itemRoot = contentNodes[0];

      builder.add(`const ${anchorName} = document.createTextNode("");`)
        .add(`${parentVarName}.appendChild(${anchorName});`)
        .add(`const ${recordsName} = new Map();`)
        .add(`function ${createName}(${node.item}) {`).indent();

      const listNodeVariables = new Map();
      function walkListNode(listNode, listParentName) {
        const listVarName = `node_${++nodeCounter}`;
        listNodeVariables.set(listNode, listVarName);
        if (listNode.type === 'Element') {
          if (importedComponents.has(listNode.name)) {
            throw new SyntaxError('Imported components are not supported inside each blocks.');
          }
          const eventAttribute = (listNode.attributes || []).find((attribute) => attribute.name.startsWith('on:'));
          if (eventAttribute) {
            throw new SyntaxError(`Event directive '${eventAttribute.name}' is not supported inside each blocks yet.`);
          }
          builder.add(`const ${listVarName} = document.createElement(${JSON.stringify(listNode.name)});`);
          for (const attribute of listNode.attributes || []) {
            if (attribute.dynamic) {
              if (['value', 'checked', 'disabled'].includes(attribute.name)) builder.add(`${listVarName}.${attribute.name} = ${attribute.value};`);
              else builder.add(`${listVarName}.setAttribute(${JSON.stringify(attribute.name)}, String(${attribute.value}));`);
            } else if (!attribute.name.startsWith('on:')) {
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
          throw new SyntaxError(`Each block bodies do not support '${listNode.type}' nodes yet.`);
        }
        if (listParentName) builder.add(`${listParentName}.appendChild(${listVarName});`);
        (listNode.children || []).forEach((child) => walkListNode(child, listVarName));
        return listVarName;
      }
      const itemRootName = walkListNode(itemRoot, null);
      builder.add('return {')
        .indent()
        .add(`node: ${itemRootName},`)
        .add(`update(${node.item}) {`).indent();

      function emitListUpdates(listNode) {
        const listVarName = listNodeVariables.get(listNode);
        if (listNode.type === 'Element') {
          for (const attribute of listNode.attributes || []) {
            if (!attribute.dynamic) continue;
            if (['value', 'checked', 'disabled'].includes(attribute.name)) builder.add(`${listVarName}.${attribute.name} = ${attribute.value};`);
            else builder.add(`${listVarName}.setAttribute(${JSON.stringify(attribute.name)}, String(${attribute.value}));`);
          }
          (listNode.children || []).forEach((child, childIndex) => {
            if (child.type === 'Expression') builder.add(`${listVarName}.childNodes[${childIndex}].nodeValue = String(${child.value});`);
            emitListUpdates(child);
          });
        }
      }
      emitListUpdates(itemRoot);
      builder.dedent().add('}')
        .dedent().add('};')
        .dedent().add('}')
        .add(`function ${updateName}(items) {`).indent()
        .add('const nextRecords = new Map();')
        .add('const seenKeys = new Set();')
        .add(`items.forEach((${node.item}${node.key ? '' : `, index_${listId}`}) => {`).indent()
        .add(node.key ? `const key = ${node.item}.${node.key};` : `const key = index_${listId};`)
        .add('if (seenKeys.has(key)) throw new Error("Each block keys must be unique.");')
        .add('seenKeys.add(key);')
        .add(`let record = ${recordsName}.get(key);`)
        .add(`if (record) record.update(${node.item});`)
        .add(`else record = ${createName}(${node.item});`)
        .add(`${parentVarName}.insertBefore(record.node, ${anchorName});`)
        .add('nextRecords.set(key, record);')
        .dedent().add('});')
        .add(`${recordsName}.forEach((record, key) => { if (!nextRecords.has(key)) ${parentVarName}.removeChild(record.node); });`)
        .add(`${recordsName}.clear();`)
        .add(`nextRecords.forEach((record, key) => ${recordsName}.set(key, record));`)
        .dedent().add('}')
        .add(`${updateName}(${node.collection});`)
        .add(`listUpdates.push((changed) => { if (changed.${node.collection}) ${updateName}(${node.collection}); });`);
      return null;
    }
    if (node.type === 'IfBlock') {
      builder.add(`if (${node.test}) {`).indent();
      node.consequent.forEach((child) => walk(child, parentVarName));
      builder.dedent();
      if (node.alternate) {
        builder.add('} else {').indent();
        node.alternate.forEach((child) => walk(child, parentVarName));
        builder.dedent();
      }
      builder.add('}');
      return null;
    }
    nodeCounter++;
    const varName = `node_${nodeCounter}`;
    nodeVariables.set(node, varName);

    if (node.type === 'Element') {
      if (importedComponents.has(node.name)) {
        if (!parentVarName) {
          throw new SyntaxError(`Component <${node.name}> must be nested inside an element.`);
        }
        if (node.children.length > 0) {
          throw new SyntaxError(`Component <${node.name}> does not support children.`);
        }
        const propsSource = buildComponentPropsSource(node);
        const hasReactiveProps = (node.attributes || []).some((attribute) => attribute.dynamic && attribute.dependencies?.length > 0);
        if (hasReactiveProps) {
          // The mounted instance is kept in a factory-scope reference so
          // update() can deliver prop changes without remounting.
          if (node.componentId == null) {
            throw new SyntaxError(`Component <${node.name}> is missing its componentId; run the analyzer before generation.`);
          }
          const refName = `component_${node.componentId}`;
          builder.add('mountChildren.push(() => {').indent();
          builder.add(`${refName} = ${node.name}(${parentVarName}, ${propsSource});`);
          builder.add(`childComponents.push(${refName});`);
          builder.dedent().add('});');
        } else {
          builder.add(`mountChildren.push(() => childComponents.push(${node.name}(${parentVarName}, ${propsSource})));`);
        }
        return null;
      }

      builder.add(`const ${varName} = document.createElement(${JSON.stringify(node.name)});`);

      // Add attributes (including your data-wizz-id)
      if (node.attributes) {
        node.attributes.forEach(attr => {
          if (attr.dynamic) {
            if (['value', 'checked', 'disabled'].includes(attr.name)) {
              builder.add(`${varName}.${attr.name} = ${attr.value};`);
            } else {
              builder.add(`${varName}.setAttribute(${JSON.stringify(attr.name)}, String(${attr.value}));`);
            }
            return;
          }
          if (attr.name.startsWith('on:')) {
            const eventName = attr.name.slice(3);
            const handlerExpression = attr.value?.trim();
            if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(eventName)) {
              throw new SyntaxError(`Invalid event directive '${attr.name}'.`);
            }
            if (!handlerExpression) {
              throw new SyntaxError(`Event directive '${attr.name}' requires a handler expression.`);
            }
            builder.add(`trackListener(${varName}, ${JSON.stringify(eventName)}, ${handlerExpression});`);
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

    // If this node has a parent, append it immediately
    if (parentVarName && varName) {
      builder.add(`${parentVarName}.appendChild(${varName});`);
    }

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
    throw new SyntaxError('Component template must contain a root element.');
  }
  const rootVarName = walk(rootNode, null);

    builder.add(`${rootVarName}.__wizzChildComponents = childComponents;`)
      .add(`${rootVarName}.__wizzMountChildren = () => mountChildren.forEach((mount) => mount());`)
      .add(`${rootVarName}.__wizzListUpdates = listUpdates;`)
      .add(`return ${rootVarName};`)
        .dedent()
        .add('}');

  return builder.generate();
}

module.exports = { generateCreateFunction, collectComponentRefNames, buildComponentPropsSource };
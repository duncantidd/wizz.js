// src/compiler/generator/domGenerator.js
const { CodeBuilder } = require('./codeBuilder');

/**
 * Generates the create() lifecycle function for a component.
 * @param {Object} templateAST - The enriched template AST.
 * @returns {string} The generated JavaScript string.
 */
function generateCreateFunction(templateAST) {
  const builder = new CodeBuilder();
  let nodeCounter = 0;

  builder.add('function create(ctx) {')
        .indent();

  // A map to keep track of which JS variable name corresponds to which AST node
  const nodeVariables = new Map();

  function walk(node, parentVarName) {
    nodeCounter++;
    const varName = `node_${nodeCounter}`;
    nodeVariables.set(node, varName);

    if (node.type === 'Element') {
      builder.add(`const ${varName} = document.createElement(${JSON.stringify(node.name)});`);

      // Add attributes (including your data-wizz-id)
      if (node.attributes) {
        node.attributes.forEach(attr => {
          if (attr.name.startsWith('on:')) {
            const eventName = attr.name.slice(3);
            const handlerName = attr.value?.trim();
            if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(eventName)) {
              throw new SyntaxError(`Invalid event directive '${attr.name}'.`);
            }
            if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(handlerName)) {
              throw new SyntaxError(`Event directive '${attr.name}' requires a handler identifier.`);
            }
            builder.add(`${varName}.addEventListener(${JSON.stringify(eventName)}, ${handlerName});`);
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
    if (parentVarName) {
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

  builder.add(`return ${rootVarName};`)
        .dedent()
        .add('}');

  return builder.generate();
}

module.exports = { generateCreateFunction };
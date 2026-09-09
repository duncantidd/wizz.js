const { CodeBuilder } = require('./codeBuilder');

/**
 * Generates the update() lifecycle function for a component's reactivity engine.
 * @param {Object} templateAST - The enriched template AST.
 * @returns {string} The generated JavaScript string.
 */
function generateUpdateFunction(templateAST) {
  const builder = new CodeBuilder();
  const hasEachBlock = (node) => node.type === 'EachBlock'
    || (node.children || []).some(hasEachBlock)
    || (node.consequent || []).some(hasEachBlock)
    || (node.alternate || []).some(hasEachBlock);

  builder.add('function update(ctx, changed) {')
        .indent();

  if (hasEachBlock(templateAST)) {
    builder.add('listUpdates.forEach((updateList) => updateList(changed));');
  }

  function walk(node) {
    if (node.type === 'Element') {
      // Imported component tags receive prop updates through their mounted
      // instance, not through DOM attribute writes.
      if (node.componentId != null) {
        for (const attribute of node.attributes || []) {
          if (!attribute.dynamic || !attribute.dependencies?.length) continue;
          const guard = attribute.dependencies.map((dependencyName) => `changed.${dependencyName}`).join(' || ');
          builder.add(`if (${guard}) {`)
            .indent()
            .add(`if (component_${node.componentId}) component_${node.componentId}.setProps({ ${JSON.stringify(attribute.name)}: ${attribute.value} });`)
            .dedent()
            .add('}');
        }
        return;
      }

      // 1. Get the assigned data-wizz-id (if this element has reactive children)
      const idAttr = node.attributes && node.attributes.find(attr => attr.name === 'data-wizz-id');
      const wizzId = idAttr ? idAttr.value : null;

      for (const attribute of node.attributes || []) {
        if (!attribute.dynamic || !attribute.dependencies?.length) continue;
        for (const dependencyName of attribute.dependencies) {
          builder.add(`if (changed.${dependencyName}) {`)
            .indent()
            .add(`const target_${wizzId} = document.querySelector('[data-wizz-id="${wizzId}"]');`);
          if (['value', 'checked', 'disabled'].includes(attribute.name)) {
            builder.add(`target_${wizzId}.${attribute.name} = ${attribute.value};`);
          } else {
            builder.add(`target_${wizzId}.setAttribute(${JSON.stringify(attribute.name)}, String(${attribute.value}));`);
          }
          builder.dedent().add('}');
        }
      }

      // 2. Iterate through children and track the exact index
      if (node.children && Array.isArray(node.children)) {
        node.children.forEach((child, childIndex) => {
          
          // 3. Find Reactive Expressions
          if (child.type === 'Expression' && child.dependencies && child.dependencies.length > 0) {
            
            // 4. Loop through each dependency and generate an if-block
            child.dependencies.forEach(dependencyName => {
              builder.add(`if (changed.${dependencyName}) {`)
                    .indent();
              
              // Target the exact DOM element via the unique ID
              builder.add(`const target_${wizzId} = document.querySelector('[data-wizz-id="${wizzId}"]');`);
              
              // Update the specific text node at the exact child index.
              // We pull the raw string (e.g., "count + 1") directly from child.value.
              // We wrap it in String() so numeric calculations don't throw type errors in the DOM.
              builder.add(`target_${wizzId}.childNodes[${childIndex}].nodeValue = String(${child.value});`);
              
              builder.dedent()
                    .add('}');
            });
          }
          
          // 5. Continue walking down the tree
          walk(child);
        });
      }
    } else if (node.type === 'Root') {
      // Handle the root node traversal
      if (node.children && Array.isArray(node.children)) {
        node.children.forEach(walk);
      }
    } else if (node.type === 'IfBlock') {
      // Conditional branches exist in the DOM after mount, so their reactive
      // content and component props participate in updates like any other.
      (node.consequent || []).forEach(walk);
      (node.alternate || []).forEach(walk);
    }
  }

  walk(templateAST);

  builder.dedent()
        .add('}');

  return builder.generate();
}

module.exports = { generateUpdateFunction };
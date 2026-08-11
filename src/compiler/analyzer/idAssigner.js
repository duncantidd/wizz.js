/**
 * Traverses the AST and injects unique IDs into elements that contain reactive bindings.
 * @param {Object} astPayload - The enriched payload from the Dependency Analyzer.
 * @returns {Object} The mutated payload with targetable DOM nodes.
 */
function assignNodeIds(astPayload) {
  const { template } = astPayload;
  
  // We use a simple counter for unique IDs
  let nextId = 1;

  function walk(node) {
    if (node.type === 'Element') {
      // 1. Check if this element has any reactive children
      const hasReactiveChildren = node.children && node.children.some(child => 
        child.type === 'Expression' && 
        child.dependencies && 
        child.dependencies.length > 0
      );

      // (Note: Later, when I add support for dynamic attributes like `<div class={dynamicClass}>`, 
      // I would also check for reactive attributes here).

      // 2. If it is reactive, give it a unique ID so the generated JS can find it
      if (hasReactiveChildren) {
        // Ensure the attributes array exists (it should, based on your template parser)
        if (!node.attributes) node.attributes = [];

        const existingId = node.attributes.find(attribute => attribute.name === 'data-wizz-id');
        if (!existingId) {
          node.attributes.push({
            name: 'data-wizz-id',
            value: String(nextId)
          });

          nextId++; // Increment for the next reactive element
        }
      }
    }

    // 3. Continue walking down the tree
    if (node.children && Array.isArray(node.children)) {
      for (let i = 0; i < node.children.length; i++) {
        walk(node.children[i]);
      }
    }
  }

  walk(template);

  return astPayload;
}

module.exports = { assignNodeIds };
/**
 * Traverses the AST and injects unique IDs into elements that contain reactive bindings.
 * Imported component tags receive a stable `componentId` instead so the
 * generated create() and update() code can share one instance reference; they
 * create no DOM and are updated through props, never `data-wizz-id` lookups.
 *
 * When the payload carries a style block, every rendered element is also
 * stamped with the component's `data-wizz-s` scope attribute. It rides the
 * same attribute-stamping path as `data-wizz-id`, so the server emission, the
 * client create() code, and the hydration walk all agree with no new
 * verification logic; components without a style block keep byte-identical
 * markup. An author-written `data-wizz-s` wins over the generated value
 * (conservative: the author owns that element's scope matching).
 * @param {Object} astPayload - The enriched payload from the Dependency Analyzer.
 * @returns {Object} The mutated payload with targetable DOM nodes.
 */
function assignNodeIds(astPayload) {
  const { template } = astPayload;
  const importedNames = new Set((astPayload.imports || []).map((component) => component.name));
  const styleScope = astPayload.style ? astPayload.style.scope : null;

  // We use a simple counter for unique IDs
  let nextId = 1;
  let nextComponentId = 1;

  function walk(node) {
    if (node.type === 'Element') {
      if (importedNames.has(node.name)) {
        node.componentId = nextComponentId;
        nextComponentId += 1;
        // Component tags have no children of their own to target.
        return;
      }

      if (styleScope) {
        if (!node.attributes) node.attributes = [];
        const existingScope = node.attributes.find((attribute) => attribute.name === 'data-wizz-s');
        if (!existingScope) {
          node.attributes.push({ name: 'data-wizz-s', value: styleScope });
        }
      }

      // 1. Check if this element has any reactive children
      const hasReactiveChildren = node.children && node.children.some(child =>
        child.type === 'Expression' &&
        child.dependencies &&
        child.dependencies.length > 0
      );
      const hasReactiveAttributes = node.attributes && node.attributes.some(attribute =>
        attribute.dynamic && attribute.dependencies && attribute.dependencies.length > 0
      );

      // 2. If it is reactive, give it a unique ID so the generated JS can find it
      if (hasReactiveChildren || hasReactiveAttributes) {
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
    if (node.type === 'IfBlock') {
      // The parser's `children` alias repoints to the alternate at {:else},
      // so a children-only walk would miss consequent content in blocks with
      // an else branch. Both branches are walked explicitly instead.
      for (const child of node.consequent || []) walk(child);
      for (const child of node.alternate || []) walk(child);
      return;
    }
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
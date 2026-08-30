/**
 * Analyzes the Final Handoff Object and links reactive state to template nodes.
 * @param {Object} astPayload - The unified { template, script } object.
 * @returns {Object} The mutated payload enriched with dependency tracking.
 */
function analyzeDependencies(astPayload) {
  const { template, script } = astPayload;

  // 1. Create a Set of all reactive variable names (e.g., Set { 'count', 'user' })
  const reactiveVars = new Set(
    script
      .filter(decl => decl.type === 'VariableDeclaration' && decl.isReactive)
      .map(decl => decl.name)
  );

  /**
   * Recursively extracts identifiers from the Pratt AST and checks them against our Set.
   */
  function extractIdentifiers(exprAST, deps = new Set()) {
    if (!exprAST) return deps;

    switch (exprAST.type) {
      case 'Identifier':
        if (reactiveVars.has(exprAST.name)) {
          deps.add(exprAST.name);
        }
        break;

      case 'BinaryExpression':
        extractIdentifiers(exprAST.left, deps);
        extractIdentifiers(exprAST.right, deps);
        break;

      case 'MemberExpression':
        // For object access like `user.name`, the root object `user` is the actual state dependency
        extractIdentifiers(exprAST.object, deps);
        // We do NOT recursively check `exprAST.property` because 'name' is just a string key, not a standalone variable.
        break;
    }

    return deps;
  }

  // 2. Walk the template and tag dependencies
  function walkTemplate(node) {
    if (node.type === 'Expression' && node.expressionAST) {
      const deps = extractIdentifiers(node.expressionAST);
      // Attach the dependencies directly to the node as an array
      node.dependencies = Array.from(deps);
    }

    if (node.type === 'Element') {
      for (const attribute of node.attributes || []) {
        if (attribute.dynamic && attribute.expressionAST) {
          attribute.dependencies = Array.from(extractIdentifiers(attribute.expressionAST));
        }
      }
    }

    if (node.type === 'EachBlock') {
      node.dependencies = reactiveVars.has(node.collection) ? [node.collection] : [];
    }

    if (node.children && Array.isArray(node.children)) {
      for (let i = 0; i < node.children.length; i++) {
        walkTemplate(node.children[i]);
      }
    }
  }

  walkTemplate(template);

  // We mutate in place for performance, returning the enriched payload
  return astPayload;
}

module.exports = { analyzeDependencies };
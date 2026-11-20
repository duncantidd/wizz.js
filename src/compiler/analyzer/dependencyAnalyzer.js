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
   * Extracts the reactive identifiers an expression AST reads, in source
   * order. Iterative, like the parser that builds these ASTs: a long
   * left-associative chain (`a + a + ...`, `o.n.n...`) is as deep as it is
   * long, and a recursive walk would exhaust the stack on input the parser
   * accepted. Children are pushed in reverse so they pop left to right,
   * which keeps the dependency order the recursive walk produced.
   */
  function extractIdentifiers(root, deps = new Set()) {
    const stack = root ? [root] : [];

    while (stack.length) {
      const node = stack.pop();

      switch (node.type) {
        case 'Identifier':
          if (reactiveVars.has(node.name)) {
            deps.add(node.name);
          }
          break;

        // Both operands of `&&`/`||` count even though one may be
        // short-circuited: which one runs depends on state, and a change to
        // either can change the result.
        case 'BinaryExpression':
        case 'LogicalExpression':
          stack.push(node.right, node.left);
          break;

        case 'UnaryExpression':
          stack.push(node.argument);
          break;

        case 'ConditionalExpression':
          // Every branch counts, not just the one taken at mount: flipping the
          // test selects the other branch, whose names must already be wired.
          stack.push(node.alternate, node.consequent, node.test);
          break;

        case 'CallExpression':
          // A reactive `let` holding a function is a dependency like any other
          // read. What the callee reads internally is invisible here: state a
          // called function depends on must be passed as an argument
          // (`{label(count)}`) for the expression to update when it changes.
          // Pushed one at a time: spreading a wide argument list would
          // itself overflow the stack.
          for (let i = node.arguments.length - 1; i >= 0; i -= 1) stack.push(node.arguments[i]);
          stack.push(node.callee);
          break;

        case 'MemberExpression':
          // For object access like `user.name`, the root object `user` is the
          // state dependency; `name` is just a key, not a standalone variable.
          stack.push(node.object);
          break;

        default:
          break;
      }
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

    if (node.type === 'IfBlock') {
      // The test's dependencies decide whether the block is reactive: the
      // generators re-evaluate it when one of them changes, and emit a
      // mount-time-only branch when there are none.
      node.dependencies = Array.from(extractIdentifiers(node.testAST));
      // The parser's `children` alias repoints to the alternate at {:else},
      // so a children-only walk would miss consequent content in blocks with
      // an else branch. Both branches are walked explicitly instead.
      for (const child of node.consequent || []) walkTemplate(child);
      for (const child of node.alternate || []) walkTemplate(child);
      return;
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
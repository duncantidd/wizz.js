// src/compiler/generator/hydrationGenerator.js
const { CodeBuilder } = require('./codeBuilder');

/**
 * Generates the hydrateCreate() adoption walk for hydratable components.
 * The emitted function attaches to the server-rendered DOM in the same
 * pre-order the create() walk builds it, verifies each position against the
 * template AST, collects event listeners for deferred attachment, and reports
 * any mismatch once before falling back to a full client render.
 *
 * The walk relies on three invariants of the server target:
 * - adjacent text-like children are separated by `<!-- -->` markers, which
 *   are stripped per element before child counts are compared;
 * - `data-wizz-id` attributes appear on the same elements the analyzer
 *   stamped, and are verified from the AST attribute, never from a counter;
 * - text content is rendered from the same expressions this walk re-evaluates
 *   against the seeded reactive bindings.
 * @param {Object} templateAST - The analyzed template AST.
 * @returns {string} The hydration section source for the factory closure.
 */
function generateHydrationFunction(templateAST) {
  const builder = new CodeBuilder();
  let referenceCounter = 0;
  const nextReference = () => `node_${++referenceCounter}`;

  const rootNode = templateAST.children.find(node => node.type === 'Element');
  if (!rootNode) {
    throw new SyntaxError('Component template must contain a root element.');
  }

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

  builder.add('function hydrateCreate(target, state) {');
  builder.add('  const problems = [];');
  builder.add('  const pendingListeners = [];');

  // The mount point's first element is adopted as the component root; a
  // missing or differently-tagged element is the first mismatch check.
  builder.add('  const rootNode = target.firstElementChild;');
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

  function emitElementChild(elementNode, index, parentRef) {
    const ref = nextReference();
    builder.add(`  let ${ref} = null;`);
    builder.add('  if (problems.length === 0) {');
    builder.add(`    ${ref} = ${parentRef}.childNodes[${index}];`);
    builder.add(`    if (__wizzNodeTag(${ref}) !== '${elementNode.name.toLowerCase()}') {`);
    builder.add(`      problems.push('expected <${elementNode.name}> at index ${index} of <' + __wizzNodeTag(${parentRef}) + '>, found ' + __wizzDescribe(${ref}));`);
    builder.add('    }');
    builder.add('  }');
    emitDataWizzIdCheck(ref, elementNode);
    emitListenerCollection(ref, elementNode);
    walkChildren(elementNode, ref);
  }

  function emitTextChild(child, index, parentRef) {
    const ref = nextReference();
    builder.add('  if (problems.length === 0) {');
    builder.add(`    const ${ref} = ${parentRef}.childNodes[${index}];`);
    builder.add(`    if (!${ref} || ${ref}.nodeType !== 3 || ${ref}.nodeValue !== ${JSON.stringify(child.value)}) {`);
    builder.add(`      problems.push('expected text ' + ${expectedTextLiteral(child.value)} + ' at index ${index} of <' + __wizzNodeTag(${parentRef}) + '>, found ' + __wizzDescribe(${ref}));`);
    builder.add('    }');
    builder.add('  }');
  }

  function emitExpressionChild(child, index, parentRef) {
    const ref = nextReference();
    builder.add('  if (problems.length === 0) {');
    builder.add(`    const ${ref} = ${parentRef}.childNodes[${index}];`);
    // The delivered markup escaped this expression's output; the browser's
    // parser has decoded it again, so compare against the raw runtime value.
    builder.add(`    if (!${ref} || ${ref}.nodeType !== 3 || ${ref}.nodeValue !== String(${child.value})) {`);
    builder.add(`      problems.push('expected expression text at index ${index} of <' + __wizzNodeTag(${parentRef}) + '>, found ' + __wizzDescribe(${ref}));`);
    builder.add('    }');
    builder.add('  }');
  }

  function walkChildren(elementNode, parentRef) {
    const children = elementNode.children || [];
    // Hydration markers are stripped before anything else so the remaining
    // childNodes align one-to-one with the template AST children.
    builder.add('  if (problems.length === 0) {');
    builder.add(`    __wizzStripComments(${parentRef});`);
    if (children.length > 0) {
      builder.add(`    if (${parentRef}.childNodes.length !== ${children.length}) {`);
      builder.add(`      problems.push('expected ${children.length} child nodes in <' + __wizzNodeTag(${parentRef}) + '>, found ' + ${parentRef}.childNodes.length);`);
      builder.add('    }');
    }
    builder.add('  }');

    children.forEach((child, index) => {
      if (child.type === 'Text') {
        emitTextChild(child, index, parentRef);
        return;
      }
      if (child.type === 'Expression') {
        emitExpressionChild(child, index, parentRef);
        return;
      }
      if (child.type === 'Element') {
        emitElementChild(child, index, parentRef);
        return;
      }
      // The server-renderable gate rejects blocks and component tags before
      // a hydratable module is generated.
      throw new SyntaxError(`Hydration does not support ${child.type} nodes.`);
    });
  }

  // Root element: identity and id verification, listener collection, then the
  // same positional child walk as every other element.
  emitDataWizzIdCheck('rootNode', rootNode);
  emitListenerCollection('rootNode', rootNode);
  walkChildren(rootNode, 'rootNode');

  builder.add('  if (problems.length > 0) {');
  builder.add("    console.warn('[wizz] hydration mismatch: ' + problems.join('; ') + '. Falling back to client rendering.');");
  builder.add('    while (target.childNodes.length > 0) target.removeChild(target.childNodes[0]);');
  builder.add('    return null;');
  builder.add('  }');
  builder.add('  pendingListeners.forEach((pending) => trackListener(pending[0], pending[1], pending[2]));');
  builder.add('  return rootNode;');
  builder.add('}');

  return builder.generate();
}

module.exports = { generateHydrationFunction };

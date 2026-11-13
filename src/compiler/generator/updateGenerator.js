const { CodeBuilder } = require('./codeBuilder');
const { attributeWriteSource } = require('./attributePolicy');

const hasDependencies = (node) => node.dependencies?.length > 0;

// create() renders only the first top-level element, so anything else at the
// top of the template has no node to update.
const findRootElement = (templateAST) => (templateAST.children || []).find((node) => node.type === 'Element');

/**
 * Names the DOM nodes update() writes to: elements with a reactive attribute
 * and reactive text. Each one gets a factory-scope variable that create() and
 * the hydration walk assign and update() reads, so a write can only ever reach
 * this instance's own node.
 *
 * Looking nodes up when writing cannot work. A `data-wizz-id` query crosses
 * into child components, which number their elements from 1 as well, and a
 * template child index stops matching the DOM beside late-mounted children,
 * untaken branches, and list items.
 *
 * Each bodies are skipped because their records update their own nodes, and
 * component tags because they receive setProps() and create no node here. The
 * `__wizz` prefix keeps these names clear of author variables in the same scope.
 * @param {Object} templateAST - The analyzed template AST.
 * @returns {{names: Map<Object, string>, conditional: Set<Object>}} Variable
 *   names by AST node, plus the nodes inside an {#if}: their branch may not have
 *   been created, so update() guards those writes.
 */
function collectUpdateTargets(templateAST) {
  const names = new Map();
  const conditional = new Set();

  function track(node, insideBranch) {
    names.set(node, `__wizzTarget_${names.size + 1}`);
    if (insideBranch) conditional.add(node);
  }

  function walk(node, insideBranch) {
    if (node.type === 'Expression') {
      if (hasDependencies(node)) track(node, insideBranch);
    } else if (node.type === 'IfBlock') {
      // The parser's `children` alias repoints to the alternate at {:else}, so
      // both branches are walked explicitly.
      (node.consequent || []).forEach((child) => walk(child, true));
      (node.alternate || []).forEach((child) => walk(child, true));
    } else if (node.type === 'Element' && node.componentId == null) {
      if ((node.attributes || []).some((attribute) => attribute.dynamic && hasDependencies(attribute))) {
        track(node, insideBranch);
      }
      (node.children || []).forEach((child) => walk(child, insideBranch));
    }
  }

  const rootElement = findRootElement(templateAST);
  if (rootElement) walk(rootElement, false);
  return { names, conditional };
}

/**
 * Generates the update() lifecycle function for a component's reactivity engine.
 * @param {Object} templateAST - The enriched template AST.
 * @param {ReturnType<typeof collectUpdateTargets>} [targets] - The component's
 *   update targets; the same object must reach the create and hydration
 *   generators, which assign the variables this function reads.
 * @returns {string} The generated JavaScript string.
 */
function generateUpdateFunction(templateAST, targets = collectUpdateTargets(templateAST)) {
  const builder = new CodeBuilder();
  const hasEachBlock = (node) => node.type === 'EachBlock'
    || (node.children || []).some(hasEachBlock)
    || (node.consequent || []).some(hasEachBlock)
    || (node.alternate || []).some(hasEachBlock);

  builder.add('function __wizzUpdate(__wizzCtx, __wizzChanged) {')
        .indent();

  if (hasEachBlock(templateAST)) {
    builder.add('__wizzLists.forEach((updateList) => updateList(__wizzChanged));');
  }

  // Emits one guarded write. Nodes inside an {#if} may not exist, and a skipped
  // write must not abort the rest of the pass.
  // `write` receives the target expression and returns one statement.
  function emitWrite(node, dependencyName, write) {
    const target = targets.names.get(node);
    const guard = targets.conditional.has(node) ? `if (${target}) ` : '';
    builder.add(`if (__wizzChanged.${dependencyName}) {`)
      .indent()
      .add(`${guard}${write(target)}`)
      .dedent()
      .add('}');
  }

  function walk(node) {
    if (node.type === 'Expression') {
      // Wrapped in String() so numeric results cannot reach the DOM as numbers.
      (node.dependencies || []).forEach((dependencyName) => {
        emitWrite(node, dependencyName, (target) => `${target}.nodeValue = String(${node.value});`);
      });
    } else if (node.type === 'Element') {
      // Imported component tags receive prop updates through their mounted
      // instance, not through DOM attribute writes.
      if (node.componentId != null) {
        for (const attribute of node.attributes || []) {
          if (!attribute.dynamic || !attribute.dependencies?.length) continue;
          const guard = attribute.dependencies.map((dependencyName) => `__wizzChanged.${dependencyName}`).join(' || ');
          builder.add(`if (${guard}) {`)
            .indent()
            .add(`if (__wizzComponent_${node.componentId}) __wizzComponent_${node.componentId}.setProps({ ${JSON.stringify(attribute.name)}: ${attribute.value} });`)
            .dedent()
            .add('}');
        }
        return;
      }

      for (const attribute of node.attributes || []) {
        if (!attribute.dynamic || !attribute.dependencies?.length) continue;
        for (const dependencyName of attribute.dependencies) {
          emitWrite(node, dependencyName, (target) => attributeWriteSource(target, attribute.name, attribute.value));
        }
      }

      (node.children || []).forEach(walk);
    } else if (node.type === 'IfBlock') {
      // Conditional branches exist in the DOM after mount, so their reactive
      // content and component props participate in updates like any other.
      (node.consequent || []).forEach(walk);
      (node.alternate || []).forEach(walk);
    }
  }

  const rootElement = findRootElement(templateAST);
  if (rootElement) walk(rootElement);

  builder.dedent()
        .add('}');

  return builder.generate();
}

module.exports = { generateUpdateFunction, collectUpdateTargets };
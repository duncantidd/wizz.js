// Compile-time warnings for state changes the update scheduler never hears
// about (issue #73).
//
// The assignment interceptor rewrites statement-level mutations of reactive
// names so they queue an update; by design it leaves expression-position
// assignments (`g(count = 1)`, `if (x) count = 1;`, `a = b = 1`) untouched,
// because rewriting inside an expression could change what it means. Each of
// those changes state while the DOM silently keeps the old value — the
// costliest kind of bug for humans and agents alike — so the compiler reports
// them as warnings with a stable code. Warnings never fail a compile.
//
// Sources scanned: the original script text (imports and `export let` lines
// still in place, so positions map back to the component file exactly) and
// every inline `on:` handler, with an {#each} item variable shadowing a
// same-named reactive let inside the item body, as it does in generated code.
const { CODES } = require('../diagnostics.js');
const { findUntrackedMutations, findUntrackedHandlerMutations } = require('./assignmentInterceptor.js');

const ADVICE = 'Make the assignment a statement of its own, in braces under an if/else or loop (`count += 1; g(count);`, `if (ready) { count = 2; }`), so the update is scheduled.';

// Same shape and message style as an error's diagnostic record: the
// location is written into the message as `at file:line:column`.
function record(what, file, line, column) {
  const where = line == null
    ? (file ? ` in ${file}` : '')
    : ` at ${file ? `${file}:` : ''}${line}:${column}`;
  return {
    code: CODES.generator.untrackedAssignment,
    severity: 'warning',
    message: `${what}${where}. ${ADVICE}`,
    file: file ?? null,
    line: line ?? null,
    column: column ?? null
  };
}

/**
 * Collects untracked-assignment warnings for an analyzed payload.
 * @param {object} payload - The parser/analyzer handoff object.
 * @param {string} [filePath] - Label qualifying each record.
 * @returns {Array<{ code, severity, message, file, line, column }>} One
 *   record per untracked mutation, script first, then handlers in template
 *   order.
 */
function collectUntrackedWarnings(payload, filePath) {
  const reactiveNames = (payload.script || [])
    .filter((declaration) => declaration.type === 'VariableDeclaration' && declaration.isReactive)
    .map((declaration) => declaration.name);
  if (reactiveNames.length === 0) return [];

  const warnings = [];
  const base = payload.scriptStart;
  if (payload.scriptSource && base) {
    for (const site of findUntrackedMutations(payload.scriptSource, reactiveNames)) {
      const line = base.line + site.line - 1;
      const column = site.line === 1 ? base.column + site.column - 1 : site.column;
      warnings.push(record(`'${site.name}' is assigned where the update scheduler does not see it, so the DOM will not update`, filePath, line, column));
    }
  }

  // Template order, with each-item shadowing. The walk is iterative and
  // never enters expression ASTs.
  const stack = [[payload.template, new Set()]];
  const handlerWarnings = [];
  while (stack.length) {
    const [node, shadowed] = stack.pop();
    if (!node || typeof node !== 'object') continue;
    const names = shadowed.size > 0 ? reactiveNames.filter((name) => !shadowed.has(name)) : reactiveNames;
    for (const attribute of node.attributes || []) {
      // Desugared bind: handlers are statement-level by construction.
      if (!attribute.name.startsWith('on:') || typeof attribute.value !== 'string' || attribute.bindFor) continue;
      for (const site of findUntrackedHandlerMutations(attribute.value, names)) {
        const start = node.loc?.start;
        handlerWarnings.push(record(`'${site.name}' is assigned in the '${attribute.name}' handler on <${node.name}> where the update scheduler does not see it, so the DOM will not update`, filePath, start?.line, start?.column));
      }
    }
    const inner = node.type === 'EachBlock' ? new Set([...shadowed, node.item]) : shadowed;
    // IfBlock.children aliases one branch, so both branches are walked
    // explicitly instead.
    const children = node.type === 'IfBlock'
      ? [...(node.consequent || []), ...(node.alternate || [])]
      : node.children || [];
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push([children[index], inner]);
  }
  return [...warnings, ...handlerWarnings];
}

module.exports = { collectUntrackedWarnings };

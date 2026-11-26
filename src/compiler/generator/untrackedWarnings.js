// Compile-time warnings for state changes the update scheduler never hears
// about.
//
// WIZZ-G026 (issue #73): the assignment interceptor rewrites statement-level
// mutations of reactive names so they queue an update; by design it leaves
// expression-position assignments (`g(count = 1)`, `if (x) count = 1;`,
// `a = b = 1`) untouched, because rewriting inside an expression could change
// what it means. Each of those changes state while the DOM silently keeps the
// old value — the costliest kind of bug for humans and agents alike — so the
// compiler reports them as warnings with a stable code.
//
// WIZZ-G027 (milestone 26): assignment is the only update trigger, so an
// in-place array method (`items.push(x);`) on reactive state changes it
// without an update unless the name is reassigned afterwards
// (`items = items;`). Local state deliberately has no identity check, so the
// self-assignment idiom always schedules the update; the warning catches the
// forgotten half. Props are excluded: they are read-only, so the
// reassignment fix does not apply to them.
//
// Warnings never fail a compile and change no generated output.
//
// Sources scanned: the original script text (imports and `export let` lines
// still in place, so positions map back to the component file exactly) and
// every inline `on:` handler, with an {#each} item variable shadowing a
// same-named reactive let inside the item body, as it does in generated code.
const { CODES } = require('../diagnostics.js');
const { findUnscheduledChanges, findUnscheduledHandlerChanges } = require('./assignmentInterceptor.js');

const UNTRACKED_ADVICE = 'Make the assignment a statement of its own, in braces under an if/else or loop (`count += 1; g(count);`, `if (ready) { count = 2; }`), so the update is scheduled.';

const UNTRACKED = 'is assigned';
// The non-mutating counterpart of each method, as the second fix.
const COPY_FORMS = Object.freeze({
  __proto__: null,
  push: (name) => `[...${name}, x]`,
  unshift: (name) => `[x, ...${name}]`,
  pop: (name) => `${name}.slice(0, -1)`,
  shift: (name) => `${name}.slice(1)`,
  splice: (name) => `${name}.toSpliced(…)`,
  sort: (name) => `${name}.toSorted(…)`,
  reverse: (name) => `${name}.toReversed()`,
  fill: (name) => `[...${name}].fill(…)`,
  copyWithin: (name) => `[...${name}].copyWithin(…)`
});
const callForm = (method) => (method === 'push' || method === 'unshift' ? `${method}(x)` : `${method}(${method === 'pop' || method === 'shift' || method === 'reverse' ? '' : '…'})`);
const inPlaceAdvice = (name, method) => `Reassign it after the call (\`${name}.${callForm(method)}; ${name} = ${name};\`) or assign a new array instead (\`${name} = ${COPY_FORMS[method](name)}\`); assignment is what schedules the update.`;

// Same shape and message style as an error's diagnostic record: the
// location is written into the message as `at file:line:column`.
function record(code, what, advice, file, line, column) {
  const where = line == null
    ? (file ? ` in ${file}` : '')
    : ` at ${file ? `${file}:` : ''}${line}:${column}`;
  return {
    code,
    severity: 'warning',
    message: `${what}${where}. ${advice}`,
    file: file ?? null,
    line: line ?? null,
    column: column ?? null
  };
}

const untracked = (what, file, line, column) => record(CODES.generator.untrackedAssignment, what, UNTRACKED_ADVICE, file, line, column);
const inPlace = (site, what, file, line, column) => record(CODES.generator.inPlaceMutation, what, inPlaceAdvice(site.name, site.method), file, line, column);

/**
 * Collects WIZZ-G026 and WIZZ-G027 warnings for an analyzed payload.
 * @param {object} payload - The parser/analyzer handoff object.
 * @param {string} [filePath] - Label qualifying each record.
 * @returns {Array<{ code, severity, message, file, line, column }>} Script
 *   findings first, in source order, then handler findings in template
 *   order (G026 before G027 within one handler).
 */
function collectUntrackedWarnings(payload, filePath) {
  const reactive = (payload.script || [])
    .filter((declaration) => declaration.type === 'VariableDeclaration' && declaration.isReactive);
  if (reactive.length === 0) return [];
  const reactiveNames = reactive.map((declaration) => declaration.name);
  const stateSet = new Set(reactive.filter((declaration) => !declaration.isProp).map((declaration) => declaration.name));

  const scriptSites = [];
  const base = payload.scriptStart;
  if (payload.scriptSource && base) {
    const locate = (site) => ({
      line: base.line + site.line - 1,
      column: site.line === 1 ? base.column + site.column - 1 : site.column
    });
    // One scan for both codes. Prop calls are dropped afterwards; props
    // cannot be mutated (WIZZ-G015), so they never silence a state call.
    const changes = findUnscheduledChanges(payload.scriptSource, reactiveNames);
    for (const site of changes.untracked) {
      const { line, column } = locate(site);
      scriptSites.push(untracked(`'${site.name}' ${UNTRACKED} where the update scheduler does not see it, so the DOM will not update`, filePath, line, column));
    }
    for (const site of changes.inPlace) {
      if (!stateSet.has(site.name)) continue;
      const { line, column } = locate(site);
      scriptSites.push(inPlace(site, `'${site.name}' is changed in place by .${site.method}() and never reassigned afterwards, so the DOM will not update`, filePath, line, column));
    }
    scriptSites.sort((left, right) => left.line - right.line || left.column - right.column);
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
      const start = node.loc?.start;
      const where = `in the '${attribute.name}' handler on <${node.name}>`;
      // One normalize-and-scan per handler for both codes; prop calls are
      // dropped as in the script.
      const changes = findUnscheduledHandlerChanges(attribute.value, names);
      for (const site of changes.untracked) {
        handlerWarnings.push(untracked(`'${site.name}' ${UNTRACKED} ${where} where the update scheduler does not see it, so the DOM will not update`, filePath, start?.line, start?.column));
      }
      for (const site of changes.inPlace) {
        if (!stateSet.has(site.name)) continue;
        handlerWarnings.push(inPlace(site, `'${site.name}' is changed in place by .${site.method}() ${where} and never reassigned afterwards, so the DOM will not update`, filePath, start?.line, start?.column));
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
  return [...scriptSites, ...handlerWarnings];
}

module.exports = { collectUntrackedWarnings };

const { CODES, compilerDiagnostic } = require('../diagnostics.js');
const { tokenizeScript } = require('../scriptLexer');
const { collectDeclaredNames } = require('./assignmentInterceptor');

// Script hooks the factory defines for author code.
const SCRIPT_API = ['onMount', 'onDestroy'];

// Globals generated code reads inside the factory, where an author declaration
// would shadow them. Everything else generated code declares is `__wizz`-prefixed.
const FACTORY_GLOBALS = ['document', 'console', 'queueMicrotask', 'Array', 'Error', 'JSON', 'Map', 'Object', 'Set', 'String'];

// Module-scope exports, which only a component import can collide with.
const MODULE_EXPORTS = ['mountComponent', 'hydrateComponent', 'hydrateRoot'];

const RESERVED_DECLARATIONS = new Set([...SCRIPT_API, ...FACTORY_GLOBALS]);
const RESERVED_IMPORTS = new Set([...RESERVED_DECLARATIONS, ...MODULE_EXPORTS]);

function assertAllowed(name, reserved, kind) {
  if (name.startsWith('__wizz')) {
    throw compilerDiagnostic(CODES.generator.reservedAuthorName, `${kind} '${name}' uses the reserved '__wizz' framework prefix.`);
  }
  if (reserved.has(name)) {
    throw compilerDiagnostic(CODES.generator.reservedAuthorName, `${kind} '${name}' would replace a name the generated module needs; choose another name.`);
  }
}

/**
 * Lists the names a script declares at its top level, including destructured
 * bindings. Declarations inside a function or block only shadow within that
 * scope, so generated code never sees them and they stay allowed.
 * @param {string} rawScript - The component script source.
 * @returns {string[]} The declared names.
 */
function topLevelNames(rawScript) {
  const tokens = tokenizeScript(rawScript || '').filter((token) => token.type !== 'comment');
  const names = [];
  let depth = 0;
  tokens.forEach((token, index) => {
    if (token.type === 'punctuator') {
      if ('([{'.includes(token.value)) depth += 1;
      else if (')]}'.includes(token.value)) depth -= 1;
      return;
    }
    if (depth !== 0 || token.type !== 'identifier' || tokens[index - 1]?.value === '.') return;
    if (['let', 'const', 'var'].includes(token.value)) {
      names.push(...collectDeclaredNames(tokens, index).names);
    } else if (['function', 'class'].includes(token.value) && tokens[index + 1]?.type === 'identifier') {
      names.push(tokens[index + 1].value);
    }
  });
  return names;
}

/**
 * Rejects author names the generated module cannot make room for. Generated
 * locals carry the `__wizz` prefix, so this list stays short: the prefix itself,
 * the script hooks, and the globals generated code reads. Without this check
 * these names produce a module that fails to load or misbehaves at runtime.
 * @param {Object} astPayload - The parsed component payload.
 * @throws {SyntaxError} WIZZ-G025 when a top-level declaration or import
 *   uses a reserved name.
 */
function assertAuthorNames(astPayload) {
  for (const name of topLevelNames(astPayload.rawScript)) {
    assertAllowed(name, RESERVED_DECLARATIONS, 'Declaration');
  }
  for (const prop of astPayload.props || []) {
    assertAllowed(prop.name, RESERVED_DECLARATIONS, 'Prop');
  }
  for (const component of astPayload.imports || []) {
    assertAllowed(component.name, RESERVED_IMPORTS, 'Import');
  }
}

module.exports = { assertAuthorNames, topLevelNames, RESERVED_DECLARATIONS, RESERVED_IMPORTS };

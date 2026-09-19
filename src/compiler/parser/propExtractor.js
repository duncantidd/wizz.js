const { CODES, compilerDiagnostic } = require('../diagnostics.js');

// Extracts `export let` prop declarations from component script.
//
// Props are the child-side declaration syntax for component inputs:
//
//   export let name = 'Guest';   // prop with a default value
//   export let count;            // prop without a default (undefined)
//
// Each `export let` statement is removed from the script and recorded so the
// generator can emit the prop bindings and the reactive set can treat props
// like state. Statement extents are resolved on the scriptLexer token stream
// so strings, template literals, comments, and regex literals cannot hide a
// semicolon or a nested `export`; anything the lexer cannot confidently bound
// is an error rather than silently mangled output.
//
// scriptLexer.js is a shared compiler utility (the generator's assignment
// interceptor uses it too), so it lives at the compiler root rather than
// inside a pipeline stage.

const { tokenizeScript } = require('../scriptLexer.js');

// Names that cannot be prop bindings: strict-mode reserved words, the
// generated closure's own `props` parameter, and the object-literal prototype
// key that must never appear as a prop.
const RESERVED_PROP_NAMES = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false',
  'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new',
  'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try',
  'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static',
  'implements', 'interface', 'package', 'private', 'protected', 'public',
  'arguments', 'eval', 'props', '__proto__'
]);

// Prefix/binary operator keywords: an identifier after one of these continues
// the same expression instead of starting a new statement.
const OPERATOR_KEYWORDS = new Set([
  'typeof', 'new', 'delete', 'void', 'await', 'yield', 'in', 'instanceof',
  'of', 'case', 'return', 'throw', 'else', 'do'
]);

/**
 * Decides whether a token ends a complete operand, so an identifier directly
 * after it must begin a new statement (matching the interceptor's ASI
 * heuristic at the statement level).
 */
function completesOperand(token) {
  if (token.type === 'identifier') return !OPERATOR_KEYWORDS.has(token.value);
  if (['number', 'string', 'regex', 'templateText'].includes(token.type)) return true;
  return token.type === 'punctuator' && [')', ']', '}', '++', '--'].includes(token.value);
}

function nextSignificantIndex(tokens, index) {
  let current = index;
  while (current < tokens.length && tokens[current].type === 'comment') current += 1;
  return current;
}

function previousSignificantIndex(tokens, index) {
  let current = index;
  while (current >= 0 && tokens[current] && tokens[current].type === 'comment') current -= 1;
  return current;
}

function sourceLocation(source, offset) {
  let line = 1;
  let lastNewline = -1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === '\n') {
      line += 1;
      lastNewline = index;
    }
  }
  return ` at ${line}:${offset - lastNewline}`;
}

/**
 * Extracts prop declarations from component script.
 * @param {string} scriptContent - Component script with imports already removed.
 * @returns {{ props: Array<{ name: string, defaultValue: string|null }>, script: string }}
 *   The props in declaration order (defaultValue is null when the declaration
 *   has no initializer) and the script with the `export let` statements removed.
 */
function extractProps(scriptContent) {
  if (!scriptContent || typeof scriptContent !== 'string') {
    return { props: [], script: scriptContent || '' };
  }

  const tokens = tokenizeScript(scriptContent);

  // Nesting depth before each token, with `${}` interpolation brackets
  // counted like regular brackets, so `export` is only honored at the
  // component's top level.
  const depthBefore = new Array(tokens.length);
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    depthBefore[index] = depth;
    const token = tokens[index];
    if (token.type === 'punctuator') {
      if (token.value === '${' || '([{'.includes(token.value)) depth += 1;
      else if (token.interpolationClose || ')]}'.includes(token.value)) depth -= 1;
    }
  }

  const props = [];
  const seenPropNames = new Set();
  const removals = [];
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];
    if (token.type !== 'identifier' || token.value !== 'export') {
      index += 1;
      continue;
    }

    // `config.export` is property access, not an export statement.
    const before = tokens[previousSignificantIndex(tokens, index - 1)];
    if (before && before.type === 'punctuator' && before.value === '.') {
      index += 1;
      continue;
    }

    const location = sourceLocation(scriptContent, token.start);
    const letIndex = nextSignificantIndex(tokens, index + 1);
    const letToken = tokens[letIndex];

    if (depthBefore[index] > 0) {
      if (letToken && letToken.type === 'identifier' && letToken.value === 'let') {
        throw compilerDiagnostic(CODES.parser.exportNotTopLevel, `'export' is only supported at the top level of a component script${location}.`);
      }
      index += 1;
      continue;
    }

    if (!letToken || letToken.type !== 'identifier' || letToken.value !== 'let') {
      const found = letToken ? `'${letToken.value}'` : 'end of script';
      throw compilerDiagnostic(CODES.parser.unsupportedExportSyntax, `Unsupported export syntax${location}. Only 'export let <name> = <default>;' prop declarations are supported; found 'export ${found}'.`);
    }

    const nameIndex = nextSignificantIndex(tokens, letIndex + 1);
    const nameToken = tokens[nameIndex];
    if (!nameToken || nameToken.type !== 'identifier') {
      throw compilerDiagnostic(CODES.parser.exportLetMissingName, `'export let' requires a prop name${location}.`);
    }
    if (RESERVED_PROP_NAMES.has(nameToken.value)) {
      throw compilerDiagnostic(CODES.parser.invalidPropName, `'${nameToken.value}' cannot be used as a prop name${location}.`);
    }
    if (nameToken.value.startsWith('__wizz')) {
      throw compilerDiagnostic(CODES.parser.reservedPropPrefix, `'${nameToken.value}' uses the reserved '__wizz' framework prefix${location}.`);
    }

    const valueIndex = nextSignificantIndex(tokens, nameIndex + 1);
    const valueToken = tokens[valueIndex];
    const firstValueIndex = nextSignificantIndex(tokens, valueIndex + 1);
    let defaultValue = null;
    let statementEndIndex = -1;

    if (valueToken && valueToken.type === 'punctuator' && valueToken.value === ';') {
      // `export let count;` — no default.
      statementEndIndex = valueIndex;
    } else if (valueToken && valueToken.type === 'punctuator' && valueToken.value === '=') {
      if (firstValueIndex >= tokens.length) {
        throw compilerDiagnostic(CODES.parser.propMissingValue, `Prop '${nameToken.value}' is missing a value after '='${location}.`);
      }
      // The default expression runs to the first `;` back at the export's own
      // nesting depth; strings, templates, and nested brackets cannot hide it.
      // A terminating semicolon is required so the extent is never ambiguous
      // enough to swallow the statements that follow.
      let end = -1;
      let previous = tokens[valueIndex];
      for (let scan = firstValueIndex; scan < tokens.length; scan += 1) {
        const candidate = tokens[scan];
        if (candidate.type === 'comment') continue;
        const atStatementDepth = depthBefore[scan] === depthBefore[index];

        // An identifier directly after a completed operand starts a new
        // statement (`export let x = 5 let y = 2;`) and a bare comma makes it
        // a multi-declarator; both require rejecting the declaration instead
        // of silently absorbing the following code into the default.
        if (atStatementDepth && previous && completesOperand(previous)) {
          if (candidate.type === 'identifier' && candidate.value !== 'in' && candidate.value !== 'instanceof') {
            throw compilerDiagnostic(CODES.parser.propMissingSemicolon, `Prop declaration for '${nameToken.value}' must end with a semicolon${sourceLocation(scriptContent, candidate.start)}.`);
          }
          if (candidate.type === 'punctuator' && candidate.value === ',') {
            throw compilerDiagnostic(CODES.parser.onePropPerExportLet, `Declare one prop per 'export let' statement${sourceLocation(scriptContent, candidate.start)}.`);
          }
        }

        if (atStatementDepth && candidate.type === 'punctuator' && !candidate.interpolationClose
          && candidate.value === ';') {
          end = scan;
          break;
        }
        previous = candidate;
      }
      if (end === -1) {
        throw compilerDiagnostic(CODES.parser.propMissingSemicolon, `Prop declaration for '${nameToken.value}' must end with a semicolon${location}.`);
      }
      defaultValue = scriptContent.slice(tokens[firstValueIndex].start, tokens[end].start).trim();
      if (!defaultValue) {
        throw compilerDiagnostic(CODES.parser.propMissingValue, `Prop '${nameToken.value}' is missing a value after '='${location}.`);
      }
      if (/^persist\s*\(/.test(defaultValue)) {
        // persist() is a compile-time marker for component-owned persistent
        // state. A prop is parent-owned and re-applied through setProps, so
        // a persisted prop has no owner for its storage writes.
        throw compilerDiagnostic(CODES.parser.persistOnProp, `persist() cannot initialize the prop '${nameToken.value}'; props are parent-owned. Declare it as component state with 'let' instead${sourceLocation(scriptContent, tokens[firstValueIndex].start)}.`);
      }
      statementEndIndex = end;
    } else if (valueToken && valueToken.type === 'punctuator' && valueToken.value === ',') {
      throw compilerDiagnostic(CODES.parser.onePropPerExportLet, `Declare one prop per 'export let' statement${location}.`);
    } else {
      throw compilerDiagnostic(CODES.parser.invalidPropDeclaration, `Invalid prop declaration for '${nameToken.value}'${location}. Expected '=' or ';'.`);
    }

    if (seenPropNames.has(nameToken.value)) {
      throw compilerDiagnostic(CODES.parser.duplicateProp, `Prop '${nameToken.value}' is declared more than once${location}.`);
    }
    seenPropNames.add(nameToken.value);

    props.push({ name: nameToken.value, defaultValue });
    removals.push({ start: token.start, end: tokens[statementEndIndex].end });

    index = statementEndIndex + 1;
  }

  if (props.length === 0) return { props, script: scriptContent };

  let script = '';
  let cursor = 0;
  removals.sort((left, right) => left.start - right.start);
  for (const removal of removals) {
    script += scriptContent.slice(cursor, removal.start);
    cursor = removal.end;
  }
  script += scriptContent.slice(cursor);

  return { props, script };
}

module.exports = { extractProps, RESERVED_PROP_NAMES };

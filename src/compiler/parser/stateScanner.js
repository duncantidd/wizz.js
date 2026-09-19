const { CODES, compilerDiagnostic } = require('../diagnostics.js');

/**
 * Scans a raw JavaScript string for top-level state and function declarations.
 * @param {string} scriptContent - The raw JS string extracted from the <script> tag.
 * @returns {Array<Object>} An array of state declaration nodes.
 */
function scanState(scriptContent) {
  if (!scriptContent || typeof scriptContent !== 'string') {
    return [];
  }

  const declarations = [];

  // Regex to match: let or const -> space -> identifier -> optional space -> '=' -> value -> ';'
  // The [\s\S]*? ensures we capture multi-line values (like objects or arrays) until the semi-colon.
  const variableRegex = /\b(let|const)\s+([a-zA-Z_$][0-9a-zA-Z_$]*)\s*=\s*([\s\S]*?);/g;

  // Regex to match: function -> space -> identifier -> '('
  const functionRegex = /\bfunction\s+([a-zA-Z_$][0-9a-zA-Z_$]*)\s*\(/g;

  // Both scans complete before any initializer is interpreted: whether the
  // author bound the name `persist` themselves decides how every initializer
  // is read, and that is only known once both scans have run.
  const variableMatches = [];
  const functionMatches = [];
  let match;
  while ((match = variableRegex.exec(scriptContent)) !== null) variableMatches.push(match);
  while ((match = functionRegex.exec(scriptContent)) !== null) functionMatches.push(match);

  // The author's own `persist` binding outranks the compile-time marker: when
  // the script declares a function or a let/const of that name, every
  // persist( call is theirs, and neither marker recognition nor marker
  // diagnostics apply — their script copies through verbatim and compiles
  // exactly as it did before the marker syntax existed.
  const authorDefinesPersist = variableMatches.some(candidate => candidate[2] === 'persist')
    || functionMatches.some(candidate => candidate[1] === 'persist');

  // 1. Scan for Variables (State and Constants)
  for (match of variableMatches) {
    // The raw initializer text ends immediately before the terminating ';'
    // and starts right after the '=' (the regex consumed the whitespace), so
    // its exact span in scriptContent is computable without re-searching —
    // look-alike text in comments or strings elsewhere cannot be mistaken
    // for the initializer. The generators splice persistent markers out by
    // this span, so it is recorded only when one is present; declaration
    // nodes for plain state stay exactly as they were.
    const initializerStart = match.index + match[0].length - match[3].length - 1;

    const declaration = {
      type: 'VariableDeclaration',
      kind: match[1], // 'let' or 'const'
      name: match[2], // e.g., 'count'
      initialValue: match[3].trim(), // e.g., '0' or '{ active: true }'
      isReactive: match[1] === 'let' // Only 'let' variables trigger DOM updates
    };

    const persist = authorDefinesPersist ? null : parsePersistInitializer(declaration.initialValue, scriptContent, initializerStart);
    if (persist !== null) {
      if (declaration.kind === 'const') {
        // A persistent value the author cannot reassign has nothing to write
        // back; the marker only makes sense on reactive state.
        throw compilerDiagnostic(CODES.parser.persistOnConst,
          `persist() requires a reactive 'let' declaration; '${declaration.name}' is const${sourceLocation(scriptContent, initializerStart)}.`
        );
      }
      // The generators hoist every state declaration's references to the
      // component's mount scope, so a marker inside a function body would
      // emit machinery that reads and writes a variable that only exists in
      // the callback's own scope — and the first template evaluation dies
      // with a ReferenceError of the declaration's name. Any component this
      // rejects never worked, so the located error is strictly better than
      // the runtime failure it replaces.
      if (lexicalModesBefore(scriptContent, match.index).length !== 0) {
        throw compilerDiagnostic(CODES.parser.persistNotTopLevel,
          `persist() must initialize a top-level let declaration; '${declaration.name}' is declared inside a block or function body${sourceLocation(scriptContent, match.index)}.`
        );
      }
      declaration.isPersistent = true;
      declaration.storageKey = persist.key;
      declaration.defaultValue = persist.defaultValue;
      declaration.initialValueStart = initializerStart;
      declaration.initialValueEnd = initializerStart + match[3].length;
    }

    declarations.push(declaration);
  }

  // 2. Scan for Functions (Methods/Event Handlers)
  for (match of functionMatches) {
    declarations.push({
      type: 'FunctionDeclaration',
      name: match[1] // e.g., 'handleClick'
    });
  }

  return declarations;
}

/**
 * Parses a `persist(key, default)` initializer into its storage key and the
 * raw default expression. `persist` is a compile-time marker, not a runtime
 * function: the generators replace the whole initializer span, so the marker
 * must parse strictly here or the component cannot compile.
 *
 * Accepts exactly two arguments: a string-literal key and any expression as
 * the default. Splitting runs over a small quote/comment/bracket-aware walk,
 * so defaults containing commas, strings, calls, or nested objects parse
 * correctly. Template-literal interpolation inside a default is rejected —
 * the escape hatch would need a full expression parser for no real gain.
 *
 * @param {string} initialValue - The trimmed initializer text.
 * @param {string} scriptContent - The script the initializer came from (for locations).
 * @param {number} offset - Offset of the initializer's first character in scriptContent.
 * @returns {{ key: string, defaultValue: string }|null} Null when the
 *   initializer is not a persist marker.
 * @throws {SyntaxError} When the initializer starts with `persist(` but is
 *   not a well-formed two-argument marker.
 */
function parsePersistInitializer(initialValue, scriptContent, offset) {
  if (!/^persist\s*\(/.test(initialValue)) return null;

  const at = locationAt(scriptContent, offset);
  const walk = walkPersistArguments(initialValue);
  if (walk.error !== null) {
    throw compilerDiagnostic(CODES.parser.persistCallUnparseable, `${walk.error}${at(walk.errorOffset)}.`);
  }
  if (!/^[\s]*$/.test(initialValue.slice(walk.closeIndex + 1))) {
    throw compilerDiagnostic(CODES.parser.persistTrailingStatements,
      `persist() takes no statements after its closing parenthesis${at(walk.closeIndex + 1)}.`
    );
  }

  const parts = walk.parts.map((part) => initialValue.slice(part.start, part.end).trim());
  if (parts.length < 2) {
    throw compilerDiagnostic(CODES.parser.persistMissingArguments, `persist() requires a storage key and a default value${at(0)}.`);
  }
  if (parts.length > 2) {
    throw compilerDiagnostic(CODES.parser.persistExtraArguments, `persist() takes exactly two arguments${at(0)}.`);
  }

  const key = parsePersistKey(parts[0]);
  if (key === null) {
    throw compilerDiagnostic(CODES.parser.persistKeyNotStringLiteral,
      `persist() requires a string-literal storage key${at(walk.parts[0].start)}.`
    );
  }

  // A persist() call inside the default expression would survive the splice
  // verbatim — the marker has no runtime function — and die with a
  // ReferenceError on first read; reject it while the location is precise.
  // Offsets run over the untrimmed part span so they map onto the script
  // through the initializer's start without trim-shift arithmetic.
  const nestedCall = findPersistCallInCode(initialValue.slice(walk.parts[1].start, walk.parts[1].end));
  if (nestedCall !== -1) {
    throw compilerDiagnostic(CODES.parser.persistNested,
      `persist() cannot be nested inside another persist() default${at(walk.parts[1].start + nestedCall)}.`
    );
  }

  return { key, defaultValue: parts[1] };
}

/**
 * Walks the argument list of a `persist(...)` call, splitting at top-level
 * commas. One depth counter covers all bracket kinds (a closer that would
 * take the depth negative is a mismatch); string, template, and comment
 * states are tracked so punctuation inside them is never structure.
 * `${` interpolation inside a template default is rejected rather than
 * modelled — it would need a full expression parser to bound correctly.
 *
 * @param {string} source - The full initializer text.
 * @returns {{ parts: Array<{ start: number, end: number }>, closeIndex: number, error: string, errorOffset: number }}
 *   Parts are half-open spans (untrimmed) between top-level commas.
 */
function walkPersistArguments(source) {
  const failure = (error, errorOffset) => ({ parts: [], closeIndex: -1, error, errorOffset });

  const openIndex = source.indexOf('(');
  // persist's own opening parenthesis is the stack's base entry: a top-level
  // comma is one with only this mode left, and the matching `)` empties the
  // stack and ends the walk.
  const modes = ['round']; // 'round' | 'square' | 'brace' | the open quote character | 'line' | 'block'
  const parts = [];
  let partStart = openIndex + 1;
  let index = openIndex + 1;

  while (index < source.length) {
    const character = source[index];

    if (modes.length > 0) {
      const mode = modes[modes.length - 1];
      if (mode === 'line') {
        if (character === '\n') modes.pop();
        index += 1;
        continue;
      }
      if (mode === 'block') {
        if (character === '*' && source[index + 1] === '/') {
          index += 2;
          modes.pop();
          continue;
        }
        index += 1;
        continue;
      }
      if (mode === '\'' || mode === '"') {
        if (character === '\\') {
          index += 2;
          continue;
        }
        if (character === mode) modes.pop();
        index += 1;
        continue;
      }
      if (mode === '`') {
        if (character === '\\') {
          index += 2;
          continue;
        }
        if (character === mode) {
          modes.pop();
          index += 1;
          continue;
        }
        if (character === '$' && source[index + 1] === '{') {
          return failure('persist() default expressions do not support template-literal interpolation', index);
        }
        index += 1;
        continue;
      }
    }

    // Code context.
    if (character === '/' && source[index + 1] === '/') {
      modes.push('line');
      index += 2;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      modes.push('block');
      index += 2;
      continue;
    }
    if (character === '\'' || character === '"' || character === '`') {
      // The mode is the quote character itself, so the closing quote pops it
      // by simple equality.
      modes.push(character);
      index += 1;
      continue;
    }
    if (character === '(' || character === '[' || character === '{') {
      modes.push(character === '(' ? 'round' : character === '[' ? 'square' : 'brace');
      index += 1;
      continue;
    }
    if (character === ')' || character === ']' || character === '}') {
      const mode = modes.pop();
      const expected = character === ')' ? 'round' : character === ']' ? 'square' : 'brace';
      if (mode !== expected) {
        return failure('persist() initializer has mismatched brackets', index);
      }
      if (modes.length === 0) {
        parts.push({ start: partStart, end: index });
        return { parts, closeIndex: index, error: null, errorOffset: -1 };
      }
      index += 1;
      continue;
    }
    if (character === ',' && modes.length === 1) {
      parts.push({ start: partStart, end: index });
      partStart = index + 1;
    }
    index += 1;
  }

  return failure('persist() initializer is missing its closing parenthesis', source.length - 1);
}

/**
 * Returns the offset of the first `persist(` call in code context — not
 * inside a string, template literal, or comment — or -1. Bracket modes are
 * irrelevant (a call inside a block is still a call); look-alike text inside
 * quotes or comments never matches. Walks the whole source, so callers pass
 * the exact span they care about.
 *
 * @param {string} source - The text to scan (a script, or one persist argument).
 * @returns {number} Offset of the call's first character, or -1.
 */
function findPersistCallInCode(source) {
  const callRegex = /\bpersist\s*\(/g;
  let match;
  while ((match = callRegex.exec(source)) !== null) {
    const modes = lexicalModesBefore(source, match.index);
    const textual = modes.some(mode => mode === '\'' || mode === '"' || mode === '`' || mode === 'line' || mode === 'block');
    if (!textual) return match.index;
  }
  return -1;
}

/**
 * Walks source[0..index) with the same lexical rules walkPersistArguments
 * uses — strings, template literals (interpolation braces included), line
 * and block comments, bracket nesting — plus regex-literal handling, and
 * returns the stack of open modes at that position. An empty stack means the
 * position sits at the script's top level; a stack of only bracket modes is
 * code inside a block or call; any string/comment/template mode means the
 * position is inside quoted text, not code at all.
 *
 * Regex literals are the one construct this walk needs lookahead for: a `/`
 * opens a literal unless the previous significant character continues an
 * expression (identifier character, closing bracket, quote, dot, or another
 * operator's tail). Without this, a regex literal containing quotes or
 * comment starters would corrupt the mode stack for everything after it.
 * Division after prefix operators (`x++ /2/`) is the accepted residual
 * ambiguity — real lexers face the same choice, and a script that writes it
 * while also declaring a persist() marker is not a realistic component.
 *
 * @param {string} source - The text to walk.
 * @param {number} index - Exclusive end of the walked range.
 * @returns {string[]} The open-mode stack at the position.
 */
function lexicalModesBefore(source, index) {
  const modes = [];
  let previous = ''; // Last significant code-context character seen.
  let i = 0;
  while (i < index) {
    const character = source[i];
    const mode = modes[modes.length - 1];
    if (mode === 'line') {
      if (character === '\n') modes.pop();
      i += 1;
      continue;
    }
    if (mode === 'block') {
      if (character === '*' && source[i + 1] === '/') {
        modes.pop();
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (mode === '\'' || mode === '"') {
      if (character === '\\') {
        i += 2;
        continue;
      }
      if (character === mode) {
        modes.pop();
        previous = mode;
      }
      i += 1;
      continue;
    }
    if (mode === '`') {
      if (character === '\\') {
        i += 2;
        continue;
      }
      if (character === '`') {
        modes.pop();
        previous = '`';
        i += 1;
        continue;
      }
      if (character === '$' && source[i + 1] === '{') {
        modes.push('brace');
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    // Code context.
    if (character === '/' && source[i + 1] === '/') {
      modes.push('line');
      i += 2;
      continue;
    }
    if (character === '/' && source[i + 1] === '*') {
      modes.push('block');
      i += 2;
      continue;
    }
    if (character === '/') {
      const continuesExpression = /[A-Za-z0-9_$)\]}'"`./]/.test(previous);
      if (!continuesExpression) {
        // A regex literal: skip to the closing slash, honouring backslash
        // escapes and character classes (where `/` needs no escape).
        i += 1;
        let inClass = false;
        while (i < index) {
          const literalCharacter = source[i];
          if (literalCharacter === '\\') {
            i += 2;
            continue;
          }
          if (literalCharacter === '[') inClass = true;
          else if (literalCharacter === ']') inClass = false;
          else if (literalCharacter === '/' && !inClass) break;
          i += 1;
        }
        i += 1; // Past the closing slash (or past index).
        previous = 'x'; // A regex literal reads like an expression operand.
        continue;
      }
      previous = '/';
      i += 1;
      continue;
    }
    if (character === '\'' || character === '"' || character === '`') {
      modes.push(character);
      i += 1;
      continue;
    }
    if (character === '(' || character === '[' || character === '{') {
      modes.push(character === '(' ? 'round' : character === '[' ? 'square' : 'brace');
      previous = character;
      i += 1;
      continue;
    }
    if (character === ')' || character === ']' || character === '}') {
      modes.pop();
      previous = character;
      i += 1;
      continue;
    }
    if (!/\s/.test(character)) previous = character;
    i += 1;
  }
  return modes;
}

const ESCAPE_MAP = new Map([
  ['n', '\n'],
  ['t', '\t'],
  ['r', '\r'],
  ['b', '\b'],
  ['f', '\f'],
  ['v', '\v'],
  ['0', '\0']
]);

/**
 * Cooks a JS string literal into its storage-key value. Only plain
 * characters and the common backslash escapes are supported; anything
 * exotic (\x, \u, octal) returns null so the caller reports a diagnostic
 * rather than guessing at the author's intent for a persistent key.
 *
 * @param {string} literal - The trimmed argument text.
 * @returns {string|null} The cooked key, or null when the literal is not a
 *   supported string.
 */
function parsePersistKey(literal) {
  const quote = literal[0];
  if (quote !== '\'' && quote !== '"') return null;
  if (literal[literal.length - 1] !== quote) return null;

  let key = '';
  for (let index = 1; index < literal.length - 1; index += 1) {
    const character = literal[index];
    if (character !== '\\') {
      key += character;
      continue;
    }
    const escape = literal[index + 1];
    if (escape === '\\') {
      key += '\\';
      index += 1;
      continue;
    }
    if (escape === quote) {
      key += quote;
      index += 1;
      continue;
    }
    if (ESCAPE_MAP.has(escape)) {
      key += ESCAPE_MAP.get(escape);
      index += 1;
      continue;
    }
    return null;
  }
  return key;
}

/**
 * Builds a located ` at line:col` suffix for offsets inside the initializer.
 * The scanner's initializer span starts at the first non-whitespace character
 * after `=`, so offsets within the trimmed text map linearly onto the script.
 *
 * @param {string} scriptContent - The enclosing script (for locations).
 * @param {number} scriptOffset - Offset of the initializer's first character in the script.
 * @returns {(at: number) => string} A suffix builder for offsets within the initializer.
 */
function locationAt(scriptContent, scriptOffset) {
  return (at) => sourceLocation(scriptContent, scriptOffset + at);
}

/**
 * Renders a script offset as a ` at line:col` suffix (same convention as the
 * prop extractor's located diagnostics).
 * @param {string} source - The script text.
 * @param {number} offset - Character offset into the script.
 * @returns {string}
 */
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

module.exports = { scanState };

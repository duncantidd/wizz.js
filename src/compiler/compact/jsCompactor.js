// Conservative JavaScript compaction for `wizz build --compact` (milestone 23).
//
// Removes comments and insignificant whitespace and nothing else: no
// identifier mangling, no constant folding, no statement rewriting. Token
// boundaries come from the compiler's own script lexer (scriptLexer.js), so
// strings, template literal text, and regex literals are copied byte for
// byte and only the gaps BETWEEN tokens are rewritten. Each gap becomes:
//
//   - nothing, when the tokens can touch without merging;
//   - one space, when they would merge (`return x`, `a - -b`, `1 .toFixed`);
//   - one newline, when the gap held a line terminator that automatic
//     semicolon insertion (ASI) or a restricted production may depend on.
//
// A line break is dropped only when it provably cannot matter: the token
// before it cannot end a statement (an operator, `(`, `,`, `{`, ...), or the
// token after it can never start a new one (`)`, `]`, `}`, `,`, `;`, `.`).
// Everything else — `return`/`throw`/`break`/`continue`/`yield` followed by a
// line break, postfix `++`/`--`, lines starting with `(`, `[`, `` ` ``, `+`,
// `-`, or `/` — keeps its newline.
//
// Conservative assumptions (documented per the project's ambiguity policy):
// - The lexer resolves `/` (regex vs division) by the previous token, as
//   real engines do lexically. Where that heuristic is known to be
//   ambiguous — `/` after `)` (`if (x) /re/.test(y)`), after `}` (a block
//   statement followed by a regex), after the contextual keyword `of`, a
//   "regex" after a keyword used as a property name (`obj.return / 2`), or a
//   "regex" after a non-ASCII identifier character the lexer cannot classify
//   — the rest of that source line is copied verbatim, so whichever reading
//   the engine takes, its bytes are unchanged. If such a line also opens or
//   closes a template literal (whose extent could then be misjudged), the
//   whole input is returned unchanged rather than risk a wrong cut.
// - After compaction, the output is re-tokenized and must produce exactly
//   the same significant token stream as the input. A mismatch is an
//   internal error that fails the build; corrupted output is never written.
// - Malformed input (an unterminated string, block comment, or template
//   literal) throws a SyntaxError carrying 1-based `line`/`column` fields.

const { tokenizeScript, PUNCTUATORS, scanRegex } = require('../scriptLexer');

const KNOWN_PUNCTUATORS = new Set(PUNCTUATORS);
// U+2028/U+2029 are built with fromCharCode: as literal characters they would
// themselves terminate this source line.
const LINE_TERMINATOR = new RegExp('[' + String.fromCharCode(0x0a, 0x0d, 0x2028, 0x2029) + ']');

// A line break after one of these never ends a statement: each needs a
// right-hand operand or continues a list/block. `)`, `]`, `}`, `++`, `--`
// are deliberately absent (each can end a statement).
const CONTINUING_PUNCTUATORS = new Set(
  [...KNOWN_PUNCTUATORS, '${'].filter((value) => ![')', ']', '}', '++', '--'].includes(value))
);
// A line break before one of these is never a statement boundary that ASI
// could depend on: none of them can begin a statement or an expression.
const NON_STARTING_PUNCTUATORS = new Set([')', ']', '}', ',', ';', '.']);
// Two characters that, written together, begin a longer punctuator or a
// comment (`+ +` -> `++`, `/ /` -> `//`, `? .` -> `?.`, `- >` -> `->` of an
// HTML-like `-->`). Any pair of tokens whose touching characters form one of
// these keeps a space; every other operator pair (`=/re/`) may touch.
const MERGING_PAIRS = new Set(['//', '/*', '<!', '->']);
for (const punctuator of PUNCTUATORS) {
  if (punctuator.length > 1) MERGING_PAIRS.add(punctuator.slice(0, 2));
}
// Keywords after which scriptLexer treats `/` as a regex. Used only to spot
// the `obj.return / 2` misreading (a keyword after `.` is a property name).
const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await'
]);

function isWordCharacter(character) {
  if (character === undefined) return false;
  return /[A-Za-z0-9_$\\#@]/.test(character) || character.charCodeAt(0) >= 0x80;
}

/**
 * Converts a 0-based offset into a 1-based { line, column } pair.
 * @param {string} source
 * @param {number} offset
 */
function locate(source, offset) {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source[index] === '\n') {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

function compactionError(message, source, offset) {
  const { line, column } = locate(source, offset);
  const error = new SyntaxError(`${message} (line ${line}, column ${column})`);
  error.line = line;
  error.column = column;
  error.offset = offset;
  return error;
}

// A string token is terminated when its final character is the opening
// quote and that quote is not consumed by a backslash escape.
function isTerminatedString(value) {
  if (value.length < 2) return false;
  const quote = value[0];
  let index = 1;
  while (index < value.length) {
    if (value[index] === '\\') index += 2;
    else if (value[index] === quote) return index === value.length - 1;
    else index += 1;
  }
  return false;
}

function updateTemplateModes(modes, token) {
  if (token.type !== 'punctuator') return;
  if (token.value === '`') {
    if (modes[modes.length - 1] === 'template') modes.pop();
    else modes.push('template');
  } else if (token.value === '${') {
    modes.push('code');
  } else if (token.interpolationClose) {
    modes.pop();
  }
}

/**
 * Rejects inputs the lexer tolerated but no engine would accept, with a
 * located SyntaxError. Returns nothing on success.
 */
function validateTokens(tokens, source) {
  const modes = [];
  const templateOpens = []; // Start offsets of the templates still open.
  for (const token of tokens) {
    if (token.type === 'comment' && token.value.startsWith('/*') &&
        (token.value.length < 4 || !token.value.endsWith('*/'))) {
      throw compactionError('Unterminated block comment', source, token.start);
    }
    if (token.type === 'string' && !isTerminatedString(token.value)) {
      throw compactionError('Unterminated string literal', source, token.start);
    }
    if (token.type === 'punctuator' && token.value === '`') {
      if (modes[modes.length - 1] === 'template') templateOpens.pop();
      else templateOpens.push(token.start);
    }
    updateTemplateModes(modes, token);
  }
  if (templateOpens.length > 0) {
    // Report the outermost: an inner template cannot outlive its parent.
    throw compactionError('Unterminated template literal', source, templateOpens[0]);
  }
  if (modes.length > 0) {
    throw compactionError('Unterminated template literal', source, source.length);
  }
}

/**
 * Validates JavaScript source the way compactJs() does, without producing
 * output: the build calls this on authored `<script>` blocks so a malformed
 * script is reported at its position in the `.wizz` file.
 * @param {string} source
 */
function validateJs(source) {
  if (typeof source !== 'string') throw new TypeError('validateJs expects a string.');
  validateTokens(tokenizeScript(source), source);
}

// Does the token at `index` sit where the lexer's regex/division call is
// known to be ambiguous? `previous`/`beforePrevious` are significant tokens.
function isAmbiguousSlash(token, previous, beforePrevious) {
  if (!previous) return false;
  if (token.type === 'punctuator' && (token.value === '/' || token.value === '/=')) {
    if (previous.type === 'punctuator' && (previous.value === ')' || previous.value === '}')) return true;
    if (previous.type === 'identifier' && previous.value === 'of') return true;
    return false;
  }
  if (token.type === 'regex') {
    if (previous.type === 'identifier' && REGEX_KEYWORDS.has(previous.value) && beforePrevious &&
        beforePrevious.type === 'punctuator' && (beforePrevious.value === '.' || beforePrevious.value === '?.')) {
      return true;
    }
    if (previous.type === 'punctuator' && !KNOWN_PUNCTUATORS.has(previous.value) &&
        previous.value !== '`' && previous.value !== '${') {
      return true;
    }
  }
  return false;
}

// The end offset of a verbatim span starting at `tokens[index]`: the end of
// its source line, or further if the alternative (regex) reading of a `/`
// would reach past it, extended so it never cuts through a token. Returns
// -1 when the span touches template punctuation (see the header).
function verbatimSpanEnd(tokens, index, source) {
  const start = tokens[index].start;
  let end = start;
  while (end < source.length && !LINE_TERMINATOR.test(source[end])) end += 1;
  const regexEnd = scanRegex(source, start);
  if (regexEnd > end) end = regexEnd;

  let cursor = index;
  while (cursor < tokens.length && tokens[cursor].start < end) {
    const token = tokens[cursor];
    if (token.type === 'punctuator' && (token.value === '`' || token.value === '${' || token.interpolationClose)) return -1;
    if (token.type === 'templateText') return -1;
    if (token.end > end) end = token.end;
    cursor += 1;
  }
  return end;
}

function needsSpace(lastCharacter, previous, token) {
  const firstCharacter = token.value[0];
  if (isWordCharacter(lastCharacter) && isWordCharacter(firstCharacter)) return true;
  if (MERGING_PAIRS.has(lastCharacter + firstCharacter)) return true;
  if (previous && previous.type === 'number' && firstCharacter === '.') return true;
  return false;
}

function lineBreakDroppable(previous, token) {
  if (previous.type === 'punctuator' && !previous.interpolationClose && CONTINUING_PUNCTUATORS.has(previous.value)) return true;
  if (token.type === 'punctuator' && NON_STARTING_PUNCTUATORS.has(token.value)) return true;
  return false;
}

function significantSignature(tokens) {
  return tokens.filter((token) => token.type !== 'comment');
}

function compactBody(body) {
  const tokens = tokenizeScript(body);
  validateTokens(tokens, body);

  const modes = [];
  // Output is collected in parts: indexing a long concatenated string makes
  // V8 flatten it on every read, which turns the scan quadratic.
  const parts = [];
  let lastCharacter;
  const emit = (text) => {
    if (text.length === 0) return;
    parts.push(text);
    lastCharacter = text[text.length - 1];
  };
  let previous = null;        // Last significant token passed.
  let beforePrevious = null;
  let lastEnd = 0;
  let pendingGap = false;     // A comment was dropped since the last token.
  let pendingBreak = false;   // ...and it contained a line terminator.
  let verbatimUntil = -1;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token.start < verbatimUntil) {
      // Already copied as part of a verbatim span; only track state.
      updateTemplateModes(modes, token);
      if (token.type !== 'comment') { beforePrevious = previous; previous = token; }
      lastEnd = Math.max(lastEnd, token.end);
      continue;
    }

    const inTemplate = modes[modes.length - 1] === 'template';
    const gap = body.slice(lastEnd, token.start);

    if (token.type === 'comment') {
      // Comments only occur in code mode. A line comment's terminating
      // newline lies in the following gap; a block comment may contain one.
      pendingGap = true;
      if (LINE_TERMINATOR.test(gap) || LINE_TERMINATOR.test(token.value)) pendingBreak = true;
      lastEnd = token.end;
      continue;
    }

    if (inTemplate) {
      // Whitespace between template text and `${`/`` ` `` is template text.
      emit(gap);
    } else if (previous && (pendingGap || gap.length > 0)) {
      const hasBreak = pendingBreak || LINE_TERMINATOR.test(gap);
      if (hasBreak && !lineBreakDroppable(previous, token)) emit('\n');
      else if (needsSpace(lastCharacter, previous, token)) emit(' ');
    }
    pendingGap = false;
    pendingBreak = false;

    if (!inTemplate && isAmbiguousSlash(token, previous, beforePrevious)) {
      const end = verbatimSpanEnd(tokens, index, body);
      if (end === -1) return null; // Give up on this input: see the header.
      emit(body.slice(token.start, end));
      verbatimUntil = end;
      lastEnd = end; // Trailing whitespace inside the span was copied too.
      index -= 1; // Re-visit this token through the verbatim branch.
      continue;
    }

    emit(token.value);
    updateTemplateModes(modes, token);
    beforePrevious = previous;
    previous = token;
    lastEnd = token.end;
  }

  const output = parts.join('');

  // Self-check: the compacted text must lex to the identical token stream.
  const before = significantSignature(tokens);
  const after = significantSignature(tokenizeScript(output));
  const length = Math.max(before.length, after.length);
  for (let index = 0; index < length; index += 1) {
    const a = before[index];
    const b = after[index];
    if (!a || !b || a.type !== b.type || a.value !== b.value) {
      const offset = a ? a.start : body.length;
      throw compactionError('Internal compaction error: the compacted output would not tokenize like the source', body, offset);
    }
  }

  return output;
}

/**
 * Compacts JavaScript (module or script) source. See the file header for the
 * exact transformation and its guarantees.
 * @param {string} source
 * @returns {string}
 */
function compactJs(source) {
  if (typeof source !== 'string') throw new TypeError('compactJs expects a string.');

  // A hashbang line is not JavaScript the lexer knows; keep it verbatim.
  let prefix = '';
  let body = source;
  if (source.startsWith('#!')) {
    const newline = source.indexOf('\n');
    if (newline === -1) return source;
    prefix = source.slice(0, newline + 1);
    body = source.slice(newline + 1);
  }

  let compacted;
  try {
    compacted = compactBody(body);
  } catch (error) {
    if (prefix && typeof error.offset === 'number') {
      // Re-locate against the full source so the hashbang line counts.
      throw compactionError(error.message.replace(/ \(line \d+, column \d+\)$/, ''), source, error.offset + prefix.length);
    }
    throw error;
  }
  if (compacted === null) return source;
  return prefix + compacted;
}

module.exports = { compactJs, validateJs, locate };

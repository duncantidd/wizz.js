// Tokenizes component script source into a flat token stream.
//
// This is a deliberately scoped JavaScript lexer: it understands every lexical
// form that changes where code boundaries are - strings, template literals
// (including nested `${}` interpolations), comments, regular expression
// literals, and multi-character operators - but it does not parse grammar.
// Tokens carry their original `start`/`end` offsets so consumers can splice
// the source text without regenerating it.
//
// The one ambiguity that requires heuristic resolution is `/`: it starts a
// regular expression literal unless the previous significant token ends an
// operand (identifier outside a regex-allowing keyword, number, string,
// template text, another regex, or a `)`/`]`/`}`/`++`/`--` punctuator), in
// which case it is division. This matches the heuristic real engines use at
// the lexical level; grammar-dependent corner cases pass through safely
// because consumers never rewrite what they cannot confidently bound.

const PUNCTUATORS = [
  '>>>=',
  '===', '!==', '**=', '<<=', '>>=', '>>>', '...', '&&=', '||=', '??=',
  '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=',
  '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>', '=>',
  '{', '}', '(', ')', '[', ']', ';', ',', ':', '?', '.', '=', '+', '-',
  '*', '/', '%', '&', '|', '^', '!', '~', '<', '>'
];

// Keywords after which a `/` starts a regular expression rather than division.
const REGEX_ALLOWED_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await'
]);

const isIdentifierStart = (char) => /[A-Za-z_$]/.test(char);
const isIdentifierPart = (char) => /[A-Za-z0-9_$]/.test(char);

/**
 * Decides whether a `/` at the current position starts a regex literal.
 * @param {Object|null} previous - The previous significant token, if any.
 * @returns {boolean}
 */
function regexAllowedAfter(previous) {
  if (!previous) return true;
  if (previous.type === 'identifier') return REGEX_ALLOWED_KEYWORDS.has(previous.value);
  if (previous.type === 'punctuator') return !')]}'.includes(previous.value) && previous.value !== '++' && previous.value !== '--';
  return false;
}

// ECMAScript line terminators: LF, CR, LINE SEPARATOR, PARAGRAPH SEPARATOR.
// The separators are built with fromCharCode because, written literally, they
// would end this source line.
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const isLineTerminator = (char) => char === '\n' || char === '\r' || char === LINE_SEPARATOR || char === PARAGRAPH_SEPARATOR;

// The length of a backslash escape at `index`: a CRLF line continuation is
// three characters, every other escape two.
const escapeLength = (source, index) => (source[index + 1] === '\r' && source[index + 2] === '\n' ? 3 : 2);

function scanString(source, start) {
  const quote = source[start];
  let current = start + 1;

  while (current < source.length) {
    const char = source[current];
    if (char === '\\') current += escapeLength(source, current);
    else if (char === quote) return current + 1;
    // A raw LF or CR is invalid inside a string: stop before it. (U+2028 and
    // U+2029 are legal string content since ES2019.)
    else if (char === '\n' || char === '\r') return current;
    else current += 1;
  }

  return current;
}

function scanTemplateText(source, start) {
  let current = start;

  while (current < source.length) {
    const char = source[current];
    if (char === '\\') current += escapeLength(source, current);
    else if (char === '`' || (char === '$' && source[current + 1] === '{')) return current;
    else current += 1;
  }

  return current;
}

function scanRegex(source, start) {
  let current = start + 1;
  let inCharacterClass = false;

  while (current < source.length) {
    const char = source[current];
    if (isLineTerminator(source[current + 1]) && char === '\\') return -1;
    if (char === '\\') current += 2;
    else if (isLineTerminator(char)) return -1; // Regex literals cannot span lines.
    else if (char === '[') { inCharacterClass = true; current += 1; }
    else if (char === ']') { inCharacterClass = false; current += 1; }
    else if (char === '/' && !inCharacterClass) {
      current += 1;
      while (current < source.length && /[A-Za-z]/.test(source[current])) current += 1;
      return current;
    }
    else current += 1;
  }

  return -1;
}

function scanNumber(source, start) {
  let current = start;

  if (source[current] === '0' && /[xXoObB]/.test(source[current + 1] ?? '')) {
    current += 2;
    while (/[0-9a-fA-F_]/.test(source[current] ?? '')) current += 1;
  } else {
    while (/[0-9_]/.test(source[current] ?? '')) current += 1;
    if (source[current] === '.') {
      current += 1;
      while (/[0-9_]/.test(source[current] ?? '')) current += 1;
    }
    if (/[eE]/.test(source[current] ?? '')) {
      const exponentStart = current;
      current += 1;
      if (/[+-]/.test(source[current] ?? '')) current += 1;
      if (!/[0-9]/.test(source[current] ?? '')) current = exponentStart;
      else while (/[0-9_]/.test(source[current] ?? '')) current += 1;
    }
  }

  if (source[current] === 'n') current += 1; // BigInt literal.
  return current;
}

/**
 * Tokenizes raw script source. Comments are emitted as tokens so offsets stay
 * aligned; template literal text is emitted as opaque `templateText` tokens
 * with the interpolations between them tokenized as normal code between `${`
 * and a `}` punctuator flagged with `interpolationClose: true`.
 * @param {string} source - The raw script text.
 * @returns {Array<{type: string, value: string, start: number, end: number, newlineBefore: boolean, interpolationClose?: boolean}>}
 */
function tokenizeScript(source) {
  const tokens = [];
  const modes = ['code'];          // 'code' or 'template'
  const interpolationDepths = [];  // Open brace count per active `${` interpolation.
  let current = 0;
  let pendingNewline = false;
  let previous = null;

  const push = (type, start, end, extra = {}) => {
    const token = { type, value: source.slice(start, end), start, end, newlineBefore: pendingNewline, ...extra };
    if (type !== 'comment') previous = token;
    tokens.push(token);
    pendingNewline = false;
  };

  while (current < source.length) {
    const char = source[current];

    if (isLineTerminator(char)) { pendingNewline = true; current += 1; continue; }
    if (/\s/.test(char)) { current += 1; continue; }

    if (modes[modes.length - 1] === 'template') {
      const textEnd = scanTemplateText(source, current);
      if (textEnd > current) {
        push('templateText', current, textEnd);
        current = textEnd;
      }
      if (source[current] === '`') {
        push('punctuator', current, current + 1);
        modes.pop();
        current += 1;
      } else if (source[current] === '$' && source[current + 1] === '{') {
        push('punctuator', current, current + 2);
        modes.push('code');
        interpolationDepths.push(0);
        current += 2;
      }
      continue;
    }

    if (char === '/' && source[current + 1] === '/') {
      // Any ECMAScript line terminator ends a line comment, not only LF:
      // missing CR, U+2028, or U+2029 here swallowed the code after them.
      let end = current + 2;
      while (end < source.length && !isLineTerminator(source[end])) end += 1;
      push('comment', current, end);
      current = end;
      continue;
    }

    if (char === '/' && source[current + 1] === '*') {
      const close = source.indexOf('*/', current + 2);
      const end = close === -1 ? source.length : close + 2;
      push('comment', current, end);
      current = end;
      continue;
    }

    if (char === '"' || char === "'") {
      const end = scanString(source, current);
      push('string', current, end);
      current = end;
      continue;
    }

    if (char === '`') {
      push('punctuator', current, current + 1);
      modes.push('template');
      current += 1;
      continue;
    }

    if (isIdentifierStart(char)) {
      let end = current + 1;
      while (end < source.length && isIdentifierPart(source[end])) end += 1;
      push('identifier', current, end);
      current = end;
      continue;
    }

    if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(source[current + 1] ?? ''))) {
      const end = scanNumber(source, current);
      push('number', current, end);
      current = end;
      continue;
    }

    if (char === '/' && regexAllowedAfter(previous)) {
      const end = scanRegex(source, current);
      if (end !== -1) {
        push('regex', current, end);
        current = end;
      } else {
        // Unterminated regex: emit the slash as division so the scan continues.
        push('punctuator', current, current + 1);
        current += 1;
      }
      continue;
    }

    const punctuator = PUNCTUATORS.find((candidate) => source.startsWith(candidate, current));
    if (punctuator) {
      if (punctuator === '{' && interpolationDepths.length > 0) interpolationDepths[interpolationDepths.length - 1] += 1;

      if (punctuator === '}' && interpolationDepths.length > 0) {
        if (interpolationDepths[interpolationDepths.length - 1] === 0) {
          push('punctuator', current, current + 1, { interpolationClose: true });
          interpolationDepths.pop();
          modes.pop();
          current += 1;
          continue;
        }
        interpolationDepths[interpolationDepths.length - 1] -= 1;
      }

      push('punctuator', current, current + punctuator.length);
      current += punctuator.length;
      continue;
    }

    // Unknown character: emit it as a single-character punctuator so the
    // lexer always makes progress.
    push('punctuator', current, current + 1);
    current += 1;
  }

  return tokens;
}

/**
 * Computes matching open/close token indices for every template literal so
 * consumers can skip a whole template (interpolations included) in one step.
 * @param {Array<Object>} tokens - Tokens from tokenizeScript().
 * @returns {Map<number, number>} Open backtick index -> close backtick index.
 */
function matchTemplateTokens(tokens) {
  const pairs = new Map();
  const stack = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== 'punctuator') continue;

    if (token.value === '`') {
      if (stack.length > 0 && stack[stack.length - 1].kind === 'template') {
        pairs.set(stack.pop().index, index);
      } else {
        stack.push({ kind: 'template', index });
      }
    } else if (token.value === '${') {
      stack.push({ kind: 'interpolation', index });
    } else if (token.value === '}' && token.interpolationClose) {
      stack.pop();
    }
  }

  return pairs;
}

// PUNCTUATORS and scanRegex are exported for the production compactor
// (src/compiler/compact/), which reuses this scanner instead of a second lexer.
module.exports = { tokenizeScript, matchTemplateTokens, PUNCTUATORS, scanRegex };

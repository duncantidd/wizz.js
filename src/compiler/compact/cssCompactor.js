// Conservative CSS compaction for `wizz build --compact` (milestone 23).
//
// Removes comments and insignificant whitespace; never reorders, merges, or
// rewrites rules, values, or selectors. Copied byte for byte:
//
//   - quoted strings (`content: "a  b"`, `[title='x y']`);
//   - unquoted `url(...)` bodies;
//   - backslash escapes, including the single whitespace that terminates a
//     hex escape (`.a\26 b` — that space is part of the escape, and a second
//     space after it is a descendant combinator).
//
// Whitespace runs collapse to one space, which is then dropped only next to
// `{`, `}`, `;`, `,`, after `:` or `(`, and before `)`. Whitespace before
// `:` (`a :hover` is a descendant pseudo-class, not `a:hover`), before `(`
// (`and (min-width...)` is not a function call), after `)`, and around
// `+ - * / > ~` (calc() needs them, combinators are harmless either way) is
// kept as a single space. A `;` directly before `}` is dropped.
//
// Removing a comment that sat between two tokens with no whitespace around
// it would glue them together (`a/**/b`), so such a comment becomes the
// empty comment `/**/`, which keeps the token boundary exactly.
//
// Malformed input — an unterminated comment, string, or url() — throws a
// SyntaxError carrying 1-based `line`/`column` fields; nothing is emitted.

const { locate } = require('./jsCompactor');

// Whitespace next to these characters never separates two tokens that would
// otherwise merge, on either side.
const STRIP_BOTH_SIDES = new Set(['{', '}', ';', ',']);
const STRIP_AFTER = new Set([...STRIP_BOTH_SIDES, ':', '(']);
const STRIP_BEFORE = new Set([...STRIP_BOTH_SIDES, ')']);
const WHITESPACE = /[ \t\n\r\f]/;

function compactionError(message, source, offset) {
  const { line, column } = locate(source, offset);
  const error = new SyntaxError(`${message} (line ${line}, column ${column})`);
  error.line = line;
  error.column = column;
  error.offset = offset;
  return error;
}

function scanString(source, start) {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    // An escaped newline is a line continuation; CRLF counts as one newline
    // (CSS Syntax preprocessing), so it is three characters, not two.
    if (character === '\\') index += source[index + 1] === '\r' && source[index + 2] === '\n' ? 3 : 2;
    else if (character === quote) return index + 1;
    else if (character === '\n' || character === '\r' || character === '\f') break;
    else index += 1;
  }
  throw compactionError('Unterminated string', source, start);
}

// The length of a backslash escape starting at `start` (CSS Syntax §4.3.7):
// up to six hex digits plus one optional terminating whitespace character
// (CRLF counts as one), or any single other code point.
function escapeLength(source, start) {
  let index = start + 1;
  if (index >= source.length) return 1;
  if (/[0-9a-fA-F]/.test(source[index])) {
    const hexStart = index;
    while (index < source.length && index - hexStart < 6 && /[0-9a-fA-F]/.test(source[index])) index += 1;
    if (source[index] === '\r' && source[index + 1] === '\n') index += 2;
    else if (index < source.length && WHITESPACE.test(source[index])) index += 1;
    return index - start;
  }
  const codePoint = source.codePointAt(index);
  return 1 + (codePoint > 0xffff ? 2 : 1);
}

// Is `url(` at `index` the start of an unquoted-url function? It must not be
// the tail of a longer identifier (`myurl(`).
function startsUrl(source, index) {
  if (source.slice(index, index + 4).toLowerCase() !== 'url(') return false;
  const before = source[index - 1];
  if (before === undefined) return true;
  return !(/[A-Za-z0-9_-]/.test(before) || before === '\\' || before.charCodeAt(0) >= 0x80);
}

/**
 * Compacts a stylesheet. See the file header for the exact rules.
 * @param {string} source
 * @returns {string}
 */
function compactCss(source) {
  if (typeof source !== 'string') throw new TypeError('compactCss expects a string.');

  // Output is collected in parts and its last character tracked separately:
  // indexing a long concatenated string makes V8 flatten it on every read.
  const parts = [];
  let lastCharacter;
  // Was the last output a verbatim copy (string, escape, url)? Punctuation
  // that ends one (`\{`, `\;`) is not structural, so it never licenses
  // dropping whitespace or the `;}` rewrite.
  let lastWasLiteral = false;
  // A structural `;` is held back until the next output: dropped if that is
  // `}`, emitted otherwise.
  let pendingSemicolon = false;
  // A pending separator: null, 'space' (whitespace seen), or 'comment' (a
  // comment dropped with no whitespace around it).
  let pending = null;

  const emit = (text, literal) => {
    if (pendingSemicolon) {
      pendingSemicolon = false;
      if (!(text === '}' && !literal)) {
        parts.push(';');
        lastCharacter = ';';
        lastWasLiteral = false;
      }
    }
    parts.push(text);
    lastCharacter = text[text.length - 1];
    lastWasLiteral = literal;
  };

  const flush = (nextCharacter) => {
    if (pending === null) return;
    const kind = pending;
    pending = null;
    // The held-back `;` is the real last character for spacing decisions.
    const last = pendingSemicolon ? ';' : lastCharacter;
    const structuralLast = pendingSemicolon || !lastWasLiteral;
    if (last === undefined) return; // Leading whitespace/comments.
    // `--x: ;` (an empty custom property) keeps its space: `--x:;` was
    // rejected by older engines.
    const emptyCustomValue = kind === 'space' && last === ':' && structuralLast &&
      (nextCharacter === ';' || nextCharacter === '}');
    const strippable = (structuralLast && STRIP_AFTER.has(last)) || STRIP_BEFORE.has(nextCharacter);
    if (emptyCustomValue || !strippable) emit(kind === 'space' ? ' ' : '/**/', false);
  };

  let index = 0;
  while (index < source.length) {
    const character = source[index];

    if (WHITESPACE.test(character)) {
      pending = 'space';
      index += 1;
      continue;
    }

    if (character === '/' && source[index + 1] === '*') {
      const close = source.indexOf('*/', index + 2);
      if (close === -1) throw compactionError('Unterminated comment', source, index);
      if (pending === null) pending = 'comment';
      index = close + 2;
      continue;
    }

    flush(character);

    if (character === '"' || character === "'") {
      const stringEnd = scanString(source, index);
      emit(source.slice(index, stringEnd), true);
      index = stringEnd;
      continue;
    }

    if (character === '\\') {
      const length = escapeLength(source, index);
      emit(source.slice(index, index + length), true);
      index += length;
      continue;
    }

    if ((character === 'u' || character === 'U') && startsUrl(source, index)) {
      // Leading whitespace inside url( is insignificant; a quoted argument
      // makes it an ordinary function handled by the main loop.
      let cursor = index + 4;
      while (cursor < source.length && WHITESPACE.test(source[cursor])) cursor += 1;
      emit(source.slice(index, index + 4), false);
      if (source[cursor] === '"' || source[cursor] === "'") {
        index = cursor;
        continue;
      }
      let urlEnd = cursor;
      while (urlEnd < source.length && source[urlEnd] !== ')') {
        urlEnd += source[urlEnd] === '\\' ? 2 : 1;
      }
      if (urlEnd >= source.length) throw compactionError('Unterminated url()', source, index);
      emit(source.slice(cursor, urlEnd).replace(/[ \t\n\r\f]+$/, '') + ')', true);
      index = urlEnd + 1;
      continue;
    }

    if (character === ';') {
      if (pendingSemicolon) {
        // `;;`: release the held one; only the last before `}` may drop.
        parts.push(';');
        lastCharacter = ';';
        lastWasLiteral = false;
      }
      pendingSemicolon = true;
      index += 1;
      continue;
    }

    emit(character, false);
    index += 1;
  }

  if (pendingSemicolon) parts.push(';');
  return parts.join('');
}

module.exports = { compactCss };

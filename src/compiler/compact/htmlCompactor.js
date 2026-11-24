// Conservative HTML compaction for the `wizz build --compact` document shell
// (milestone 23).
//
// Only two things change:
//
//   - comments are removed, except conditional comments (`<!--[if ...`) and
//     Wizz markers (`<!--wizz...`), which tooling may look for;
//   - each whitespace run in text collapses to one character: a newline if
//     the run contained one, otherwise a space. Runs are never removed
//     outright, because whitespace between inline elements renders.
//
// Everything else is copied byte for byte:
//
//   - every tag, including its attributes and their spacing, so consumers
//     matching literal markup (the SSR hosts replace `<div id="app"></div>`
//     and `</head>` verbatim) keep working;
//   - the doctype, processing instructions, and CDATA sections;
//   - the full content of raw-text and whitespace-significant elements:
//     `<script>` (every type, including `application/wizz-state` payloads),
//     `<style>`, `<pre>`, `<textarea>` and `<title>` (both RCDATA: `<!--` and
//     `<x` are literal text there), `<listing>`, `<xmp>`, `<iframe>`,
//     `<noembed>`, `<noframes>`, and `<plaintext>` (to the end of input).
//
// Conservative assumption: text whitespace is treated as collapsible. A shell
// that styles an ordinary element with `white-space: pre` would see its runs
// collapse; such content belongs in `<pre>`.
//
// Malformed input — an unterminated comment, tag, or raw-text element —
// throws a SyntaxError carrying 1-based `line`/`column` fields.

const { locate } = require('./jsCompactor');

const VERBATIM_ELEMENTS = new Set([
  'script', 'style', 'pre', 'textarea', 'title', 'listing', 'xmp', 'iframe', 'noembed', 'noframes'
]);

function compactionError(message, source, offset) {
  const { line, column } = locate(source, offset);
  const error = new SyntaxError(`${message} (line ${line}, column ${column})`);
  error.line = line;
  error.column = column;
  error.offset = offset;
  return error;
}

// The index just past the `>` closing the tag that opens at `start`,
// honoring quoted attribute values (which may contain `>`).
function scanTagEnd(source, start) {
  let index = start + 1;
  let quote = null;
  while (index < source.length) {
    const character = source[index];
    if (quote !== null) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      // Quotes only open a value after `=` (possibly spaced); elsewhere they
      // are plain characters of a malformed name, as the HTML tokenizer
      // treats them.
      let back = index - 1;
      while (back > start && /\s/.test(source[back])) back -= 1;
      if (source[back] === '=') quote = character;
    } else if (character === '>') {
      return index + 1;
    }
    index += 1;
  }
  throw compactionError('Unterminated tag', source, start);
}

/**
 * Compacts an HTML document. See the file header for the exact rules.
 * @param {string} source
 * @returns {string}
 */
function compactHtml(source) {
  if (typeof source !== 'string') throw new TypeError('compactHtml expects a string.');

  let output = '';
  let index = 0;
  // output.length right after a collapsed whitespace run. Two runs separated
  // only by a removed comment merge into one, as if the comment never was.
  let collapsedEnd = -1;

  while (index < source.length) {
    const character = source[index];

    if (/\s/.test(character)) {
      let end = index;
      while (end < source.length && /\s/.test(source[end])) end += 1;
      const replacement = /[\n\r]/.test(source.slice(index, end)) ? '\n' : ' ';
      if (output.length === collapsedEnd) {
        // The previous run is the last character; upgrade it in place. This
        // only happens across a removed comment, so the slice stays rare.
        if (replacement === '\n') output = `${output.slice(0, -1)}\n`;
      } else {
        output += replacement;
      }
      collapsedEnd = output.length;
      index = end;
      continue;
    }

    if (character !== '<') {
      output += character;
      index += 1;
      continue;
    }

    if (source.startsWith('<!--', index)) {
      const close = source.indexOf('-->', index + 4);
      if (close === -1) throw compactionError('Unterminated comment', source, index);
      const comment = source.slice(index, close + 3);
      if (/^<!--\[if\b/i.test(comment) || /^<!--\s*wizz/i.test(comment)) output += comment;
      index = close + 3;
      continue;
    }

    if (source.startsWith('<![CDATA[', index)) {
      const close = source.indexOf(']]>', index);
      if (close === -1) throw compactionError('Unterminated CDATA section', source, index);
      output += source.slice(index, close + 3);
      index = close + 3;
      continue;
    }

    const next = source[index + 1];
    const isTag = next !== undefined && (/[A-Za-z]/.test(next) || next === '/' || next === '!' || next === '?');
    if (!isTag) {
      // A bare `<` in text (`a < b`) is text.
      output += character;
      index += 1;
      continue;
    }

    const tagEnd = scanTagEnd(source, index);
    const tag = source.slice(index, tagEnd);
    output += tag;
    index = tagEnd;

    const nameMatch = /^<([A-Za-z][A-Za-z0-9-]*)/.exec(tag);
    if (!nameMatch) continue;
    const name = nameMatch[1].toLowerCase();

    if (name === 'plaintext') {
      output += source.slice(index);
      index = source.length;
      continue;
    }

    // A trailing `/>` does not self-close these in HTML: `<script src=x />`
    // still opens raw text that runs to `</script>`.
    if (VERBATIM_ELEMENTS.has(name)) {
      const closePattern = new RegExp(`</${name}(?=[\\s/>])`, 'gi');
      closePattern.lastIndex = index;
      const close = closePattern.exec(source);
      if (close === null) throw compactionError(`Unterminated <${name}> element`, source, index - tag.length);
      output += source.slice(index, close.index);
      index = close.index;
    }
  }

  return output;
}

module.exports = { compactHtml };

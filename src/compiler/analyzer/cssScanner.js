/**
 * A minimal, zero-dependency CSS scanner for scoped component stylesheets.
 * This is deliberately NOT a full CSS parser: it walks rules by brace
 * matching, stays aware of strings and comments so braces inside them never
 * confuse the scan, and rewrites only what scoping requires — the terminal
 * compound of each qualified rule's selector, and @keyframes names (keyframe
 * names are document-global, so they must be suffixed with the component
 * scope to stay isolated between styled components).
 *
 * Conservative assumptions (documented per the project's ambiguity policy):
 * - Only @media, @supports, and @container blocks are descended into for
 *   selector scoping. Every other at-rule (@font-face, @page, @layer,
 *   @property, unknown vendor blocks) is passed through verbatim — their
 *   preludes either have no element selectors or cannot legally carry an
 *   attribute selector.
 * - Keyframe bodies are passed through verbatim: their inner selectors are
 *   `from`, `to`, and percentages, never elements. Keyframe name references
 *   are rewritten only in `animation` / `animation-name` declaration values
 *   of ordinary rules (a keyframe animating another keyframe is out of
 *   scope).
 * - A keyframe named after a CSS-wide keyword (e.g. `infinite`) used as the
 *   iteration count in a shorthand would be renamed too; naming keyframes
 *   after CSS-wide keywords is already invalid CSS practice.
 */

// At-rules whose bodies contain ordinary qualified rules that need scoping.
const DESCEND_AT_RULES = /^(?:media|supports|container)$/;
// @keyframes including vendor-prefixed variants (@-webkit-keyframes — note
// the leading hyphen before the prefix).
const KEYFRAMES_AT_RULE = /^\s*@-?(?:[A-Za-z]+-)?keyframes(?:\s|$)/;
const KEYFRAMES_NAME = /^\s*@-?(?:[A-Za-z]+-)?keyframes\s+([A-Za-z-$][\w$-]*)/;
// `animation:` / `animation-name:` only — the colon anchor keeps
// `animation-duration:` and friends out (the optional `-name` group cannot
// match `-duration`, and `\s*:` then fails on the `-`).
const ANIMATION_DECLARATION = /^\s*animation(?:-name)?\s*:/;

// Returns the index just past a comment starting at `i` (`/* ... */`), or
// the string length when the comment is unterminated.
function skipComment(text, i) {
  let j = i + 2;
  while (j < text.length && !(text[j] === '*' && text[j + 1] === '/')) j += 1;
  return Math.min(j + 2, text.length);
}

// Returns the index just past a quoted string starting at `i`, honoring
// backslash escapes. Unterminated strings consume the rest of the input.
function skipString(text, i) {
  const quote = text[i];
  let j = i + 1;
  while (j < text.length) {
    if (text[j] === '\\') { j += 2; continue; }
    if (text[j] === quote) { j += 1; break; }
    j += 1;
  }
  return Math.min(j, text.length);
}

// Returns the index of the `}` matching the `{` at `openIndex`, honoring
// strings and comments. Unterminated blocks extend to the end of the input.
function matchBrace(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    const char = text[i];
    if (char === '/' && text[i + 1] === '*') { i = skipComment(text, i) - 1; continue; }
    if (char === '"' || char === "'") { i = skipString(text, i) - 1; continue; }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return text.length;
}

// A same-length copy of `text` with comment and string interiors blanked to
// spaces. All structural analysis (brace matching, selector splitting,
// insertion points) runs on the mask so quoted braces, commas, and combinators
// never mislead it, while insertions are applied to the original text by
// index — preserving the author's formatting byte for byte.
function maskLiterals(text) {
  const chars = text.split('');
  let i = 0;
  while (i < chars.length) {
    const char = chars[i];
    if (char === '/' && chars[i + 1] === '*') {
      const end = skipComment(text, i);
      for (let k = i; k < end; k += 1) chars[k] = ' ';
      i = end;
      continue;
    }
    if (char === '"' || char === "'") {
      const end = skipString(text, i);
      for (let k = i; k < end; k += 1) chars[k] = ' ';
      i = end;
      continue;
    }
    i += 1;
  }
  return chars.join('');
}

// Splits a block's content into top-level items, each `{ prelude, body, raw }`:
// `body === null` for declaration items (terminated by `;` or the end of the
// block), otherwise the inner content of the matched brace block. `raw` is the
// verbatim source slice for pass-through emission.
function scanItems(content) {
  const items = [];
  let i = 0;
  let start = 0;
  while (i < content.length) {
    const char = content[i];
    if (char === '/' && content[i + 1] === '*') { i = skipComment(content, i); continue; }
    if (char === '"' || char === "'") { i = skipString(content, i); continue; }
    if (char === '{') {
      const close = matchBrace(content, i);
      // An unterminated block (defensive: the tokenizer rejects unclosed
      // <wizz:style> bodies before the scanner ever runs) must not gain a
      // closing brace the source never had.
      const closed = close < content.length;
      items.push({
        prelude: content.slice(start, i),
        body: content.slice(i + 1, close),
        raw: closed ? content.slice(start, close + 1) : content.slice(start),
        closed
      });
      i = close + 1;
      start = i;
      continue;
    }
    if (char === ';') {
      items.push({ prelude: content.slice(start, i), body: null, raw: content.slice(start, i + 1) });
      i += 1;
      start = i;
      continue;
    }
    i += 1;
  }
  // The trailing slice is pushed whenever it is non-empty — including
  // whitespace-only tails — so pass-through emission preserves the author's
  // trailing formatting before a closing brace.
  const tail = content.slice(start);
  if (tail.length > 0) {
    items.push({ prelude: tail, body: null, raw: tail });
  }
  return items;
}

// Returns the start index of the terminal (subject) compound of a masked
// selector: the first character after the last top-level combinator. Whitespace
// runs and `>` / `+` / `~` outside parens and brackets are combinators; the
// same characters inside `:is(...)`, `[attr="a b"]`, and friends are not.
function findTerminalCompoundStart(masked) {
  let i = 0;
  while (i < masked.length && /\s/.test(masked[i])) i += 1;
  let compoundStart = i;
  let depth = 0;
  let afterCombinator = false;
  for (; i < masked.length; i += 1) {
    const char = masked[i];
    if (char === '(' || char === '[') { depth += 1; afterCombinator = false; continue; }
    if (char === ')' || char === ']') { depth = Math.max(0, depth - 1); continue; }
    if (depth > 0) continue;
    if (char === '>' || char === '+' || char === '~' || /\s/.test(char)) {
      afterCombinator = true;
      continue;
    }
    if (afterCombinator) {
      compoundStart = i;
      afterCombinator = false;
    }
  }
  return compoundStart;
}

// Returns the index at which the scope attribute is inserted for the terminal
// compound beginning at `compoundStart`. A compound's simple selectors are an
// unordered sequence except that a type or universal selector must come first,
// so: type (`h2`), universal (`*`), and nesting anchors (`&`) take the
// attribute immediately after; `.class`, `#id`, `[attr]`, and pseudo selectors
// take it as the new first simple selector.
function findInsertionIndex(masked, compoundStart) {
  const first = masked[compoundStart];
  if (first === '&' || first === '*' || /[A-Za-z]/.test(first)) {
    let j = compoundStart + 1;
    while (j < masked.length && /[\w$-]/.test(masked[j])) j += 1;
    return j;
  }
  return compoundStart;
}

// Splits a masked selector prelude on top-level commas (not inside parens or
// brackets, e.g. `:is(a, b)` stays whole). Returns [start, end] index pairs.
function splitTopLevel(masked) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < masked.length; i += 1) {
    const char = masked[i];
    if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') depth = Math.max(0, depth - 1);
    else if (char === ',' && depth === 0) {
      parts.push([start, i]);
      start = i + 1;
    }
  }
  parts.push([start, masked.length]);
  return parts;
}

function escapeScopeValue(scope) {
  // The compiler always generates base36 scopes, so these never fire in
  // practice; the escape is hardening for direct scanner callers.
  return scope.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Rewrites a qualified rule's selector prelude so each comma-separated
// selector's terminal compound gains the scope attribute. Literals are
// preserved verbatim; only the inserted attributes are new text.
function scopeSelectorPrelude(prelude, scope) {
  const masked = maskLiterals(prelude);
  const attribute = `[data-wizz-s="${escapeScopeValue(scope)}"]`;
  let out = '';
  let cursor = 0;
  for (const [start, end] of splitTopLevel(masked)) {
    if (masked.slice(start, end).trim() === '') continue;
    const compoundStart = start + findTerminalCompoundStart(masked.slice(start, end));
    const insertAt = findInsertionIndex(masked, compoundStart);
    out += prelude.slice(cursor, insertAt) + attribute;
    cursor = insertAt;
  }
  return out + prelude.slice(cursor);
}

// Rewrites a keyframes at-rule prelude, suffixing the declared name so the
// document-global keyframe namespace stays per-component.
function scopeKeyframesPrelude(prelude, scope) {
  const masked = maskLiterals(prelude);
  const match = KEYFRAMES_NAME.exec(masked);
  if (!match) return prelude;
  const insertAt = match.index + match[0].length;
  return `${prelude.slice(0, insertAt)}-${scope}${prelude.slice(insertAt)}`;
}

// Rewrites the value of an `animation` / `animation-name` declaration,
// suffixing identifier tokens that exactly match a declared keyframe name.
// Boundary detection runs on the mask (strings and comments are skipped);
// replacements are applied to the original by index.
function scopeAnimationValue(prelude, scope, keyframeNames) {
  if (keyframeNames.size === 0) return prelude;
  const masked = maskLiterals(prelude);
  const colon = masked.indexOf(':');
  if (colon === -1) return prelude;

  let out = prelude.slice(0, colon + 1);
  const valueStart = colon + 1;
  // Ident indexes are relative to the start of the value, so the read cursor
  // and the match base must be tracked separately: advancing the cursor past
  // a rewritten name must not shift where the next match is spliced, or every
  // keyframe name after the first in a comma-separated value lands corrupted.
  let read = valueStart;
  const value = masked.slice(valueStart);
  const identPattern = /[-\w$]+/g;
  let match = identPattern.exec(value);
  while (match) {
    if (keyframeNames.has(match[0])) {
      const start = valueStart + match.index;
      const end = start + match[0].length;
      out += `${prelude.slice(read, start)}${match[0]}-${scope}`;
      read = end;
    }
    match = identPattern.exec(value);
  }
  return out + prelude.slice(read);
}

// Recursively processes one block's content, returning CSS with every
// qualified rule scoped to `scope`.
function processBlock(content, scope, keyframeNames) {
  let out = '';
  for (const item of scanItems(content)) {
    if (item.body === null) {
      // Declaration or statement item: verbatim, except animation
      // declarations referencing this component's keyframes. The rewritten
      // prelude excludes the terminator, so reattach the `;` the raw slice
      // carried.
      if (ANIMATION_DECLARATION.test(maskLiterals(item.prelude))) {
        out += scopeAnimationValue(item.prelude, scope, keyframeNames)
          + (item.raw.endsWith(';') ? ';' : '');
      } else {
        out += item.raw;
      }
      continue;
    }

    const maskedPrelude = maskLiterals(item.prelude);
    const trimmed = maskedPrelude.trimStart();
    if (trimmed.startsWith('@')) {
      const closingBrace = item.closed ? '}' : '';
      if (KEYFRAMES_AT_RULE.test(maskedPrelude)) {
        out += `${scopeKeyframesPrelude(item.prelude, scope)}{${item.body}${closingBrace}`;
      } else if (DESCEND_AT_RULES.test(trimmed.slice(1).trim().split(/[\s({]/, 1)[0])) {
        out += `${item.prelude}{${processBlock(item.body, scope, keyframeNames)}${closingBrace}`;
      } else {
        // Other at-rules pass through untouched (see the header note).
        out += item.raw;
      }
      continue;
    }

    out += `${scopeSelectorPrelude(item.prelude, scope)}{${processBlock(item.body, scope, keyframeNames)}${item.closed ? '}' : ''}`;
  }
  return out;
}

// Collects every @keyframes name declared anywhere in the CSS (including
// inside @media/@supports/@container blocks and nested rules) so animation
// declarations can be rewritten in a single pass.
function collectKeyframeNames(content, names) {
  for (const item of scanItems(content)) {
    if (item.body === null) continue;
    const maskedPrelude = maskLiterals(item.prelude);
    const trimmed = maskedPrelude.trimStart();
    if (trimmed.startsWith('@')) {
      const nameMatch = KEYFRAMES_NAME.exec(maskedPrelude);
      if (nameMatch) names.add(nameMatch[1]);
      else if (DESCEND_AT_RULES.test(trimmed.slice(1).trim().split(/[\s({]/, 1)[0])) {
        collectKeyframeNames(item.body, names);
      }
      continue;
    }
    collectKeyframeNames(item.body, names);
  }
}

/**
 * Scopes a styled component's CSS: every qualified rule's terminal selector
 * gains `[data-wizz-s="<scope>"]`, and @keyframes names are suffixed with the
 * scope (with matching animation declarations rewritten) because keyframe
 * names are document-global. Formatting, comments, strings, and declarations
 * are preserved verbatim.
 * @param {string} css - The raw stylesheet text from a <wizz:style> block.
 * @param {string} scope - The component's generated scope value.
 * @returns {string} The scoped CSS.
 */
function scopeCss(css, scope) {
  if (typeof css !== 'string') throw new TypeError('CSS input must be a string.');
  if (typeof scope !== 'string' || scope === '') throw new TypeError('A style scope value is required.');
  if (css.trim() === '') return css;

  const keyframeNames = new Set();
  collectKeyframeNames(css, keyframeNames);
  return processBlock(css, scope, keyframeNames);
}

module.exports = { scopeCss };

const isIdentifierStart = (char) => typeof char === 'string' && /^[A-Za-z_$]$/.test(char);
const isIdentifierPart = (char) => typeof char === 'string' && /^[A-Za-z0-9_$]$/.test(char);

function skipQuotedString(source, start, quote) {
  let current = start + 1;

  while (current < source.length) {
    if (source[current] === '\\') current += 2;
    else if (source[current] === quote) return current + 1;
    else current += 1;
  }

  return current;
}

function skipComment(source, start) {
  if (source[start + 1] === '/') {
    const newline = source.indexOf('\n', start + 2);
    return newline === -1 ? source.length : newline;
  }

  const end = source.indexOf('*/', start + 2);
  return end === -1 ? source.length : end + 2;
}

function skipTemplateLiteral(source, start) {
  let current = start + 1;

  while (current < source.length) {
    if (source[current] === '\\') current += 2;
    else if (source[current] === '`') return current + 1;
    else current += 1;
  }

  return current;
}

function skipRegexLiteral(source, start) {
  let current = start + 1;
  let inCharacterClass = false;

  while (current < source.length) {
    const char = source[current];
    if (char === '\\') current += 2;
    else {
      if (char === '[') inCharacterClass = true;
      else if (char === ']') inCharacterClass = false;
      else if (char === '/' && !inCharacterClass) return current + 1;
      current += 1;
    }
  }

  // Unterminated: consume only the slash so the scan can continue.
  return start + 1;
}

function skipProtectedRegion(source, current) {
  const char = source[current];

  if (char === '"' || char === "'") return skipQuotedString(source, current, char);
  if (char === '`') return skipTemplateLiteral(source, current);
  if (char === '/' && (source[current + 1] === '/' || source[current + 1] === '*')) {
    return skipComment(source, current);
  }

  return current + 1;
}

function skipWhitespace(source, current) {
  while (current < source.length && /\s/.test(source[current])) current += 1;
  return current;
}

function previousWord(source, current) {
  while (current > 0 && /\s/.test(source[current - 1])) current -= 1;
  const end = current;
  while (current > 0 && isIdentifierPart(source[current - 1])) current -= 1;
  return source.slice(current, end);
}

function skipBracketAccess(source, start) {
  let current = start;
  let depth = 0;

  while (current < source.length) {
    const char = source[current];
    if (char === '"' || char === "'" || char === '`' || (char === '/' && (source[current + 1] === '/' || source[current + 1] === '*'))) {
      current = skipProtectedRegion(source, current);
      continue;
    }
    if (char === '[') depth += 1;
    if (char === ']') {
      depth -= 1;
      if (depth === 0) return current + 1;
    }
    current += 1;
  }

  return start;
}

function skipPropertyAccess(source, start) {
  let current = start;

  while (current < source.length) {
    const propertyStart = skipWhitespace(source, current);
    if (source[propertyStart] === '.') {
      current = skipWhitespace(source, propertyStart + 1);
      if (!isIdentifierStart(source[current])) return start;
      current += 1;
      while (isIdentifierPart(source[current])) current += 1;
      continue;
    }
    if (source[propertyStart] === '[') {
      const next = skipBracketAccess(source, propertyStart);
      if (next === propertyStart) return start;
      current = next;
      continue;
    }
    return current;
  }

  return current;
}

function mutationOperatorAt(source, current) {
  const operators = ['**=', '+=', '-=', '*=', '/=', '%=', '++', '--'];
  const operator = operators.find((candidate) => source.startsWith(candidate, current));

  if (operator) return operator;
  if (source[current] === '=' && source[current + 1] !== '=' && source[current + 1] !== '>') return '=';
  return null;
}

function isBareControlFlowBody(source, start) {
  const prefix = source.slice(0, start);

  return /\b(?:else|do)\s*$/.test(prefix)
    || /\b(?:if|for|while|with)\s*\([^{};]*\)\s*$/.test(prefix);
}

function skipProtectedValue(source, current, previousSignificant) {
  const char = source[current];

  if (char === '"' || char === "'" || char === '`') {
    const end = char === '`' ? skipTemplateLiteral(source, current) : skipQuotedString(source, current, char);
    return { end, significant: char };
  }
  if (char === '/' && (source[current + 1] === '/' || source[current + 1] === '*')) {
    // Comments are not significant: what preceded them still applies.
    return { end: skipComment(source, current), significant: previousSignificant };
  }
  if (char === '/') {
    return { end: skipRegexLiteral(source, current), significant: '/' };
  }

  return null;
}

function findStatementEnd(source, start) {
  let current = start;
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  let previousSignificant = '';

  while (current < source.length) {
    const char = source[current];
    const protectedRegion = skipProtectedValue(source, current, previousSignificant);
    if (protectedRegion) {
      current = protectedRegion.end;
      previousSignificant = protectedRegion.significant;
      continue;
    }
    if (char === '(') parentheses += 1;
    else if (char === ')') parentheses -= 1;
    else if (char === '[') brackets += 1;
    else if (char === ']') brackets -= 1;
    else if (char === '{') braces += 1;
    else if (char === '}') braces -= 1;
    else if (char === ';' && parentheses === 0 && brackets === 0 && braces === 0) return current + 1;
    if (!/\s/.test(char)) previousSignificant = char;
    current += 1;
  }

  return null;
}

function findMutation(source, start, reactiveVars) {
  if (!isIdentifierStart(source[start]) || (start > 0 && (isIdentifierPart(source[start - 1]) || source[start - 1] === '.'))) {
    return null;
  }

  let current = start + 1;
  while (isIdentifierPart(source[current])) current += 1;
  const variableName = source.slice(start, current);
  const declaration = previousWord(source, start);
  if (!reactiveVars.has(variableName) || declaration === 'let' || declaration === 'const') return null;

  const propertyEnd = skipPropertyAccess(source, current);
  const operatorStart = skipWhitespace(source, propertyEnd);
  const operator = mutationOperatorAt(source, operatorStart);
  if (!operator) return null;

  const statementEnd = findStatementEnd(source, operatorStart + operator.length);
  return statementEnd ? { statementEnd, variableName } : null;
}

function findPrefixMutation(source, start, reactiveVars) {
  if (!source.startsWith('++', start) && !source.startsWith('--', start)) return null;

  const variableStart = skipWhitespace(source, start + 2);
  if (!isIdentifierStart(source[variableStart])) return null;

  let current = variableStart + 1;
  while (isIdentifierPart(source[current])) current += 1;
  const variableName = source.slice(variableStart, current);
  if (!reactiveVars.has(variableName) || previousWord(source, variableStart) === 'let' || previousWord(source, variableStart) === 'const') {
    return null;
  }

  const propertyEnd = skipPropertyAccess(source, current);
  const statementEnd = findStatementEnd(source, propertyEnd);
  return statementEnd ? { statementEnd, variableName } : null;
}

/**
 * Rewrites semicolon-terminated reactive mutations to notify the component update dispatcher.
 * Strings, template literals, comments, and regular expression literals are preserved without
 * inspection, and rewrites are attempted only at statement level, outside `(` and `[` nesting,
 * so for-loop headers and default parameters are never rewritten.
 *
 * This scanner is deliberately scoped and is not a JavaScript parser. Statements that omit
 * semicolons, mutations nested inside parentheses, and unrecognized syntax pass through
 * untransformed rather than being approximated; broader coverage should replace this module
 * with a syntax-aware JavaScript transform, not widen these heuristics.
 * @param {string} rawScript - The raw JavaScript string from the <script> block.
 * @param {Array<string>} reactiveVars - Reactive variable names.
 * @returns {string} The rewritten JavaScript string.
 */
function interceptAssignments(rawScript, reactiveVars) {
  if (!rawScript || !Array.isArray(reactiveVars) || reactiveVars.length === 0) return rawScript;

  const reactiveNames = new Set(reactiveVars);
  let output = '';
  let current = 0;
  let nestingDepth = 0;
  let previousSignificant = '';

  while (current < rawScript.length) {
    const char = rawScript[current];

    const protectedRegion = skipProtectedValue(rawScript, current, previousSignificant);
    if (protectedRegion) {
      output += rawScript.slice(current, protectedRegion.end);
      current = protectedRegion.end;
      previousSignificant = protectedRegion.significant;
      continue;
    }

    // Braces are deliberately not counted: function and block bodies are legitimate
    // statement-level mutation sites, and telling them apart from object literals
    // would require parsing.
    if (char === '(' || char === '[') nestingDepth += 1;
    else if ((char === ')' || char === ']') && nestingDepth > 0) nestingDepth -= 1;

    if (!/\s/.test(char)) previousSignificant = char;

    if (nestingDepth === 0 && !isBareControlFlowBody(rawScript, current)) {
      const mutation = findPrefixMutation(rawScript, current, reactiveNames)
        || findMutation(rawScript, current, reactiveNames);
      if (mutation) {
        output += rawScript.slice(current, mutation.statementEnd);
        output += ` queueUpdate({ ${mutation.variableName}: true });`;
        current = mutation.statementEnd;
        previousSignificant = ';';
        continue;
      }
    }

    output += char;
    current += 1;
  }

  return output;
}

module.exports = { interceptAssignments };

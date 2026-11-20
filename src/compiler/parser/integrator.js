const { lexExpression } = require('./expressionLexer.js');
const { parseExpression } = require('./prattParser.js');
const { CODES, compilerDiagnostic } = require('../diagnostics.js');

// Quoted attribute values are static (issue #64). A `{name}` inside one would
// render literally with no hint, so it is rejected when its braces hold a
// valid expression. Assumption (conservative): braces whose content does not
// parse as an expression (`data-x='{"a":1}'`, `{}`) stay legitimate literal
// text, so existing static values keep compiling.
const QUOTED_BRACES = /\{([^{}]*)\}/g;

// A brace group counts as interpolation only when its content is a valid
// expression.
function isExpression(source) {
  if (!source.trim()) return false;
  try {
    parseExpression(lexExpression(source));
    return true;
  } catch {
    return false;
  }
}

// The reason an expression was rejected, appended to the attribute and
// `{#if}` diagnostics. Its location is local to the expression, so it is
// dropped: errorAugmenter stamps the first `at L:C` in a message as the
// component location.
function reason(error) {
  const detail = typeof error?.message === 'string' ? error.message.replace(/ at \d+:\d+\.?$/, '').replace(/\.$/, '') : '';
  return detail ? `: ${detail}.` : '.';
}

// In a `+` chain, an operand that binds looser than `+` (a conditional, a
// comparison, `&&`/`||`) or as loosely (`a - b`, which would be read
// left-to-right from the string) must keep its own grouping.
function concatenationPart(source) {
  const ast = parseExpression(lexExpression(source));
  const binds = ast.type === 'ConditionalExpression' || ast.type === 'LogicalExpression'
    || (ast.type === 'BinaryExpression' && ast.operator !== '*' && ast.operator !== '/');
  return binds ? `(${source})` : source;
}

// Builds the `+` form of a quoted value for the suggestion (template literals
// are not in the expression grammar). A leading string literal keeps `{a}{b}`
// from becoming numeric addition.
function concatenation(value) {
  const parts = [];
  let last = 0;
  for (const match of value.matchAll(QUOTED_BRACES)) {
    if (!isExpression(match[1])) continue;
    if (match.index > last) parts.push(JSON.stringify(value.slice(last, match.index)));
    else if (!parts.length && match[0] !== value) parts.push('""');
    // A value that is one expression needs no grouping: it is the whole
    // dynamic value.
    parts.push(match[0] === value ? match[1].trim() : concatenationPart(match[1].trim()));
    last = match.index + match[0].length;
  }
  if (last < value.length) parts.push(JSON.stringify(value.slice(last)));
  return parts.join(' + ');
}

function rejectQuotedInterpolation(attribute, node) {
  const { name, value } = attribute;
  if (typeof value !== 'string' || name.startsWith('on:') || !value.includes('{')) return;

  const match = [...value.matchAll(QUOTED_BRACES)].find((candidate) => isExpression(candidate[1]));
  if (!match) return;
  const at = node.loc?.start ? ` at ${node.loc.start.line}:${node.loc.start.column}` : '';
  throw compilerDiagnostic(
    CODES.parser.quotedAttributeInterpolation,
    `Attribute '${name}' on <${node.name}>${at} is quoted, so '${match[0]}' would render literally. Quoted attribute values are static; use a dynamic value such as ${name}={${concatenation(value)}}.`
  );
}

/**
 * Recursively walks the Template AST and parses the raw strings inside 'Expression' nodes.
 * @param {Object} node - The current AST node being evaluated
 * @returns {Object} The mutated AST node
 */
function integrateExpressions(node) {
  // 1. Base Case: If the node is an Expression, parse it
  if (node.type === 'Expression') {
    try {
      // Pass the raw string to your new lexer and parser
      const tokens = lexExpression(node.value);
      const parsedAST = parseExpression(tokens);
      
      // Attach the parsed mini-AST to the node, preserving the original template location
      node.expressionAST = parsedAST;
      
    } catch (error) {
      const templateLocation = node.loc?.start;
      const expressionLocation = error.message.match(/ at (\d+):(\d+)\.?$/);
      const expressionLine = Number(expressionLocation?.[1]);
      const expressionColumn = Number(expressionLocation?.[2]);
      const line = templateLocation && expressionLocation
        ? templateLocation.line + expressionLine - 1
        : templateLocation?.line || 'unknown';
      const column = templateLocation && expressionLocation
        ? expressionLine === 1
          ? templateLocation.column + expressionColumn
          : expressionColumn
        : templateLocation?.column || 'unknown';
      const message = expressionLocation
        ? error.message.replace(/ at \d+:\d+\.?$/, '')
        : error.message;

      throw compilerDiagnostic(CODES.parser.templateExpressionError, `Template Expression Error at ${line}:${column} - ${message}`);
    }
  }

  if (node.type === 'Element') {
    for (const attribute of node.attributes || []) {
      if (!attribute.dynamic) {
        rejectQuotedInterpolation(attribute, node);
        continue;
      }
      try {
        attribute.expressionAST = parseExpression(lexExpression(attribute.value));
      } catch (error) {
        throw compilerDiagnostic(CODES.parser.dynamicAttributeMissingExpression, `Dynamic attribute '${attribute.name}' must contain a supported expression${reason(error)}`);
      }
    }
  }

  if (node.type === 'IfBlock') {
    try {
      node.testAST = parseExpression(lexExpression(node.test));
    } catch (error) {
      throw compilerDiagnostic(CODES.parser.conditionalExpressionMissing, `Conditional expression must contain a supported expression${reason(error)}`);
    }
    node.consequent.forEach(integrateExpressions);
    node.alternate?.forEach(integrateExpressions);
    return node;
  }

  if (node.type === 'EachBlock') {
    node.children.forEach(integrateExpressions);
    return node;
  }

  // 2. Recursive Step: If the node has children, walk through all of them
  if (node.children && Array.isArray(node.children)) {
    for (let i = 0; i < node.children.length; i++) {
      integrateExpressions(node.children[i]);
    }
  }

  // We mutate in place for performance, but return the node for easy chaining
  return node; 
}

module.exports = { integrateExpressions };
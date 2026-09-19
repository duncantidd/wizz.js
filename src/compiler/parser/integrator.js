const { lexExpression } = require('./expressionLexer.js');
const { parseExpression } = require('./prattParser.js');
const { CODES, compilerDiagnostic } = require('../diagnostics.js');

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
      if (!attribute.dynamic) continue;
      try {
        attribute.expressionAST = parseExpression(lexExpression(attribute.value));
      } catch (error) {
        throw compilerDiagnostic(CODES.parser.dynamicAttributeMissingExpression, `Dynamic attribute '${attribute.name}' must contain a supported expression.`);
      }
    }
  }

  if (node.type === 'IfBlock') {
    try {
      node.testAST = parseExpression(lexExpression(node.test));
    } catch {
      throw compilerDiagnostic(CODES.parser.conditionalExpressionMissing, 'Conditional expression must contain a supported expression.');
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
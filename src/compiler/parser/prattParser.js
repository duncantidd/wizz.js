const { CODES, compilerDiagnostic } = require('../diagnostics.js');

const PRECEDENCE = {
  'EOF': 0,
  '===': 5,
  '+': 10,
  '-': 10,
  '*': 20,
  '/': 20,
  '.': 30
};

// A recursion budget for the parser: every nested parenthesized
// sub-expression costs one JS stack frame, and an input of thousands of
// unbalanced '(' would otherwise exhaust the stack with a RangeError whose
// only location is a parser-internal frame. Real expressions nest a
// handful deep; 128 is far beyond authoring need and bounds the worst case
// to a located diagnostic (WIZZ-P053) instead of a stack overflow — the
// parse stage runs on untrusted component source (agent tooling, editor
// integrations), so a crash-shaped failure is a resource hazard, not just
// an ugly error.
const MAX_EXPRESSION_DEPTH = 128;

function parseExpression(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    throw new TypeError('Expression tokens must be a non-empty array.');
  }

  let current = 0;

  const peek = () => tokens[current];
  const advance = () => tokens[current++];
  const getPrecedence = (token) => PRECEDENCE[token?.type] || 0;
  const location = (token) => {
    const { line, column } = token?.loc?.start || {};
    return line === undefined ? '' : ` at ${line}:${column}`;
  };

  const prefixParselets = {
    'Identifier': (token) => ({ type: 'Identifier', name: token.value }),
    'Number': (token) => ({ type: 'Literal', value: token.value }),
    'String': (token) => ({ type: 'Literal', value: token.value }),
    '(': (token, depth) => {
      const expr = parse(0, depth);
      const closingToken = advance();
      if (closingToken?.type !== ')') {
        throw compilerDiagnostic(CODES.parser.expectedClosingParen, `Expected closing ')'${location(closingToken)}`);
      }
      return expr;
    }
  };

  const infixParselets = {
    '===': (left, token, depth) => ({ type: 'BinaryExpression', operator: '===', left, right: parse(PRECEDENCE['==='], depth) }),
    '+': (left, token, depth) => ({ type: 'BinaryExpression', operator: '+', left, right: parse(PRECEDENCE['+'], depth) }),
    '-': (left, token, depth) => ({ type: 'BinaryExpression', operator: '-', left, right: parse(PRECEDENCE['-'], depth) }),
    '*': (left, token, depth) => ({ type: 'BinaryExpression', operator: '*', left, right: parse(PRECEDENCE['*'], depth) }),
    '/': (left, token, depth) => ({ type: 'BinaryExpression', operator: '/', left, right: parse(PRECEDENCE['/'], depth) }),
    '.': (left, token, depth) => {
      const rightToken = advance();
      if (rightToken?.type !== 'Identifier') {
        throw compilerDiagnostic(CODES.parser.expectedPropertyAfterDot, `Expected property name after '.'${location(rightToken)}`);
      }
      return { type: 'MemberExpression', object: left, property: { type: 'Identifier', name: rightToken.value } };
    }
  };

  function parse(precedence, depth) {
    // The guard fires before the recursion the depth counts, so the limit
    // is the deepest parenthesized nesting the parser will attempt.
    if (depth > MAX_EXPRESSION_DEPTH) {
      const token = peek();
      throw compilerDiagnostic(CODES.parser.expressionDepthExceeded, `Expression nesting exceeds the maximum depth of ${MAX_EXPRESSION_DEPTH}${location(token)}`);
    }
    let token = advance();
    const prefixFunction = prefixParselets[token.type];

    if (!prefixFunction) {
      throw compilerDiagnostic(CODES.parser.unparseableStartingToken, `Cannot parse starting token: ${token.type}${location(token)}`);
    }

    let left = prefixFunction(token, depth + 1);

    while (precedence < getPrecedence(peek())) {
      token = advance();
      const infixFunction = infixParselets[token.type];
      left = infixFunction(left, token, depth + 1);
    }

    return left;
  }

  const expression = parse(0, 1);
  const nextToken = peek();
  if (nextToken?.type !== 'EOF') {
    throw compilerDiagnostic(CODES.parser.unexpectedExpressionToken, `Unexpected token ${nextToken?.type || 'end of input'}${location(nextToken)}`);
  }
  return expression;
}

module.exports = { parseExpression, PRECEDENCE };
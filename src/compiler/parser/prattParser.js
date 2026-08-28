const PRECEDENCE = {
  'EOF': 0,
  '===': 5,
  '+': 10,
  '-': 10,
  '*': 20,
  '/': 20,
  '.': 30
};

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
    '(': () => {
      const expr = parse(0);
      const closingToken = advance();
      if (closingToken?.type !== ')') {
        throw new SyntaxError(`Expected closing ')'${location(closingToken)}`);
      }
      return expr;
    }
  };

  const infixParselets = {
    '===': (left) => ({ type: 'BinaryExpression', operator: '===', left, right: parse(PRECEDENCE['===']) }),
    '+': (left, token) => ({ type: 'BinaryExpression', operator: '+', left, right: parse(PRECEDENCE['+']) }),
    '-': (left, token) => ({ type: 'BinaryExpression', operator: '-', left, right: parse(PRECEDENCE['-']) }),
    '*': (left, token) => ({ type: 'BinaryExpression', operator: '*', left, right: parse(PRECEDENCE['*']) }),
    '/': (left, token) => ({ type: 'BinaryExpression', operator: '/', left, right: parse(PRECEDENCE['/']) }),
    '.': (left, token) => {
      const rightToken = advance();
      if (rightToken?.type !== 'Identifier') {
        throw new SyntaxError(`Expected property name after '.'${location(rightToken)}`);
      }
      return { type: 'MemberExpression', object: left, property: { type: 'Identifier', name: rightToken.value } };
    }
  };

  function parse(precedence) {
    let token = advance();
    const prefixFunction = prefixParselets[token.type];

    if (!prefixFunction) {
      throw new SyntaxError(`Cannot parse starting token: ${token.type}${location(token)}`);
    }

    let left = prefixFunction(token);

    while (precedence < getPrecedence(peek())) {
      token = advance();
      const infixFunction = infixParselets[token.type];
      left = infixFunction(left, token);
    }

    return left;
  }

  const expression = parse(0);
  const nextToken = peek();
  if (nextToken?.type !== 'EOF') {
    throw new SyntaxError(`Unexpected token ${nextToken?.type || 'end of input'}${location(nextToken)}`);
  }
  return expression;
}

module.exports = { parseExpression, PRECEDENCE };
const { CODES, compilerDiagnostic } = require('../diagnostics.js');

// Binding powers mirror JavaScript's operator precedence for the subset the
// grammar accepts. The generators emit an expression's raw source verbatim,
// so the AST built here must group operands exactly as JavaScript will when
// that source runs: a disagreement would not change what renders, but it
// would make every AST consumer (dependency analysis today) reason about a
// different expression than the one that executes.
const PRECEDENCE = {
  'EOF': 0,
  '?': 1,
  '||': 2,
  '&&': 3,
  '===': 5,
  '!==': 5,
  '<': 7,
  '>': 7,
  '<=': 7,
  '>=': 7,
  '+': 10,
  '-': 10,
  '*': 20,
  '/': 20,
  // Prefix `!` and `-` bind tighter than every binary operator and looser
  // than member access and calls: `-a.b` is `-(a.b)`, `!f(x)` is `!(f(x))`.
  'unary': 25,
  '.': 30,
  '(': 30
};

// A recursion budget for the parser: every nested parenthesized
// sub-expression costs one JS stack frame, and an input of thousands of
// unbalanced '(' would otherwise exhaust the stack with a RangeError whose
// only location is a parser-internal frame. Real expressions nest a
// handful deep; 128 is far beyond authoring need and bounds the worst case
// to a located diagnostic (WIZZ-P053) instead of a stack overflow — the
// parse stage runs on untrusted component source (agent tooling, editor
// integrations), so a crash-shaped failure is a resource hazard, not just
// an ugly error. Prefix operators, ternary branches, and call arguments
// recurse too, so they draw on the same budget.
const MAX_EXPRESSION_DEPTH = 128;

// Names that turn a string into running code (`eval`, `Function`, the
// string forms of the timers) or reach one (`x.constructor.constructor`
// is `Function`). Template expressions are author code that shares the
// script's trust, so this is defense in depth rather than a sandbox: it
// keeps code-from-string sinks out of generated modules (CLAUDE.md §8)
// without claiming more. It applies only to expressions that contain a
// call — the only form that can invoke such a sink — so every expression
// that compiled before calls existed keeps compiling.
const UNSAFE_NAMES = new Set(['eval', 'Function', 'constructor', '__proto__', 'setTimeout', 'setInterval']);

const LITERAL_KEYWORDS = { true: true, false: false, null: null };

// Strict-mode reserved words cannot be bindings in the ES module the
// expression is spliced into, so a bare `{delete}` never loaded. With calls
// in the grammar some become worse than a load failure — `new(x)` constructs,
// `delete(a.b)` mutates, `import(url)` loads code — so they are rejected
// wherever an identifier would be read. Property names (`a.delete`,
// `list.new`) are ordinary JavaScript and stay accepted. `this` stays an
// identifier because it always was one.
const RESERVED_WORDS = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'finally',
  'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'return',
  'super', 'switch', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with',
  'yield', 'let', 'static', 'implements', 'interface', 'package', 'private',
  'protected', 'public'
]);

const BINARY_OPERATORS = ['===', '!==', '<', '>', '<=', '>=', '+', '-', '*', '/'];

function parseExpression(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    throw new TypeError('Expression tokens must be a non-empty array.');
  }

  let current = 0;
  let hasCall = false;

  const peek = () => tokens[current];
  const advance = () => tokens[current++];
  const getPrecedence = (token) => PRECEDENCE[token?.type] || 0;
  const location = (token) => {
    const { line, column } = token?.loc?.start || {};
    return line === undefined ? '' : ` at ${line}:${column}`;
  };
  const expect = (type, code, message) => {
    const token = advance();
    if (token?.type !== type) throw compilerDiagnostic(code, `${message}${location(token)}`);
    return token;
  };

  const unary = (operator) => (token, depth) => ({
    type: 'UnaryExpression',
    operator,
    argument: parse(PRECEDENCE.unary, depth)
  });

  const prefixParselets = {
    // `true`, `false`, and `null` are literals in JavaScript, not bindings;
    // modelling them as Literal keeps them out of identifier-based analysis.
    'Identifier': (token) => {
      if (Object.prototype.hasOwnProperty.call(LITERAL_KEYWORDS, token.value)) {
        return { type: 'Literal', value: LITERAL_KEYWORDS[token.value] };
      }
      if (RESERVED_WORDS.has(token.value)) {
        throw compilerDiagnostic(CODES.parser.reservedWordInExpression, `'${token.value}' is a reserved word and cannot be used in a template expression${location(token)}`);
      }
      return { type: 'Identifier', name: token.value };
    },
    'Number': (token) => ({ type: 'Literal', value: token.value }),
    'String': (token) => ({ type: 'Literal', value: token.value }),
    '!': unary('!'),
    '-': unary('-'),
    '(': (token, depth) => {
      const expr = parse(0, depth);
      expect(')', CODES.parser.expectedClosingParen, "Expected closing ')'");
      return expr;
    }
  };

  const binary = (operator) => (left, token, depth) => ({
    type: 'BinaryExpression', operator, left, right: parse(PRECEDENCE[operator], depth)
  });
  const logical = (operator) => (left, token, depth) => ({
    type: 'LogicalExpression', operator, left, right: parse(PRECEDENCE[operator], depth)
  });

  const infixParselets = {
    ...Object.fromEntries(BINARY_OPERATORS.map((operator) => [operator, binary(operator)])),
    '&&': logical('&&'),
    '||': logical('||'),
    '?': (test, token, depth) => {
      // JavaScript accepts any assignment expression in both branches and
      // groups conditionals to the right: `a ? b : c ? d : e` is
      // `a ? b : (c ? d : e)`. Parsing each branch at the lowest binding
      // power gives exactly that.
      const consequent = parse(0, depth);
      expect(':', CODES.parser.expectedConditionalColon, "Expected ':' in conditional expression");
      const alternate = parse(0, depth);
      return { type: 'ConditionalExpression', test, consequent, alternate };
    },
    '.': (left) => {
      const rightToken = advance();
      if (rightToken?.type !== 'Identifier') {
        throw compilerDiagnostic(CODES.parser.expectedPropertyAfterDot, `Expected property name after '.'${location(rightToken)}`);
      }
      return { type: 'MemberExpression', object: left, property: { type: 'Identifier', name: rightToken.value } };
    },
    '(': (callee, token, depth) => {
      // "Simple calls" (issue #69): a named function or a method. Calling
      // the result of a call or of a literal (`f()()`, `'a'()`) is outside
      // the grammar.
      if (callee.type !== 'Identifier' && callee.type !== 'MemberExpression') {
        throw compilerDiagnostic(CODES.parser.unsupportedCallee, `Only a function name or a method can be called${location(token)}`);
      }
      hasCall = true;
      const args = [];
      if (peek()?.type !== ')') {
        for (;;) {
          args.push(parse(0, depth));
          if (peek()?.type !== ',') break;
          advance();
        }
      }
      expect(')', CODES.parser.expectedClosingParen, "Expected closing ')' after call arguments");
      return { type: 'CallExpression', callee, arguments: args };
    }
  };

  function parse(precedence, depth) {
    // The guard fires before the recursion the depth counts, so the limit
    // is the deepest nesting the parser will attempt.
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
  if (hasCall) rejectUnsafeNames(expression);
  return expression;
}

// Iterative so a long member or operator chain cannot exhaust the stack.
function rejectUnsafeNames(root) {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    let name = null;
    switch (node.type) {
      case 'Identifier': name = node.name; break;
      case 'MemberExpression': name = node.property.name; stack.push(node.object); break;
      case 'UnaryExpression': stack.push(node.argument); break;
      case 'BinaryExpression':
      case 'LogicalExpression': stack.push(node.left, node.right); break;
      case 'ConditionalExpression': stack.push(node.test, node.consequent, node.alternate); break;
      case 'CallExpression':
        // Pushed one at a time: spreading a very wide argument list into
        // push() would itself exhaust the stack.
        stack.push(node.callee);
        for (const argument of node.arguments) stack.push(argument);
        break;
      default: break;
    }
    if (name !== null && UNSAFE_NAMES.has(name)) {
      throw compilerDiagnostic(CODES.parser.unsafeExpressionReference, `'${name}' cannot be used in a template expression that calls a function: it can run code built from a string. Call it from a script function instead.`);
    }
  }
}

module.exports = { parseExpression, PRECEDENCE, MAX_EXPRESSION_DEPTH };

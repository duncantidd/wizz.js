const { CODES, compilerDiagnostic } = require('../diagnostics.js');

// The generators splice an expression's raw source into generated JavaScript
// verbatim; the lexer and parser are the gate that decides which source may
// get there. Every token boundary drawn here must therefore be the boundary
// JavaScript itself draws, or the dependency analysis and the emitted code
// would disagree about what the expression means.

// Multi-character operators, longest first so `!==` wins over `!` and `<=`
// over `<`.
const OPERATORS = ['===', '!==', '<=', '>=', '&&', '||', '+', '-', '*', '/', '.', '(', ')', '!', '<', '>', '?', ':', ','];

// Simple escapes are cooked into the String token's value; every other
// escaped character stands for itself. The raw source (what is emitted) is
// untouched either way — the cooked value only feeds the AST.
const ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };

const isLineTerminator = (char) => char === '\n' || char === '\r' || char === ' ' || char === ' ';

function lexExpression(input) {
  if (typeof input !== 'string') {
    throw new TypeError('Expression input must be a string.');
  }

  const tokens = [];
  let current = 0;
  let line = 1;
  let column = 1;

  const position = () => ({ offset: current, line, column });
  const advance = () => {
    const char = input[current++];
    if (char === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  };
  const emit = (type, value, start) => {
    tokens.push({ type, value, loc: { start, end: position() } });
  };
  const isDigit = (char) => char >= '0' && char <= '9';

  while (current < input.length) {
    const char = input[current];

    if (/\s/.test(char)) {
      advance();
      continue;
    }

    if (/[a-zA-Z_]/.test(char)) {
      const start = position();
      let value = '';
      while (current < input.length && /[a-zA-Z0-9_]/.test(input[current])) {
        value += input[current];
        advance();
      }
      emit('Identifier', value, start);
      continue;
    }

    if (isDigit(char)) {
      const start = position();
      let value = '';
      while (current < input.length && isDigit(input[current])) {
        value += input[current];
        advance();
      }
      // Strict-mode modules reject legacy octal (`01`) and leading-zero
      // decimals (`08`), so the generated module would fail to load.
      if (value.length > 1 && value[0] === '0') {
        throw compilerDiagnostic(CODES.parser.invalidExpressionLiteral, `Number '${value}' has a leading zero at ${start.line}:${start.column}.`);
      }
      if (input[current] === '.') {
        // `1.5` is a decimal. `1.foo` is not: JavaScript reads `1.` as the
        // number and then fails on `foo`, so member access on a bare
        // integer would compile here and break the generated module.
        if (!isDigit(input[current + 1])) {
          throw compilerDiagnostic(CODES.parser.invalidExpressionLiteral, `Number '${value}' must be followed by digits after '.'; wrap it in parentheses to access a property at ${start.line}:${start.column}.`);
        }
        value += '.';
        advance();
        while (current < input.length && isDigit(input[current])) {
          value += input[current];
          advance();
        }
      }
      emit('Number', Number(value), start);
      continue;
    }

    if (char === '"' || char === "'") {
      const start = position();
      const quote = char;
      let value = '';
      advance();
      while (current < input.length && input[current] !== quote) {
        // A raw line terminator ends a JavaScript string literal with a
        // SyntaxError; only escaped ones (or U+2028/9) are legal.
        if (input[current] === '\n' || input[current] === '\r') {
          throw compilerDiagnostic(CODES.parser.unclosedExpressionString, `Unclosed string at ${line}:${column}.`);
        }
        if (input[current] === '\\') {
          advance();
          if (current >= input.length) break;
          const escaped = input[current];
          if (isLineTerminator(escaped)) {
            // A line continuation contributes nothing; an escaped CRLF is
            // one continuation.
            if (escaped === '\r' && input[current + 1] === '\n') advance();
          } else if (escaped === 'x' || escaped === 'u') {
            // Hex and unicode escapes are cooked exactly as JavaScript cooks
            // them; a malformed one is a SyntaxError when the generated
            // module loads, so it is rejected here instead.
            const rest = input.slice(current + 1);
            const match = escaped === 'x'
              ? rest.match(/^[0-9a-fA-F]{2}/)
              : rest.match(/^(?:[0-9a-fA-F]{4}|\{([0-9a-fA-F]{1,6})\})/);
            const codePoint = match ? parseInt(match[1] ?? match[0], 16) : NaN;
            if (!match || codePoint > 0x10ffff) {
              throw compilerDiagnostic(CODES.parser.invalidExpressionLiteral, `Invalid '\\${escaped}' escape in string at ${line}:${column}.`);
            }
            value += String.fromCodePoint(codePoint);
            for (let i = 0; i < match[0].length; i += 1) advance();
          } else if (isDigit(escaped) && !(escaped === '0' && !isDigit(input[current + 1]))) {
            // Octal escapes (and `\8`, `\9`) are SyntaxErrors in the strict
            // mode every generated module runs in.
            throw compilerDiagnostic(CODES.parser.invalidExpressionLiteral, `Octal escape '\\${escaped}' is not allowed in strict mode at ${line}:${column}.`);
          } else {
            value += Object.prototype.hasOwnProperty.call(ESCAPES, escaped) ? ESCAPES[escaped] : escaped;
          }
          advance();
          continue;
        }
        value += input[current];
        advance();
      }
      if (input[current] !== quote) throw compilerDiagnostic(CODES.parser.unclosedExpressionString, `Unclosed string at ${line}:${column}.`);
      advance();
      emit('String', value, start);
      continue;
    }

    // `++`/`--` are JavaScript update operators. Lexing them as two signs
    // would let `--count` pass as a double negation here and then mutate
    // state (or fail to load) once spliced into the generated module.
    if ((char === '+' || char === '-') && input[current + 1] === char) {
      throw compilerDiagnostic(CODES.parser.expressionUpdateOperator, `Update operator '${char}${char}' is not supported in template expressions; separate the signs with a space if you meant two operators at ${line}:${column}.`);
    }

    // Loose equality is deliberately absent: name the supported form.
    if ((char === '=' || char === '!') && input[current + 1] === '=' && input[current + 2] !== '=') {
      const strict = char === '=' ? '===' : '!==';
      throw compilerDiagnostic(CODES.parser.unexpectedExpressionCharacter, `Loose comparison '${char}=' is not supported; use '${strict}' at ${line}:${column}.`);
    }

    const operator = OPERATORS.find((candidate) => input.startsWith(candidate, current));
    if (operator) {
      const start = position();
      for (let i = 0; i < operator.length; i += 1) advance();
      emit(operator, operator, start);
      continue;
    }

    throw compilerDiagnostic(CODES.parser.unexpectedExpressionCharacter, `Unexpected character '${char}' at ${line}:${column}.`);
  }

  emit('EOF', undefined, position());
  return tokens;
}

module.exports = { lexExpression };

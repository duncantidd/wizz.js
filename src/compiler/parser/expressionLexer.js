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

    if (/[0-9]/.test(char)) {
      const start = position();
      let value = '';
      while (current < input.length && /[0-9]/.test(input[current])) {
        value += input[current];
        advance();
      }
      emit('Number', Number(value), start);
      continue;
    }

    if (['+', '-', '*', '/', '.', '(', ')'].includes(char)) {
      const start = position();
      advance();
      emit(char, char, start);
      continue;
    }

    throw new SyntaxError(`Unexpected character '${char}' at ${line}:${column}.`);
  }

  emit('EOF', undefined, position());
  return tokens;
}

module.exports = { lexExpression };
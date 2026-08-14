const STATES = {
  TEXT: 'TEXT',
  TAG_OPEN: 'TAG_OPEN',
  TAG_NAME: 'TAG_NAME',
  BEFORE_ATTRIBUTE_NAME: 'BEFORE_ATTRIBUTE_NAME',
  ATTRIBUTE_NAME: 'ATTRIBUTE_NAME',
  BEFORE_ATTRIBUTE_VALUE: 'BEFORE_ATTRIBUTE_VALUE',
  ATTRIBUTE_VALUE: 'ATTRIBUTE_VALUE',
  ATTRIBUTE_EXPRESSION: 'ATTRIBUTE_EXPRESSION',
  AFTER_ATTRIBUTE_VALUE: 'AFTER_ATTRIBUTE_VALUE',
  SELF_CLOSING_START_TAG: 'SELF_CLOSING_START_TAG',
  TAG_CLOSE: 'TAG_CLOSE',
  EXPRESSION: 'EXPRESSION',
  EXPRESSION_STRING: 'EXPRESSION_STRING',
  EXPRESSION_ESCAPE: 'EXPRESSION_ESCAPE',
  SCRIPT: 'SCRIPT'
};

const isWhitespace = (char) => /\s/.test(char);
const isNameStart = (char) => /[A-Za-z]/.test(char);
const isNameCharacter = (char) => /[A-Za-z0-9:_-]/.test(char);

function tokenize(input) {
  if (typeof input !== 'string') throw new TypeError('Tokenizer input must be a string.');

  let current = 0;
  let line = 1;
  let column = 1;
  let state = STATES.TEXT;
  let buffer = '';
  let textStart = 0;
  let textLocation = null;
  let tokenStart = 0;
  let tagName = '';
  let attributes = [];
  let attributeName = '';
  let attributeValue = null;
  let quote = null;
  let expressionDepth = 0;
  let tagLocation = null;
  const tokens = [];

  const position = () => ({ offset: current, line, column });
  const advance = (char) => {
    current += 1;
    if (char === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  };
  const fail = (message) => {
    const { line: errorLine, column: errorColumn } = position();
    throw new SyntaxError(`${message} at ${errorLine}:${errorColumn}.`);
  };
  const emit = ({ location, ...token }) => {
    tokens.push({
      ...token,
      start: tokenStart,
      end: current,
      loc: { start: location, end: position() }
    });
  };
  const emitText = () => {
    if (!buffer) return;
    const length = buffer.length;
    tokenStart = textStart;
    emit({
      type: 'Text',
      value: buffer,
      location: textLocation
    });
    buffer = '';
  };
  const emitTag = (type) => {
    emit({
      type,
      name: tagName,
      ...(type !== 'CloseTag' && { attributes }),
      location: tagLocation
    });
  };
  const commitAttribute = () => {
    attributes.push({ name: attributeName, value: attributeValue });
    attributeName = '';
    attributeValue = null;
  };

  while (current < input.length) {
    const char = input[current];

    switch (state) {
      case STATES.TEXT:
        if (char === '<') {
          emitText();
          tokenStart = current;
          tagLocation = position();
          tagName = '';
          attributes = [];
          state = STATES.TAG_OPEN;
        } else if (char === '{') {
          emitText();
          tokenStart = current;
          tagLocation = position();
          buffer = '';
          expressionDepth = 1;
          state = STATES.EXPRESSION;
        } else {
          if (!buffer) {
            textStart = current;
            textLocation = position();
          }
          buffer += char;
        }
        break;

      case STATES.TAG_OPEN:
        if (char === '/') state = STATES.TAG_CLOSE;
        else if (isNameStart(char)) {
          tagName += char;
          state = STATES.TAG_NAME;
        } else fail(`Expected a tag name after '<', found '${char}'`);
        break;

      case STATES.TAG_NAME:
        if (isNameCharacter(char)) tagName += char;
        else if (isWhitespace(char)) state = STATES.BEFORE_ATTRIBUTE_NAME;
        else if (char === '>') {
          advance(char);
          emitTag('OpenTag');
          textStart = current;
          state = tagName === 'script' ? STATES.SCRIPT : STATES.TEXT;
          continue;
        } else if (char === '/') state = STATES.SELF_CLOSING_START_TAG;
        else fail(`Unexpected '${char}' in tag name`);
        break;

      case STATES.BEFORE_ATTRIBUTE_NAME:
        if (isWhitespace(char)) break;
        if (char === '>') {
          advance(char);
          emitTag('OpenTag');
          textStart = current;
          state = tagName === 'script' ? STATES.SCRIPT : STATES.TEXT;
          continue;
        }
        if (char === '/') state = STATES.SELF_CLOSING_START_TAG;
        else if (isNameStart(char)) {
          attributeName = char;
          state = STATES.ATTRIBUTE_NAME;
        } else fail(`Expected an attribute name, found '${char}'`);
        break;

      case STATES.ATTRIBUTE_NAME:
        if (isNameCharacter(char)) attributeName += char;
        else if (char === '=') state = STATES.BEFORE_ATTRIBUTE_VALUE;
        else if (isWhitespace(char)) {
          commitAttribute();
          state = STATES.BEFORE_ATTRIBUTE_NAME;
        } else if (char === '>') {
          commitAttribute();
          advance(char);
          emitTag('OpenTag');
          textStart = current;
          state = STATES.TEXT;
          continue;
        } else if (char === '/') {
          commitAttribute();
          state = STATES.SELF_CLOSING_START_TAG;
        } else fail(`Unexpected '${char}' in attribute name`);
        break;

      case STATES.BEFORE_ATTRIBUTE_VALUE:
        if (isWhitespace(char)) break;
        if (char === '{') {
          attributeValue = '';
          expressionDepth = 1;
          state = STATES.ATTRIBUTE_EXPRESSION;
        } else if (char === '"' || char === "'") {
          quote = char;
          attributeValue = '';
          state = STATES.ATTRIBUTE_VALUE;
        } else fail(`Expected a quoted or brace-delimited value for attribute '${attributeName}'`);
        break;

      case STATES.ATTRIBUTE_VALUE:
        if (char === quote) {
          commitAttribute();
          state = STATES.AFTER_ATTRIBUTE_VALUE;
        } else attributeValue += char;
        break;

      case STATES.ATTRIBUTE_EXPRESSION:
        if (char === '{') {
          expressionDepth += 1;
          attributeValue += char;
        } else if (char === '}') {
          expressionDepth -= 1;
          if (expressionDepth === 0) {
            commitAttribute();
            state = STATES.AFTER_ATTRIBUTE_VALUE;
          } else {
            attributeValue += char;
          }
        } else {
          attributeValue += char;
        }
        break;

      case STATES.AFTER_ATTRIBUTE_VALUE:
        if (isWhitespace(char)) state = STATES.BEFORE_ATTRIBUTE_NAME;
        else if (char === '>') {
          advance(char);
          emitTag('OpenTag');
          textStart = current;
          state = tagName === 'script' ? STATES.SCRIPT : STATES.TEXT;
          continue;
        } else if (char === '/') state = STATES.SELF_CLOSING_START_TAG;
        else fail(`Expected whitespace or '>' after attribute value, found '${char}'`);
        break;

      case STATES.SELF_CLOSING_START_TAG:
        if (char !== '>') fail(`Expected '>' after '/', found '${char}'`);
        advance(char);
        emitTag('SelfClosingTag');
        textStart = current;
        state = STATES.TEXT;
        continue;

      case STATES.TAG_CLOSE:
        if (isNameCharacter(char)) tagName += char;
        else if (char === '>') {
          if (!tagName) fail('Expected a closing tag name');
          advance(char);
          emitTag('CloseTag');
          textStart = current;
          state = STATES.TEXT;
          continue;
        } else fail(`Unexpected '${char}' in closing tag name`);
        break;

      case STATES.EXPRESSION:
        if (char === '"' || char === "'") {
          quote = char;
          buffer += char;
          state = STATES.EXPRESSION_STRING;
        } else if (char === '{') {
          expressionDepth += 1;
          buffer += char;
        } else if (char === '}') {
          expressionDepth -= 1;
          if (expressionDepth === 0) {
            advance(char);
            emit({ type: 'Expression', value: buffer, location: tagLocation });
            textStart = current;
            buffer = '';
            state = STATES.TEXT;
            continue;
          }
          buffer += char;
        } else buffer += char;
        break;

      case STATES.EXPRESSION_STRING:
        buffer += char;
        if (char === '\\') state = STATES.EXPRESSION_ESCAPE;
        else if (char === quote) state = STATES.EXPRESSION;
        break;

      case STATES.EXPRESSION_ESCAPE:
        buffer += char;
        state = STATES.EXPRESSION_STRING;
        break;

      case STATES.SCRIPT:
        if (input.startsWith('</script>', current)) {
          emitText();
          tokenStart = current;
          tagLocation = position();
          tagName = '';
          attributes = [];
          state = STATES.TAG_OPEN;
        } else {
          if (!buffer) {
            textStart = current;
            textLocation = position();
          }
          buffer += char;
        }
        break;
    }

    advance(char);
  }

  if (state !== STATES.TEXT) {
    fail(`Unclosed ${state.startsWith('EXPRESSION') ? 'expression' : 'tag'}`);
  }
  emitText();
  return tokens;
}

module.exports = { STATES, tokenize };
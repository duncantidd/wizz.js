const assert = require('node:assert/strict');
const test = require('node:test');
const { lexExpression } = require('./expressionLexer');
const { parseExpression } = require('./prattParser');

test('lexes expression tokens with source locations', () => {
  const tokens = lexExpression('sum +\n42');

  assert.deepEqual(tokens, [
    {
      type: 'Identifier',
      value: 'sum',
      loc: {
        start: { offset: 0, line: 1, column: 1 },
        end: { offset: 3, line: 1, column: 4 }
      }
    },
    {
      type: '+',
      value: '+',
      loc: {
        start: { offset: 4, line: 1, column: 5 },
        end: { offset: 5, line: 1, column: 6 }
      }
    },
    {
      type: 'Number',
      value: 42,
      loc: {
        start: { offset: 6, line: 2, column: 1 },
        end: { offset: 8, line: 2, column: 3 }
      }
    },
    {
      type: 'EOF',
      value: undefined,
      loc: {
        start: { offset: 8, line: 2, column: 3 },
        end: { offset: 8, line: 2, column: 3 }
      }
    }
  ]);
  assert.throws(() => lexExpression('name + $'), /Unexpected character '\$' at 1:8\./);
});

test('parses member access and operator precedence', () => {
  assert.deepEqual(parseExpression(lexExpression('user.name + 1 * 2')), {
    type: 'BinaryExpression',
    operator: '+',
    left: {
      type: 'MemberExpression',
      object: { type: 'Identifier', name: 'user' },
      property: { type: 'Identifier', name: 'name' }
    },
    right: {
      type: 'BinaryExpression',
      operator: '*',
      left: { type: 'Literal', value: 1 },
      right: { type: 'Literal', value: 2 }
    }
  });
  assert.deepEqual(parseExpression(lexExpression('(1 + 2) * 3')), {
    type: 'BinaryExpression',
    operator: '*',
    left: {
      type: 'BinaryExpression',
      operator: '+',
      left: { type: 'Literal', value: 1 },
      right: { type: 'Literal', value: 2 }
    },
    right: { type: 'Literal', value: 3 }
  });
});

test('rejects incomplete and trailing expression tokens', () => {
  assert.throws(() => parseExpression(lexExpression('1 2')), /Unexpected token Number at 1:3/);
  assert.throws(() => parseExpression(lexExpression('1 +')), /Cannot parse starting token: EOF at 1:4/);
  assert.throws(() => parseExpression(lexExpression('user.')), /Expected property name after '\.' at 1:6/);
  assert.throws(() => parseExpression(lexExpression('(1 + 2')), /Expected closing '\)' at 1:7/);
});
test('bounds expression recursion with a located depth diagnostic', () => {
  // Just inside the budget: 127 nested groups parse cleanly.
  assert.doesNotThrow(() => parseExpression(lexExpression(`${'('.repeat(127)}1${')'.repeat(127)}`)));

  // One deeper exceeds the budget with the stable code, located at the
  // token the parser refused to descend past (128 '(' + the literal).
  let error;
  try {
    parseExpression(lexExpression(`${'('.repeat(128)}1${')'.repeat(128)}`));
  } catch (caught) {
    error = caught;
  }
  assert.match(error?.message || '', /Expression nesting exceeds the maximum depth of 128 at 1:129/);
  assert.equal(error.code, 'WIZZ-P053');

  // The crash-shaped form — a flood of unbalanced parens whose only
  // purpose is stack exhaustion — is a diagnostic, not a RangeError.
  let floodError;
  try {
    parseExpression(lexExpression('('.repeat(100000)));
  } catch (caught) {
    floodError = caught;
  }
  assert.match(floodError?.message || '', /Expression nesting exceeds the maximum depth of 128/);
  assert.equal(floodError.code, 'WIZZ-P053');
});

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

// --- Issue #69: conditionals, unary !/-, comparisons, logical operators,
// boolean/null literals, decimals, and simple calls ---

const parse = (source) => parseExpression(lexExpression(source));
const codeOf = (source) => {
  try {
    parse(source);
    return null;
  } catch (error) {
    return error.code;
  }
};

// A reference interpreter for the AST. Evaluating it and evaluating the raw
// source as JavaScript must agree: the generators emit the raw source, so any
// grouping difference between this parser and JavaScript shows up here.
function evaluate(node, scope) {
  switch (node.type) {
    case 'Literal': return node.value;
    case 'Identifier': return scope[node.name];
    case 'MemberExpression': return evaluate(node.object, scope)[node.property.name];
    case 'UnaryExpression': {
      const value = evaluate(node.argument, scope);
      return node.operator === '!' ? !value : -value;
    }
    case 'LogicalExpression': {
      const left = evaluate(node.left, scope);
      if (node.operator === '&&') return left && evaluate(node.right, scope);
      return left || evaluate(node.right, scope);
    }
    case 'ConditionalExpression':
      return evaluate(node.test, scope) ? evaluate(node.consequent, scope) : evaluate(node.alternate, scope);
    case 'CallExpression': {
      const args = node.arguments.map((argument) => evaluate(argument, scope));
      if (node.callee.type === 'MemberExpression') {
        const target = evaluate(node.callee.object, scope);
        return target[node.callee.property.name](...args);
      }
      return evaluate(node.callee, scope)(...args);
    }
    case 'BinaryExpression': {
      const left = evaluate(node.left, scope);
      const right = evaluate(node.right, scope);
      switch (node.operator) {
        case '+': return left + right;
        case '-': return left - right;
        case '*': return left * right;
        case '/': return left / right;
        case '===': return left === right;
        case '!==': return left !== right;
        case '<': return left < right;
        case '>': return left > right;
        case '<=': return left <= right;
        case '>=': return left >= right;
      }
    }
  }
  throw new Error(`unexpected node ${node.type}`);
}

const SCOPE = Object.freeze({
  a: 0, b: 1, c: 2, s: 'x', o: { n: 3, list: [1, 2] },
  f: (x, y) => `${x}|${y}`,
  twice: (x) => x * 2
});
// The raw source run as strict-mode JavaScript, as the generated module runs
// it. Test oracle only: generated code never uses new Function.
const runAsJs = (source) => new Function(...Object.keys(SCOPE), `'use strict'; return (${source});`)(...Object.values(SCOPE));
const same = (x, y) => Object.is(x, y) || (Number.isNaN(x) && Number.isNaN(y));

test('lexes the new operators longest-first, with locations', () => {
  const types = lexExpression('a !== b <= c >= d && !e || f ? g : h(i, j) < k > l').map((token) => token.type);
  assert.deepEqual(types, [
    'Identifier', '!==', 'Identifier', '<=', 'Identifier', '>=', 'Identifier', '&&', '!', 'Identifier',
    '||', 'Identifier', '?', 'Identifier', ':', 'Identifier', '(', 'Identifier', ',', 'Identifier', ')',
    '<', 'Identifier', '>', 'Identifier', 'EOF'
  ]);
  const [, strictNot] = lexExpression('a !== b');
  assert.deepEqual(strictNot.loc, { start: { offset: 2, line: 1, column: 3 }, end: { offset: 5, line: 1, column: 6 } });
});

test('parses conditionals right-associatively below every other operator', () => {
  assert.deepEqual(parse('a ? b : c ? d : e'), {
    type: 'ConditionalExpression',
    test: { type: 'Identifier', name: 'a' },
    consequent: { type: 'Identifier', name: 'b' },
    alternate: {
      type: 'ConditionalExpression',
      test: { type: 'Identifier', name: 'c' },
      consequent: { type: 'Identifier', name: 'd' },
      alternate: { type: 'Identifier', name: 'e' }
    }
  });
  // A conditional nested in the consequent needs no parentheses either.
  assert.equal(parse('a ? b ? 1 : 2 : 3').consequent.type, 'ConditionalExpression');
  // || binds tighter than ?:, && tighter than ||.
  const mixed = parse('a || b && c ? 1 : 2');
  assert.equal(mixed.test.operator, '||');
  assert.equal(mixed.test.right.operator, '&&');
});

test('unary operators bind tighter than binary ones and looser than member access and calls', () => {
  assert.deepEqual(parse('-a.b * 2'), {
    type: 'BinaryExpression',
    operator: '*',
    left: {
      type: 'UnaryExpression',
      operator: '-',
      argument: { type: 'MemberExpression', object: { type: 'Identifier', name: 'a' }, property: { type: 'Identifier', name: 'b' } }
    },
    right: { type: 'Literal', value: 2 }
  });
  assert.deepEqual(parse('!!f(x)'), {
    type: 'UnaryExpression',
    operator: '!',
    argument: {
      type: 'UnaryExpression',
      operator: '!',
      argument: { type: 'CallExpression', callee: { type: 'Identifier', name: 'f' }, arguments: [{ type: 'Identifier', name: 'x' }] }
    }
  });
  assert.equal(parse('a - -b').right.type, 'UnaryExpression');
  assert.equal(parse('- -a').argument.type, 'UnaryExpression');
});

test('true, false, and null are literals; other names stay identifiers', () => {
  assert.deepEqual(parse('true'), { type: 'Literal', value: true });
  assert.deepEqual(parse('false'), { type: 'Literal', value: false });
  assert.deepEqual(parse('null'), { type: 'Literal', value: null });
  assert.deepEqual(parse('undefined'), { type: 'Identifier', name: 'undefined' });
  assert.deepEqual(parse('truthy'), { type: 'Identifier', name: 'truthy' });
  assert.deepEqual(parse('this'), { type: 'Identifier', name: 'this' });
});

test('parses calls on names and methods, with zero or more arguments', () => {
  assert.deepEqual(parse('f()'), { type: 'CallExpression', callee: { type: 'Identifier', name: 'f' }, arguments: [] });
  const method = parse('user.name.toUpperCase().length');
  assert.equal(method.type, 'MemberExpression');
  assert.equal(method.object.type, 'CallExpression');
  assert.equal(method.object.callee.property.name, 'toUpperCase');
  const args = parse('f(a, b ? 1 : 2, g(c))');
  assert.equal(args.arguments.length, 3);
  assert.equal(args.arguments[1].type, 'ConditionalExpression');
  assert.equal(args.arguments[2].type, 'CallExpression');
  // A grouped name is still a name.
  assert.equal(parse('(f)(1)').callee.type, 'Identifier');
  // Reserved words are fine as property names.
  assert.equal(parse('list.delete(1)').callee.property.name, 'delete');
});

test('the issue #69 CalorieCraft values parse inline', () => {
  for (const source of [
    'list.length === 0 ? "No entries yet" : list.length === 1 ? "1 entry" : list.length + " entries"',
    'list.length === 0 ? "entries is-empty" : "entries"',
    'list.length === 0 ? "empty" : "empty is-hidden"',
    'total(list) > 2000 && !dismissed'
  ]) {
    assert.doesNotThrow(() => parse(source), source);
  }
});

test('lexes decimals and rejects number forms strict-mode modules cannot load', () => {
  assert.deepEqual(parse('1.5'), { type: 'Literal', value: 1.5 });
  assert.deepEqual(parse('0.25 * 4'), {
    type: 'BinaryExpression', operator: '*', left: { type: 'Literal', value: 0.25 }, right: { type: 'Literal', value: 4 }
  });
  assert.deepEqual(parse('0'), { type: 'Literal', value: 0 });
  assert.equal(parse('1.5.toFixed(1)').callee.object.value, 1.5);
  assert.equal(parse('(1).toString()').callee.object.value, 1);
  for (const source of ['01', '007', '08', '1.foo', '1.', '1..toString()']) {
    assert.equal(codeOf(source), 'WIZZ-P057', source);
  }
  assert.throws(() => lexExpression('a + 01'), /Number '01' has a leading zero at 1:5\./);
});

test('cooks string escapes and rejects ones that would not load', () => {
  assert.equal(parse(String.raw`'it\'s'`).value, "it's");
  assert.equal(parse(String.raw`"a\"b\\c"`).value, 'a"b\\c');
  assert.equal(parse(String.raw`'\n\t\0'`).value, '\n\t\0');
  assert.equal(parse(String.raw`'\x41\u0042\u{1F600}\q'`).value, 'AB\u{1F600}q');
  assert.equal(parse("'a\\\nb'").value, 'ab');
  assert.equal(parse("'a\\\r\nb'").value, 'ab');
  // U+2028 is legal inside a string literal since ES2019.
  assert.equal(parse("'a\u2028b'").value, 'a\u2028b');
  for (const source of [String.raw`'\1'`, String.raw`'\00'`, String.raw`'\8'`, String.raw`'\x4'`, String.raw`'\u12'`, String.raw`'\u{110000}'`, String.raw`'\u{}'`]) {
    assert.equal(codeOf(source), 'WIZZ-P057', source);
  }
  // A raw line break ends a JavaScript string with a SyntaxError.
  assert.equal(codeOf("'a\nb'"), 'WIZZ-P025');
  assert.equal(codeOf("'a\rb'"), 'WIZZ-P025');
  assert.equal(codeOf("'abc\\"), 'WIZZ-P025');
});

test('rejects update operators that JavaScript would read as mutation', () => {
  for (const source of ['--count', 'count--', '++count', 'a--b', 'a++b', 'a-- > b', 'x<!--y']) {
    assert.equal(codeOf(source), 'WIZZ-P056', source);
  }
  assert.throws(() => lexExpression('a + --b'), /Update operator '--' is not supported .* at 1:5\./);
});

test('rejects loose equality with a pointer to the strict form', () => {
  assert.throws(() => lexExpression('a == b'), (error) => error.code === 'WIZZ-P026' && /use '===' at 1:3\./.test(error.message));
  assert.throws(() => lexExpression('a != b'), (error) => error.code === 'WIZZ-P026' && /use '!==' at 1:3\./.test(error.message));
  assert.equal(codeOf('a = b'), 'WIZZ-P026');
  assert.equal(codeOf('a ==== b'), 'WIZZ-P026');
});

test('rejects malformed conditionals, calls, and operators outside the grammar', () => {
  assert.equal(codeOf('a ? b'), 'WIZZ-P058');
  assert.equal(codeOf('a ? b c'), 'WIZZ-P058');
  assert.equal(codeOf('a ? : c'), 'WIZZ-P027');
  assert.equal(codeOf(': a'), 'WIZZ-P027');
  assert.equal(codeOf('f(a'), 'WIZZ-P028');
  assert.equal(codeOf('f(a b)'), 'WIZZ-P028');
  assert.equal(codeOf('f(a,)'), 'WIZZ-P027');
  assert.equal(codeOf('f(,a)'), 'WIZZ-P027');
  assert.equal(codeOf('(a, b)'), 'WIZZ-P028');
  assert.equal(codeOf('a, b'), 'WIZZ-P030');
  assert.equal(codeOf('f()()'), 'WIZZ-P059');
  assert.equal(codeOf("'a'(1)"), 'WIZZ-P059');
  assert.equal(codeOf('(a ? f : g)(1)'), 'WIZZ-P059');
  assert.equal(codeOf('null()'), 'WIZZ-P059');
  // Optional chaining, nullish coalescing, shifts, bitwise, indexing, unary
  // plus, and a dangling operator stay outside the grammar.
  for (const source of ['a?.b', 'a ?? b', 'a >> b', 'a << b', 'a & b', 'a | b', 'a[0]', '+a', '!', 'a !']) {
    assert.notEqual(codeOf(source), null, source);
  }
});

test('rejects reserved words wherever a name is read', () => {
  for (const source of ['new(Foo)', 'delete(a.b)', 'import("x")', 'typeof(a)', 'void(0)', 'delete', 'a + yield', 'f(await)', 'let']) {
    assert.equal(codeOf(source), 'WIZZ-P061', source);
  }
  assert.throws(() => parse('a + new(b)'), /'new' is a reserved word and cannot be used in a template expression at 1:5/);
});

test('rejects code-from-string sinks in expressions that call', () => {
  for (const source of [
    'eval(s)', 'Function(s)', 'f(eval)', 'window.eval(s)', 'x.constructor.constructor(s)',
    'f(x.constructor)', 'x.__proto__.f()', 'setTimeout(s)', 'globalThis.setInterval(s, 1)', 'a ? f() : Function'
  ]) {
    assert.equal(codeOf(source), 'WIZZ-P060', source);
  }
  // Without a call there is nothing to invoke, and these compiled before
  // calls existed, so they keep compiling.
  for (const source of ['x.constructor', 'eval', 'x.constructor.name']) {
    assert.equal(codeOf(source), null, source);
  }
});

test('nesting budget covers prefix operators, conditionals, and call arguments', () => {
  assert.doesNotThrow(() => parse(`${'!'.repeat(120)}a`));
  for (const source of [
    `${'!'.repeat(200)}a`,
    `${'- '.repeat(200)}a`,
    `${'a ? '.repeat(200)}1${' : 2'.repeat(200)}`,
    `${'f('.repeat(200)}1${')'.repeat(200)}`
  ]) {
    assert.equal(codeOf(source), 'WIZZ-P053', source.slice(0, 20));
  }
  // A 100k-long unary flood is a diagnostic, not a RangeError.
  assert.equal(codeOf(`${'! '.repeat(100000)}a`), 'WIZZ-P053');
});

test('long left-associative chains parse iteratively and the safety pass does not recurse', () => {
  const chain = Array.from({ length: 20000 }, (_, i) => `f(a${i})`).join(' + ');
  assert.doesNotThrow(() => parse(chain));
  const members = `o${'.n'.repeat(20000)}.f()`;
  assert.doesNotThrow(() => parse(members));
});

test('grouping agrees with JavaScript on hand-picked precedence cases', () => {
  for (const source of [
    'a + b * c - -c / b', '!a === b', '-c * -c', 'a < b === b > a', 'c >= 2 && s || 0',
    'a ? b : c ? 7 : 8', 'b ? a ? 1 : 2 : 3', 'a || b ? s + 1 : -c', 'f(a, b) + twice(c) * 2',
    'o.list.indexOf(2) > -1 ? "yes" : "no"', 's.toUpperCase().length + o.n', '!!o.n && !a',
    '1.5 * c - 0.5', 'b - - - c', "'a\\'b' + s", 'null === null', 'true && false || !false',
    'a < b < c', 'c > b > a', 'twice(-c) <= -twice(c)', '(a || b) && (c || a)'
  ]) {
    assert.ok(same(evaluate(parse(source), SCOPE), runAsJs(source)), source);
  }
});

test('fuzz: every accepted expression is valid strict JavaScript and evaluates the same', () => {
  // Seeded so a failure reproduces.
  let seed = 0x6969;
  const random = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const atoms = ['a', 'b', 'c', 's', 'o.n', '1', '2', '0.5', "'x'", 'true', 'false', 'null', 'f(a, b)', 'twice(c)', 'o.list.indexOf(1)'];
  const binary = ['+', '-', '*', '/', '===', '!==', '<', '>', '<=', '>=', '&&', '||'];
  const generate = (depth) => {
    const pick = random(depth > 3 ? 1 : 6);
    if (pick === 0) return atoms[random(atoms.length)];
    if (pick === 1) return `${['!', '-', '- '][random(3)]}${generate(depth + 1)}`;
    if (pick === 2) return `(${generate(depth + 1)})`;
    if (pick === 3) return `${generate(depth + 1)} ? ${generate(depth + 1)} : ${generate(depth + 1)}`;
    if (pick === 4) return `twice(${generate(depth + 1)})`;
    return `${generate(depth + 1)} ${binary[random(binary.length)]} ${generate(depth + 1)}`;
  };
  let accepted = 0;
  for (let i = 0; i < 3000; i += 1) {
    const source = generate(0);
    let ast;
    try {
      ast = parse(source);
    } catch (error) {
      // Only the update-operator guard may reject a generated expression
      // (`-` directly before a `-`-prefixed operand). JavaScript reads that
      // text as a decrement — a mutation or a SyntaxError — never as two
      // negations, which is exactly why it is rejected.
      assert.equal(error.code, 'WIZZ-P056', source);
      assert.match(source, /--/);
      continue;
    }
    accepted += 1;
    assert.ok(same(evaluate(ast, SCOPE), runAsJs(source)), source);
  }
  assert.ok(accepted > 2500, `only ${accepted} generated expressions were accepted`);
});

// --- Review follow-ups ---

test('the safety pass handles very wide argument lists without exhausting the stack', () => {
  // Spreading 200k arguments into Array.prototype.push overflowed the stack.
  const wide = `f(${Array(200000).fill('1').join(',')})`;
  const ast = parse(wide);
  assert.equal(ast.arguments.length, 200000);
  // An unsafe name buried at the end of the list is still found.
  const unsafe = `f(${Array(200000).fill('1').join(',')},eval)`;
  assert.equal(codeOf(unsafe), 'WIZZ-P060');
});

test('braced unicode escapes accept leading zeros and keep the code point bound', () => {
  assert.equal(parse(String.raw`'\u{0000041}'`).value, 'A');
  assert.equal(parse(String.raw`'\u{000000000010FFFF}'`).value, String.fromCodePoint(0x10ffff));
  assert.equal(codeOf(String.raw`'\u{0110000}'`), 'WIZZ-P057');
  assert.equal(codeOf(String.raw`'\u{41'`), 'WIZZ-P057');
  // Each escape is matched in place, so escape-heavy strings lex in linear
  // time (the old per-escape slice copied the rest of the input each time).
  const escapes = String.raw`\x41`.repeat(100000);
  const started = Date.now();
  assert.equal(parse(`'${escapes}'`).value.length, 100000);
  assert.ok(Date.now() - started < 2000, 'escape-heavy string lexed too slowly');
});

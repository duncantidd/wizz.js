const assert = require('node:assert/strict');
const test = require('node:test');
const { CodeBuilder } = require('./codeBuilder');

test('builds code with two-space indentation', () => {
  const output = new CodeBuilder()
    .add('function increment() {')
    .indent()
    .add('count += 1;')
    .dedent()
    .add('}')
    .generate();

  assert.equal(output, 'function increment() {\n  count += 1;\n}');
});

test('supports chaining and does not dedent below zero', () => {
  const builder = new CodeBuilder();

  assert.strictEqual(builder.add('const count = 0;'), builder);
  assert.strictEqual(builder.indent(), builder);
  assert.strictEqual(builder.dedent(), builder);
  assert.strictEqual(builder.dedent(), builder);

  builder.add('const title = "Total";');

  assert.equal(builder.generate(), 'const count = 0;\nconst title = "Total";');
});

test('generates an empty string when no lines were added', () => {
  assert.equal(new CodeBuilder().generate(), '');
});

test('rejects non-string code lines', () => {
  const builder = new CodeBuilder();

  assert.throws(() => builder.add(67), /Code line must be a string\./);
  assert.throws(() => builder.add(null), /Code line must be a string\./);
});
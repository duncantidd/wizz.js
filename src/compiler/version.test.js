const assert = require('node:assert/strict');
const test = require('node:test');
const { VERSIONS } = require('./version.js');

test('exposes exactly the compiler, syntax, and output versions', () => {
  assert.deepEqual(Object.keys(VERSIONS).sort(), ['compiler', 'output', 'syntax']);
});

test('pins the current contract versions so bumps are deliberate', () => {
  // 1.5.0 / syntax 1.1.0 / output 1.5.0: milestone 14 (1.4.0) added the full
  // template surface server-side. 1.5.0 fixes the if-with-else traversal bug
  // the broadened surface exposed: the parser's `children` alias repoints to
  // the alternate at {:else}, so the dependency analyzer, ID assigner, and
  // component-ref collector missed consequent content — reactive elements and
  // component tags in a taken-branch-with-else generated no IDs/deps at all.
  // Generated output changes (corrected IDs, dependency flags, and refs) for
  // those templates, so compiler and output bump together with syntax pinned.
  assert.deepEqual({ ...VERSIONS }, {
    compiler: '1.5.0',
    syntax: '1.1.0',
    output: '1.5.0'
  });
});

test('every version is a full semver string', () => {
  for (const value of Object.values(VERSIONS)) {
    assert.equal(typeof value, 'string');
    assert.match(value, /^\d+\.\d+\.\d+$/);
  }
});

test('the version table is frozen so callers cannot mutate the contract', () => {
  assert.equal(Object.isFrozen(VERSIONS), true);
  assert.throws(() => {
    'use strict';
    VERSIONS.syntax = '9.9.9';
  }, TypeError);
  assert.equal(VERSIONS.syntax, '1.1.0');
});

test('the compiler major version leads or matches every contract major version', () => {
  // Policy invariant: a breaking change to either contract is also a breaking
  // change to the compiler, so its major version is never behind.
  const major = (version) => Number(version.split('.')[0]);
  assert.ok(major(VERSIONS.compiler) >= major(VERSIONS.syntax));
  assert.ok(major(VERSIONS.compiler) >= major(VERSIONS.output));
});

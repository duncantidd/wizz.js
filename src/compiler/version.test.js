const assert = require('node:assert/strict');
const test = require('node:test');
const { VERSIONS } = require('./version.js');

test('exposes exactly the compiler, syntax, and output versions', () => {
  assert.deepEqual(Object.keys(VERSIONS).sort(), ['compiler', 'output', 'syntax']);
});

test('pins the current contract versions so bumps are deliberate', () => {
  // 1.6.0 / syntax 1.2.0 / output 1.6.0: milestone 15 added the <wizz:head>
  // block — new component syntax (HeadBlock node, parser diagnostics) and an
  // additive output surface (server `head` field beside `{ html, state }`;
  // client mount/destroy head management and hydration head adoption). Both
  // contracts grew, so compiler, syntax, and output bump together.
  assert.deepEqual({ ...VERSIONS }, {
    compiler: '1.6.0',
    syntax: '1.2.0',
    output: '1.6.0'
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
  assert.equal(VERSIONS.syntax, '1.2.0');
});

test('the compiler major version leads or matches every contract major version', () => {
  // Policy invariant: a breaking change to either contract is also a breaking
  // change to the compiler, so its major version is never behind.
  const major = (version) => Number(version.split('.')[0]);
  assert.ok(major(VERSIONS.compiler) >= major(VERSIONS.syntax));
  assert.ok(major(VERSIONS.compiler) >= major(VERSIONS.output));
});

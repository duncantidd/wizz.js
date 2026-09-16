const assert = require('node:assert/strict');
const test = require('node:test');
const { VERSIONS } = require('./version.js');

test('exposes exactly the compiler, syntax, and output versions', () => {
  assert.deepEqual(Object.keys(VERSIONS).sort(), ['compiler', 'output', 'syntax']);
});

test('pins the current contract versions so bumps are deliberate', () => {
  // 1.8.0 / syntax 1.4.0 / output 1.8.0: milestone 17 added persistent
  // cross-tab state — new component syntax (the persist(key, default)
  // initializer marker with its parser diagnostics) and an output change
  // (client initializers read storage through __wizzPersistRead, mutations
  // write through __wizzPersistWrite, mounts subscribe through
  // __wizzPersistSubscribe on a shared per-page bus; server modules render
  // the default and ship the value for hydration). Both contracts grew, so
  // compiler, syntax, and output bump together.
  assert.deepEqual({ ...VERSIONS }, {
    compiler: '1.8.0',
    syntax: '1.4.0',
    output: '1.8.0'
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
  assert.equal(VERSIONS.syntax, '1.4.0');
});

test('the compiler major version leads or matches every contract major version', () => {
  // Policy invariant: a breaking change to either contract is also a breaking
  // change to the compiler, so its major version is never behind.
  const major = (version) => Number(version.split('.')[0]);
  assert.ok(major(VERSIONS.compiler) >= major(VERSIONS.syntax));
  assert.ok(major(VERSIONS.compiler) >= major(VERSIONS.output));
});

const assert = require('node:assert/strict');
const test = require('node:test');
const { VERSIONS } = require('./version.js');

test('exposes exactly the compiler, syntax, and output versions', () => {
  assert.deepEqual(Object.keys(VERSIONS).sort(), ['compiler', 'output', 'syntax']);
});

test('pins the current contract versions so bumps are deliberate', () => {
  // 1.3.0 / syntax 1.1.0 / output 1.3.0: server-side rendering and hydration.
  // The compiler gains an explicit `compileServer()` target and an opt-in
  // `hydratable` compile flag; the output contract additively gains the
  // optional `hydrateComponent(target, props, state)` export and its
  // hydration traversal on hydratable modules. Default `mountComponent`
  // behavior is unchanged and component syntax is untouched, so both minors
  // bump together with syntax pinned.
  assert.deepEqual({ ...VERSIONS }, {
    compiler: '1.3.0',
    syntax: '1.1.0',
    output: '1.3.0'
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

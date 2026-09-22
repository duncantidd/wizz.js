const assert = require('node:assert/strict');
const test = require('node:test');
const { VERSIONS } = require('./version.js');

test('exposes exactly the compiler, syntax, and output versions', () => {
  assert.deepEqual(Object.keys(VERSIONS).sort(), ['compiler', 'output', 'syntax']);
});

test('pins the current contract versions so bumps are deliberate', () => {
  // 1.8.0 / syntax 1.4.0 / output 1.8.1: milestone 17 added persistent
  // cross-tab state — new component syntax (the persist(key, default)
  // initializer marker with its parser diagnostics) and an output change
  // (client initializers read storage through __wizzPersistRead, mutations
  // write through __wizzPersistWrite, mounts subscribe through
  // __wizzPersistSubscribe on a shared per-page bus; server modules render
  // the default and ship the value for hydration). Both contracts grew, so
  // compiler, syntax, and output bump together. The output patch bump fixes
  // hydration for persistent vars: the adoption walk now verifies the
  // delivered markup against the delivered state (previously it evaluated
  // persistent expressions against the storage-read value, which forced a
  // fallback whenever the stored value differed from the default). The
  // compiler patch bump adds the placement diagnostics: persist() markers
  // outside a top-level let initializer — inside a function body, a block,
  // or another persist() default — are located compile errors instead of
  // runtime ReferenceErrors, and an author-defined persist binding opts out
  // of marker recognition entirely.
  //
  // 1.8.2: compiler patch fix — the scoped-style scanner corrupted every
  // keyframe name after the first in a comma-separated animation value
  // (the read cursor double-counted the first rewritten name's width, so
  // `animation: cursor 0.5s, blinking 0.5s` scoped to something like
  // `blinkinblinking-S...nfinite`). Syntax and output contracts unchanged.
  //
  // output 1.8.2: server output patch fix — empty non-void elements shipped
  // without an end tag (`<path ...>` before `</svg>`, `<code ...>` before
  // `</pre>`), and the browser's recovery keeps such an element open and
  // swallows the following markup into it, so the delivered childNodes no
  // longer aligned one-to-one with the template positions the hydration
  // walk verifies. Every non-void element now closes in delivered markup.
  //
  // compiler 1.8.3 / syntax 1.4.1: parse-time normalization fix — a single
  // newline immediately after a pre/textarea/listing start or end tag is
  // now dropped from the AST, matching the HTML tree builder (the server
  // emitted the newline, the browser dropped it from the delivered markup,
  // and the hydration walk verified text the browser never stored, forcing
  // a fallback for any component with a `<pre>` element). The accepted
  // source is unchanged but a compiling pre element's rendered meaning
  // loses the authoring newline on the client too, which is the syntax
  // patch; the AST construction change is the compiler patch.
  //
  // compiler 1.9.0: additive diagnostics contract — every author-facing
  // SyntaxError carries a stable diagnostic code, structured locations, and
  // collect mode (see the history above). compiler 1.10.0: the post-M19
  // package-release bump for the showcase starter scaffold and the build
  // layer's shell-side App.css copy — no compiler contract moved, so syntax
  // and output hold. compiler 1.10.1: the release cut carrying the VS Code
  // extension's .vsix packaging — additive only, so the syntax and output
  // contracts hold.
  assert.deepEqual({ ...VERSIONS }, {
    compiler: '1.10.1',
    syntax: '1.4.1',
    output: '1.8.2'
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
  assert.equal(VERSIONS.syntax, '1.4.1');
});

test('the compiler major version leads or matches every contract major version', () => {
  // Policy invariant: a breaking change to either contract is also a breaking
  // change to the compiler, so its major version is never behind.
  const major = (version) => Number(version.split('.')[0]);
  assert.ok(major(VERSIONS.compiler) >= major(VERSIONS.syntax));
  assert.ok(major(VERSIONS.compiler) >= major(VERSIONS.output));
});

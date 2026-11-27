// Single source of truth for Wizz's compatibility contract.
//
// All three values are semver strings:
//   - `compiler` is the version of the compiler itself.
//   - `syntax` is the contract version of the component language: the template
//     directives, expression grammar, and script boundary a `.wizz` file may
//     use. Within one major version, any component that compiled before keeps
//     compiling with the same meaning. New syntax may be added in a minor
//     version; existing syntax never changes meaning without a major bump.
//   - `output` is the contract version of the generated module surface: the
//     `mountComponent(target, props, anchor?)` default export, the returned
//     `{ setProps?, destroy() }` handle, and the `__wizz*` root-node
//     properties the framework consumes. Optionally — for compiles requested
//     with the `hydratable` flag — the module additionally exports
//     `hydrateComponent(target, props, state)` and
//     `hydrateRoot(rootNode, props, state)`, which adopt server-rendered
//     markup (including blocks, lists, and nested components) through the
//     documented hydration traversal. For components compiled from a
//     `<wizz:head>` template (or rendering head-declaring children), the
//     surface additionally carries the additive `head` field: server modules
//     export `renderComponent(props, options)` returning
//     `{ html, head, state }` with `head` the serialized head markup string,
//     and client modules manage the document head on mount/destroy and
//     adopt the delivered head during hydration. For components compiled from
//     a `<wizz:style>` template, every rendered element additionally carries
//     the `data-wizz-s` scope attribute in markup (server HTML, client
//     `create()`, and hydration walks agree) and the head surface dedups
//     scoped `<style>` nodes by their `data-wizz-style` attribute with
//     `data-wizz-refs` refcounting (compiles requested with `extractedStyles`
//     carry no CSS and create no such node: a linked stylesheet delivers it). For components declaring
//     `let name = persist(key, default)` state, the surface additionally
//     carries the additive `persist` capability: client initializers read the
//     value through the `__wizzPersistRead` helper, statement mutations write
//     through `__wizzPersistWrite`, and mounts subscribe through
//     `__wizzPersistSubscribe`, whose shared per-page bus keeps instances
//     converged across tabs via BroadcastChannel with a storage-event
//     fallback (server modules render the declared default instead and ship
//     the value for hydration; the client hydration walk verifies the
//     delivered markup against that delivered state and restores the
//     storage-read values once it returns, so client storage stays the
//     mounted truth). Server-delivered markup always closes every non-void
//     element, children or not: the adoption walk verifies delivered
//     childNodes one-to-one against template positions, and an unterminated
//     start tag would let the browser swallow the following markup into the
//     still-open element. A single newline immediately after a pre,
//     textarea, or listing start or end tag is dropped at parse time — the
//     HTML tree builder drops it from the delivered markup, so the AST must
//     not carry it (an authoring newline is not rendered content). Within
//     one major version, generated
//     modules keep this surface and their runtime behavior.
//
//     The marker is accepted only as a top-level `let` initializer: a
//     persist() call inside a block or function body, or nested inside
//     another persist() default, is a located compile error (the generated
//     machinery it would emit references a variable the mount scope never
//     has). An author who binds the name `persist` themselves opts out of
//     marker recognition entirely.
//
// The compiler's compile()/compileServer() entry points additionally carry
// the additive diagnostics contract: every author-facing SyntaxError carries
// a stable `code` from src/compiler/diagnostics.js (never reworded into a
// different meaning, never reused), thrown errors expose structured
// `line`/`column` fields beside the prose locations, and the
// `diagnostics: 'collect'` option returns structured diagnostics records
// instead of throwing. None of this changes accepted component syntax or
// generated output.
//
// compiler 1.16.0: `wizz mcp` exposes the project structure, language
// contract, compiler diagnostics, build envelope, and dev workflow to AI
// agents over the Model Context Protocol — an additive CLI/tooling surface
// built on the existing compile()/compileServer() and build.js contracts,
// with no compiler source, parser, or generated-module changes, so syntax
// and output hold.
//
// compiler 1.17.0: resource-hardening of the parse stage, which compiles
// untrusted component source (agent tooling, editor integrations, CI). The
// Pratt expression parser gains a recursion-depth budget and the template
// parser a nesting budget (WIZZ-P053 / WIZZ-P054), turning pathological
// inputs from stack-overflow crashes into located diagnostics. No accepted
// syntax changes meaning and no generated module changes, so syntax and
// output hold; the new codes are additive catalog entries.
//
// compiler 1.17.1 / syntax 1.4.2 / output 1.8.3: inline `on:` handler
// fix. Assignments written directly in an inline directive handler —
// `on:input={(e) => name = e.target.value}`, block-bodied arrows, and
// function expressions — were emitted verbatim and never scheduled an
// update, although the documented contract is that handlers mutating
// reactive state update the DOM. The generator now runs those handlers
// through the same assignment interceptor as script functions (an
// expression-bodied arrow becomes a block body; addEventListener ignores
// listener return values, so dropping the value is unobservable). Output
// patch: generated listeners for mutating inline handlers change; every
// other handler is emitted byte-identical. Syntax patch: an inline handler
// that mutates a prop now fails with the existing read-only diagnostic
// (WIZZ-G015) instead of silently assigning a local copy — enforcement of
// the already-documented "props are read-only" rule, not a new restriction.
//
// compiler 1.18.0 / output 1.9.0: the additive `extractedStyles` compile
// option. When a linked stylesheet delivers a component's CSS, client,
// hydratable, and server modules carry none of it and neither inject nor
// adopt a scoped `<style>`; `data-wizz-s` markup is unchanged. Output without
// the option is byte-identical apart from the version header, so syntax
// holds.
//
// compiler 1.21.0 / output 1.11.0: dynamic attribute policy (issue #72).
// HTML boolean attributes written from an expression are present when the
// value is truthy and removed when it is falsy (`hidden={false}` no longer
// renders `hidden="false"`); every other dynamic attribute is removed for
// null/undefined instead of rendering "null"/"undefined". `false` still
// renders "false" outside the boolean list so enumerated attributes such as
// aria-* keep their meaning. Client create/update, each items, hydration,
// head nodes, and server markup all follow attributePolicy.js. Output minor:
// generated attribute writes change and modules gain the module-scope
// `__wizzAttr` helper when they need it; the module surface is unchanged.
// Syntax holds: the template grammar and directives accept exactly what they
// did, and what a dynamic attribute renders is part of the output contract.
//
// compiler 1.22.0 / syntax 1.5.0 / output 1.12.0: reactive `{#if}` blocks
// (issue #71) and `on:` directives inside `{#each}` bodies (issue #70).
// An `{#if}` whose test reads reactive state is re-evaluated when one of its
// dependencies changes: the old branch is removed with its listeners, lists,
// and child components, and the new one is built from current state. A test
// with no reactive dependency keeps the inline mount-time emission. `on:`
// directives are accepted inside each bodies, with the item variable in
// scope of the handler; listeners attach per item record and detach when the
// record is removed. Syntax minor: each bodies accept a directive they used
// to reject (WIZZ-G006 is retired: it stays in the catalog, never reused,
// and is no longer thrown); the `{#if}` grammar is unchanged. Output minor:
// modules with a reactive `{#if}` gain the module-scope `__wizzIfBlock` /
// `__wizzDropScope` helpers, factory-scope `__wizzIfMake_<id>_<key>` branch
// makers, and one empty-text anchor per block; listeners owned by a branch
// or an item attach through `__wizzOn` into the owning scope's `__wizzDrop`
// list instead of the component-wide `__wizzListeners`. The module surface
// (`mountComponent`, `hydrateComponent`, `hydrateRoot`, `{ setProps?,
// destroy() }`) is unchanged, and templates using neither feature keep
// byte-identical output apart from the version header. Server markup is
// unchanged. The behavior change for existing components — a branch that
// used to stay put now follows its test — lifts a documented "not supported
// yet" limit and follows the precedent of the 1.21.0 attribute policy.
//
// compiler 1.22.1 / syntax 1.5.1 / output 1.12.0: a quoted attribute value that
// holds an expression (`class="card {tone}"`) is a compile error, WIZZ-P055
// (issue #64). Such values were always static, so the braces rendered
// literally with no hint. Braces whose content is not an expression
// (`data-x='{"a":1}'`) stay literal. Syntax patch: the catalog grows
// additively and the rejected form never did what its author intended.
// Output is unchanged.
//
// compiler 1.23.0 / syntax 1.6.0 / output 1.13.0 (one release; issues #69
// and #73):
//   - The template expression grammar (issue #69) gains the conditional
//     operator, `!==`, `< > <= >=`, `&&`/`||`, unary `!`/`-`,
//     `true`/`false`/`null` literals, decimals, and calls of a name or
//     method. Every expression that compiled before parses to the same AST
//     and means the same thing. WIZZ-P056–P061 reject forms that never loaded
//     or ran as written (update operators, leading-zero and `1.foo` numbers,
//     malformed escapes, reserved words as names) and code-from-string sinks
//     in calling expressions. A quoted attribute holding a newly valid
//     expression (`title="{a ? b : c}"`) now meets WIZZ-P055, which is the
//     diagnostic's purpose. Expression source is spliced verbatim in
//     parenthesized positions, so this half changes no generated structure.
//   - Two-way bindings (issue #73): `bind:value` and `bind:checked` are
//     accepted directives, desugared in the parser into a dynamic attribute
//     plus an inline `on:` handler; misuse is WIZZ-P062–P064. An inline
//     arrow whose whole body is a parenthesized assignment
//     (`(e) => (name = e.target.value)`) is now instrumented like the
//     unparenthesized form; it used to change state without an update, so
//     this enforces the documented "inline handler assignments update the
//     DOM" contract, and a prop assigned that way now meets WIZZ-G015.
//   Syntax minor: additive grammar and directives. Output minor: modules
//   with a numeric binding gain the module-scope `__wizzSetNumber` helper,
//   and parenthesized-assignment handlers gain their update call; every
//   other module is byte-identical apart from the version header, and the
//   module surface is unchanged.
//
// The compile() result additionally carries an additive `warnings` array
// (WIZZ-G026: a reactive name assigned where no update is scheduled).
// Warnings never fail a compile and change no generated output.
//
// compiler 1.24.0 / syntax 1.6.0 / output 1.13.0: a release bump for
// milestone 24 (`wizz init` asks sample-or-bare; `--sample`/`--bare`). The
// compiler pipeline is unchanged, but the package version is pinned in
// lockstep with `compiler` and the release workflow requires the tag to match
// it, so shipping the new CLI capability needs a compiler minor (the same
// call milestone 19 made for `wizz init` itself). Syntax and output hold;
// generated modules differ only in the version banner.
//
// compiler 1.25.0 / syntax 1.6.0 / output 1.13.0: milestone 23
// (`wizz build --compact`) plus a script-lexer fix. scriptLexer.js now ends a
// line comment at every ECMAScript line terminator (CR, U+2028, U+2029, not
// only LF), keeps a CRLF line continuation inside its string or template,
// stops a string at a raw CR, and never lets a regex literal span a line
// terminator; CR and the separators also set `newlineBefore`. A `/` after a
// closing template backtick is division and a `/` after `default` starts a
// regex (`export default /re/`), matching the engine. Script
// statement extents could previously swallow the code after such a comment.
// Parsing logic changed, so the compiler moves; accepted component syntax and
// generated output do not, so syntax and output hold. The release also drops
// Node 18 and 20 (Node 22+ now) — a platform-support change shipped as a
// minor by decision, since no contract surface changes.
//
// compiler 1.26.0 / syntax 1.6.0 / output 1.13.1: milestone 26. The compile()
// `warnings` array gains WIZZ-G027: a statement-level call of an in-place
// array method (push, pop, shift, unshift, splice, sort, reverse, fill,
// copyWithin) on a reactive, non-prop `let` inside a function, with no later
// mutation of that name before the outermost enclosing function closes. A new
// analysis, so the compiler moves; the generated code is unchanged (warnings
// never alter output) and no component that compiled before is rejected, so
// syntax holds. Output patch, from the review of this milestone: the
// rewriter's parameter detection now shares one rule (classifyParenGroup)
// with function-scope detection, so parameters of anonymous generators,
// computed methods, reserved-word methods (`set(items) {}`), and functions
// named by contextual keywords (`function set(items) {}`) shadow reactive
// names. Assigning such a parameter used to emit a spurious
// `__wizzQueueUpdate` (and, for persistent state, a storage write of the
// parameter's value); it no longer does. Every other module is byte-identical
// apart from the version banner. Recorded decision: local state never gains an
// identity check, so `items.push(x); items = items;` keeps scheduling its
// update; props keep their separate `Object.is` short-circuit in setProps.
//
// compiler 1.27.0 / syntax 1.7.0 / output 1.14.0: milestone 25 step 1,
// imported component tags inside `{#each}` bodies, nested in the item element
// or as the item's root. WIZZ-G004 is retired (kept in the catalog, never
// reused or thrown). Each item record owns its child instances through its
// `drop` array: a child mounts once the item is attached (create() queues it
// on `__wizzMounts`; the first list pass defers to the enclosing scope's
// child mounts), receives every dynamic prop through setProps() from the
// record's update() (its Object.is check skips unchanged values), is
// destroyed when the item leaves, and keeps its identity and state when a
// keyed record moves; keyless records reuse instances by position. A
// component at the item root becomes the record's node (the anchor's
// previous sibling once mounted). Server rendering renders each row's child
// through its server module, keying the state slice and head owner by the
// item's position (`<componentId>:<index>`, never author data), and the
// hydration walk adopts each row's child through hydrateRoot after the walk
// passes, with the same keys; a mismatch inside a row child remounts inside
// that child's root. Syntax minor: a template form that used to be rejected
// compiles. Output minor: lists with components gain the deferred-mount
// parameters, per-item child variables, and the drop-first removal; lists
// without components, and every other module, are byte-identical apart from
// the version banner. The module surface is unchanged.
//
// Bump rules: a breaking change to a contract bumps its major version and the
// compiler's major version. Additive capabilities bump the affected minor
// version. Fixes bump patch versions. The contract test in version.test.js
// pins the current values so a bump can only happen deliberately.
const VERSIONS = Object.freeze({
  compiler: '1.27.0',
  syntax: '1.7.0',
  output: '1.14.0'
});

module.exports = { VERSIONS };

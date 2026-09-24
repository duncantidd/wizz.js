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
//     `mountComponent(target, props)` default export, the returned
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
//     `data-wizz-refs` refcounting. For components declaring
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
// Bump rules: a breaking change to a contract bumps its major version and the
// compiler's major version. Additive capabilities bump the affected minor
// version. Fixes bump patch versions. The contract test in version.test.js
// pins the current values so a bump can only happen deliberately.
const VERSIONS = Object.freeze({
  compiler: '1.12.0',
  syntax: '1.4.1',
  output: '1.8.2'
});

module.exports = { VERSIONS };

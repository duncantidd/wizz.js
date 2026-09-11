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
//     documented hydration traversal. Within one major version, generated
//     modules keep this surface and their runtime behavior.
//
// Bump rules: a breaking change to a contract bumps its major version and the
// compiler's major version. Additive capabilities bump the affected minor
// version. Fixes bump patch versions. The contract test in version.test.js
// pins the current values so a bump can only happen deliberately.
const VERSIONS = Object.freeze({
  compiler: '1.4.0',
  syntax: '1.1.0',
  output: '1.4.0'
});

module.exports = { VERSIONS };

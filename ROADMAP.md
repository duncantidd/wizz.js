# Wizz Roadmap

This roadmap orders work by dependency. Each milestone should have focused tests before the next milestone begins.

## 1. Stabilize the Compiler Contract

~~**Goal:** Make the current component language predictable before expanding its surface area.~~

- ~~Keep the parser, analyzer, generator, and their README files synchronized whenever behavior changes.~~
- ~~Establish a single `compile(source)` API that runs parsing, analysis, ID assignment, and generation.~~
- ~~Make compiler errors include the input file path as well as source location when compilation is initiated from a file.~~
- ~~Harden the script transformation boundary. The assignment interceptor is deliberately scoped; do not represent it as full JavaScript parsing.~~
- ~~Add end-to-end fixtures that compile representative `.wizz` components and execute the generated module against a minimal DOM.~~

~~**Done when:** one public compiler function has a tested input/output contract, and a compiler failure identifies both its file and source location.~~

## 2. Make the Build Script a Project Compiler

~~**Goal:** Replace the fixed `App.wizz -> App.js` demonstration with a repeatable multi-file build.~~

- ~~Accept input and output directories, for example `node build.js src dist`.~~
- ~~Recursively discover every `.wizz` file below the input directory.~~
- ~~Preserve relative paths while changing `.wizz` to `.js`:~~

  ```text
  src/pages/Home.wizz  -> dist/pages/Home.js
  ```

- ~~Create missing output directories before writing generated modules.~~
- ~~Compile files independently and report every failure with its file path.~~
- ~~Set a non-zero process exit code when one or more files fail.~~
- ~~Do not overwrite source files or use the source directory as build output.~~
- ~~Add tests using a temporary fixture tree for nested inputs, successful output, and invalid components.~~

~~**Done when:** a project with several components can be compiled in one command into a clean output directory.~~

## 3. Define the Application Entry Contract

~~**Goal:** Separate a static document shell from the application runtime.~~

- ~~Treat `index.html` as the document shell only: it supplies `<div id="app"></div>` and loads one module.~~
- ~~Add a browser entry module, initially something like `src/runtime/main.js`.~~
- ~~Have the build process copy or emit runtime modules into the output directory.~~
- ~~Replace the inline module script in `index.html` with a module entry reference, such as `/dist/runtime/main.js`.~~
- ~~Define how the entry module locates the mount target and reports a missing target.~~

~~**Done when:** the browser starts the application from one runtime entry module rather than importing a specific example component in `index.html`.~~

## 4. Add Minimal Client-Side Routing

~~**Goal:** Mount the correct compiled component for the current path.~~

- ~~Start with an explicit route table, not file-based routing:~~

  ```js
  const routes = {
    '/': () => import('../pages/Home.js'),
    '/about': () => import('../pages/About.js')
  };
  ```

- ~~Resolve `window.location.pathname` to a component module.~~
- ~~Destroy the currently mounted component before mounting the next one.~~
- ~~Render a small not-found component for unmatched paths.~~
- ~~Add a navigation helper that uses `history.pushState()` and rerenders.~~
- ~~Listen for `popstate` so browser Back and Forward work.~~
- ~~Test route resolution, teardown, not-found behavior, and history navigation.~~

~~**Done when:** direct loads, in-app navigation, Back, and Forward all mount the expected component without a full page reload.~~

## 5. Add a Wizz Development Command

~~**Goal:** Give application authors one local development command after the build and runtime conventions exist.~~

- ~~Add a `wizz dev` command or a `node scripts/dev.js` precursor.~~
- ~~Run the project build before serving files.~~
- ~~Serve the output directory over HTTP.~~
- ~~Provide SPA fallback: unknown non-file requests should return `index.html` so direct route loads work.~~
- ~~Watch source files and rebuild changed `.wizz` files. Start with full rebuilds if that keeps behavior clear.~~
- ~~Report the local URL and compilation errors cleanly.~~

~~**Done when:** one command builds, serves, and supports direct navigation to a client-side route.~~

## 6. Expand Core Component Features Deliberately

~~**Goal:** Add language features only when their parser, analyzer, generator, and runtime behavior are designed together.~~

Suggested order:

1. ~~More event directives and event arguments.~~
2. ~~Dynamic attributes and properties.~~
3. ~~Conditional rendering.~~
4. ~~Lists and keyed reconciliation semantics.~~
5. ~~Component imports and nested components.~~
6. ~~Lifecycle hooks, cleanup, and scheduler batching.~~

Every feature should include parser tests, generated-source tests, and a mounted runtime test.

## 7. Production Hardening

**Goal:** Make framework behavior dependable for real applications.

- ~~Define compatibility and versioning policy for component syntax and generated output.~~
- ~~Replace or substantially extend the limited script scanner and transformation layer with syntax-aware JavaScript handling.~~
- ~~Improve diagnostics with component file paths, source excerpts, and code frames.~~
- ~~Add source maps or another debug mapping strategy for generated modules.~~
- ~~Add benchmark fixtures and regression tests for repeated updates, teardown, and large trees.~~
- ~~Document browser support, security boundaries, and generated-code assumptions.~~

## 8. Promote a Public CLI

**Goal:** Make the project compiler and development server available through a stable `wizz` command.

- ~~Define an installable `wizz` command that exposes `wizz build <input-directory> <output-directory>` and `wizz dev`, with `src` and `dist` defaults when build paths are omitted, without requiring npm or a package registry.~~
- ~~Reuse the existing build and development-server implementations rather than duplicating their behavior in the CLI layer.~~
- ~~Validate commands and arguments with actionable usage errors and non-zero exit codes on failures.~~
- ~~Document installation, command usage, defaults, and the public stability boundary.~~
- ~~Add focused command-level tests for successful execution, invalid arguments, and propagated build failures.~~

~~**Done when:** application authors can install and run documented `wizz build` and `wizz dev` commands with the same reliable behavior as the current Node entry points.~~

## 9. Generate File-Based Routes

**Goal:** Generate the browser route table from the application `src/pages` directory so authors do not maintain routes manually in `src/runtime/main.js`.

- ~~Make the project build discover page components below `src/pages` and emit a generated route manifest into `dist/runtime`.~~
- ~~Define stable path conventions, including `src/App.wizz` for `/`, `src/pages/index.wizz` for `/`, nested page paths, and case normalization.~~
- ~~Make the runtime consume the generated manifest rather than a repository-owned hard-coded route table.~~
- ~~Detect ambiguous paths, duplicate route claims, and reserved runtime paths during the build, with file-aware diagnostics.~~
- ~~Preserve explicit dynamic imports so only the route selected by the browser is loaded.~~
- ~~Add build, generated-manifest, and runtime tests for root pages, nested pages, direct route loads, collisions, and removal of a page after a rebuild.~~

~~**Done when:** adding, renaming, nesting, or removing a `.wizz` page changes its browser route after the next build without an edit to `src/runtime/main.js`.~~

## 10. Add Component Props

~~**Goal:** Let parent components pass explicit inputs to imported child components through a stable render and update contract.~~

- ~~Define prop declaration and consumption syntax for child component scripts and template expressions.~~
- ~~Allow imported component tags to receive static and dynamic attributes as props while retaining clear native-attribute behavior.~~
- ~~Define prop values, defaults, missing-prop behavior, and whether prop bindings are read-only inside child components.~~
- ~~Update component mounting so child instances receive props without relying on ambient parent state.~~
- ~~Define reactive prop-update semantics, including parent updates, child rerenders, teardown, and component identity in lists.~~
- ~~Add parser, analyzer, generator, and mounted runtime tests for static props, reactive props, defaults, invalid prop syntax, nested components, and child teardown.~~

~~**Done when:** an imported component receives documented static and reactive props, rerenders predictably as parent values change, and retains its independent teardown contract.~~

Implementation notes: props are declared with `export let name = <default>;` in the child script and passed as attributes on imported component tags (static strings, bare attributes as `true`, dynamic expressions). The child factory receives an explicit props object — `mountComponent(target, props = {})` — and reactive changes flow from the parent's `update()` through guarded `setProps()` calls on mounted child instances, preserving child identity. Prop bindings are read-only (statement-level mutations are compile-time errors), missing props fall back to declared defaults, and components inside each blocks remain unsupported, so identity semantics are defined for directly nested components only. Documented in `src/compiler/generator/README.md` under "Component Props".

## 11. Build a VS Code Extension

~~**Goal:** Provide first-party editor support for stable Wizz language and project workflows.~~

- ~~Add `.wizz` language registration, syntax highlighting, and editor language configuration.~~
- ~~Surface compiler diagnostics with file paths, source locations, excerpts, and code frames through VS Code diagnostics.~~
- ~~Provide component navigation for imports and route-aware page files.~~
- ~~Integrate stable `wizz build` and `wizz dev` commands without making the core compiler depend on VS Code APIs.~~
- ~~Document installation, supported editor features, and the extension's compatibility boundary with Wizz syntax and compiler versions.~~
- ~~Add focused extension tests for language registration, diagnostic conversion, navigation, and command integration.~~

~~**Done when:** Wizz authors can install the extension and receive syntax highlighting, compiler diagnostics, component navigation, and build integration from VS Code.~~

## 12. Add Server-Side Rendering

**Goal:** Reuse the component AST for a distinct HTML string-rendering target and define how the browser hydrates its output.

- ~~Define an explicit server compilation or rendering API without changing the current browser-module contract implicitly.~~
- ~~Render an initial, deliberately narrow supported component surface to HTML strings without creating DOM nodes.~~
- ~~Define trusted-component execution, initial-state serialization, escaping, and source-map exposure boundaries for server output.~~
- ~~Define deterministic hydration markers or traversal rules so browser code can attach to server-rendered DOM without recreating it.~~
- ~~Specify mismatch reporting and fallback behavior before broadening the supported feature set.~~
- ~~Add end-to-end tests that render on the server, hydrate in a minimal browser DOM, preserve initial markup, attach events, and update reactive state.~~

**~~Done when:~~** ~~a documented server-rendered component can be delivered as HTML and hydrated by its client module without duplicate DOM or divergent initial state.~~

Implementation notes: server rendering is an explicit `compileServer(source)` compiler target producing a self-contained ESM that exports `renderComponent(props)` returning `{ html, state }` and `serializeInitialState(state)`. The v1 surface is static markup, text interpolations, dynamic attributes, and top-level props; `{#if}`, `{#each}`, component tags, and event-driven features fail the compile with located diagnostics. Text is escaped (`& < >`), attributes additionally escape `"`; adjacent text nodes carry `<!-- -->` markers so browser parsing preserves the exact positional node layout `update()` targets. Client modules compiled with `compile(source, { hydratable: true })` additionally export `hydrateComponent(target, props, state)`, which adopts the server DOM through a verifying traversal (tag, `data-wizz-id`, and text checks) seeded by the serialized state, reports any mismatch once via `console.warn`, and falls back to a full client mount. Server output carries no source map (HTML strings, not positional DOM artifacts). State serializes inside `<script type="application/wizz-state">` with all `<` escaped; the script is a sibling of the mount point, and seeding uses `hasOwnProperty` + bracket access so a hostile `__proto__` key cannot pollute prototypes. Milestone 13 integrated this target into the build and development server; prerendering at build time and request-time data fetching remain out of scope.

## 13. Serve Server-Rendered Routes from the Development Server

**Goal:** ~~Extend the development workflow so document requests for routes resolve to server-rendered HTML — rendered by the milestone 12 `compileServer()` target and hydrated in the browser by `hydratable` client builds — while keeping the development server zero-dependency and free of any application-backend role.~~

- ~~Extend the project compiler output so each eligible page also emits its `compileServer()` server module and a `hydratable` client build alongside the existing client module, without changing either generated module contract or recompiling pages that already failed the server-renderable gate.~~
- ~~Define route eligibility deliberately: a page server-renders only when it compiles through the server target. Pages using `{#if}`, `{#each}`, or component tags (for example `Contact.wizz`, `About.wizz`) keep today's behavior — the empty document shell with the client router mounting them — so eligibility changes only when the server surface broadens, never per request.~~
- ~~Render per request in the development server: resolve the route's server module, call `renderComponent()` with no props, inject the HTML into the `#app` mount point, and emit `serializeInitialState()` output as a sibling script tag of the mount point, exactly per the documented delivery boundaries.~~
- ~~Replace the SPA fallback only where server rendering applies: eligible routes receive the rendered document; ineligible routes, unmatched paths, and unknown asset paths (HTTP 404) behave exactly as they do today.~~
- ~~Keep watch recompilation consistent: when a watched page changes, the dev server rebuilds both targets and serves fresh server modules, so the in-process module cache (which currently caches compiled compiler modules) can never deliver a stale render after an edit.~~
- ~~Keep the browser entry framework-owned: the delivered document still boots through the standard runtime entry contract (the runtime mounts or hydrates the route component), not through an inline bootstrap script authored by the server.~~
- ~~Add end-to-end tests proving an eligible route request returns a document whose mount point already contains the rendered markup and the sibling state script, the hydratable client build is served, and ineligible routes and asset 404s are byte-for-byte unchanged.~~
- ~~Document the delivery recipe in the README's server-rendering section, keep `scripts/ssr-demo.js` as the manual reference, and record the decision that static prerendering at build time and request-time data fetching remain out of scope.~~

**~~Done when:~~** ~~requesting a server-renderable route from `wizz dev` returns a document whose mount point already contains the page's markup with its serialized initial state, the browser hydrates it without duplicate DOM or mismatch warnings, and non-eligible routes behave exactly as they do today.~~

Implementation notes: `build.js` compiles each route page (`App.wizz` and `src/pages/*`, resolved by `getRoutePath` — component files never attempt server emission) through both server targets and emits `<page>.server.js` (no source map) and `<page>.hydrate.js` (with map, mirroring the client build's map handling) beside the unchanged client module. Eligibility is decided by compiling **both** server targets before writing either — client compilation failures remain build failures, while a server-target failure after a successful client compile is treated as the server-renderability gate and only makes the page ineligible (conservative assumption: both targets share the parse/analyze pipeline, so such a failure is by construction a gate rejection, not a compiler defect). This preserves the invariant *state script delivered ⟹ hydrate module exists*. `dist/runtime/routes.js` entries gain `serverModulePath`/`hydratableModulePath` (dist-relative POSIX paths) or `null`; the manifest is authoritative — builds never clean `dist/`, so orphaned server modules from a flipped eligibility are ignored, never `fs.existsSync`'d. The dev server resolves routes per document request by parsing the generated manifest (a `JSON.stringify` array literal, extracted synchronously from `routes.js` — no cached table, so a stale render after a rebuild is impossible), then imports the server module cache-busted by file mtime, calls `renderComponent()`, and injects `html` inside `#app` with `serializeInitialState()` as a sibling via function-form `String.replace` (string form would corrupt `$&`/`$'`/`$$` sequences in rendered HTML). Route matching mirrors the client router exactly (exact pathname, routes lowercased at build), so `/Home`, unmatched paths, ineligible routes, and asset 404s are byte-identical to the pre-M13 server; any render failure logs and streams the plain shell. The runtime entry builds a second `hydratableRoutes` map from non-null manifest fields and passes it to the router, which hydrates **only on the first render**: it looks for `script[type="application/wizz-state"]`, removes it after reading, imports `hydrateComponent`, and adopts the delivered markup (the standard client module is never loaded on this path); unreadable state, missing hydratable build, or failed adoption drops the server markup (`clearTarget()`) and mounts fresh, never a duplicate DOM — including before a not-found render. First-render-only state is guarded by a monotonic `renderSequence` token checked after every `await`, which also fixes the pre-existing double-mount race when popstate or navigation fires while a route import is in flight. No compiler/syntax/output version bump: compiler sources and generated module contracts are untouched — the manifest and runtime entry are unversioned build/runtime artifacts. Full suite: 385 tests.

## Later Ecosystem Work

- **MCP:** Expose the Wizz project structure, component language contract, compiler diagnostics, build command, and development workflow through a Model Context Protocol server so AI agents can inspect an application and safely create or update Wizz web applications autonomously. Keep filesystem permissions explicit and project-scoped; do not make the core compiler depend on an AI runtime.
- **ORM:** Keep it separate from the core renderer/compiler so application persistence choices do not define component semantics.

## Development Server Decision

~~Keep using Python's `python3 -m http.server` for the current single-example demo. It is dependency-free, adequate for ES module loading, and avoids building tooling before the build output structure exists.~~

~~Do add a Node development server later, as part of milestone 5, because the framework will need a single command that understands Wizz's output directory, triggers compilation, watches source files, and provides SPA fallback for client-side routes. It can remain zero-dependency by using Node's built-in `node:http`, `node:fs`, and `node:path` modules.~~ Do not add an application backend server to the framework core; the development server should serve static build output only. Milestone 13 narrows this deliberately: route documents may be server-rendered through the milestone 12 compiler target, but the server still gains no API layer, request-time data fetching, sessions, or persistence — eligibility and delivery are compilation artifacts, not backend behavior.
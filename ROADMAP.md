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

## 14. Render the Full Template Surface Server-Side

**Goal:** ~~Broaden the milestone 12 server target so every construct with a deterministic initial rendering is delivered server-side — imported components, `{#if}` branches, and `{#each}` lists — in the direction of SvelteKit 5: a page authored entirely of statically-known markup arrives fully rendered from `wizz dev` and hydrates without recreating DOM, while event handlers and lifecycle hooks remain the only client-only behavior.~~

- ~~Render imported component tags recursively through the server target: each imported `.wizz` component compiles through the same server pipeline, receives its evaluated initial props, and emits nested HTML. A page is server-renderable when its entire component tree is; the ineligibility note must identify the deepest blocking construct, not just the first.~~
- ~~Extend the hydration adoption walk across component boundaries: nested component roots are verified positionally, each child seeds from its own serialized initial-state snapshot (with the existing `__proto__`/`__wizz` protections), per-component `data-wizz-id` scoping stays intact, and a mismatch at any depth clears and client-renders without double-mounting parents.~~
- ~~Render the initially-taken `{#if}` branch server-side, evaluated against the component's initial state, and hydrate by verifying the delivered branch before mounting fresh on mismatch.~~
- ~~Render `{#each}` lists server-side for the initial collection and adopt the delivered items positionally during hydration, preserving item markup fidelity and updating correctly when the list changes client-side.~~
- ~~Keep rejections only for genuinely undeliverable constructs (reactive names matching `__proto__` or the reserved `__wizz` prefix, malformed `on:` directives, void elements with children) with located, file-aware diagnostics; the server-renderability gate becomes "is the whole tree statically renderable", not "does the page avoid components".~~
- ~~Keep event handlers and lifecycle hooks client-only and out of the eligibility decision, and keep the development server's zero-dependency, no-application-backend role: request-time data fetching and build-time prerendering remain out of scope per the Development Server Decision — this milestone broadens the renderer, not the server's responsibilities.~~
- ~~Add end-to-end tests for nested static component trees (the motivating case: an imported component with static, immutable content), `{#if}`- and `{#each}`-bearing pages, state seeding across component boundaries, and mismatch fallback at every boundary; pin hydration operation counts in the benchmark suite.~~
- ~~Assess version impact before implementation: broadening the server and hydratable output contracts is expected to be an additive output-version change (syntax is unchanged); any compiler/output version bumps follow the Compatibility and Versioning contract and are recorded in the CHANGELOG.~~

**~~Done when:~~** ~~a page importing static child components and using `{#if}` and `{#each}` is fully server-rendered by `wizz dev`, hydrates in the browser without duplicate DOM or mismatch warnings, and the only remaining client-only pages are those the gate justifies with a located diagnostic for a genuinely undeliverable construct.~~

Implementation notes: the server target now renders `{#if}` (test re-evaluated against render-time state), `{#each}` (initial collection, item variable in scope), and component tags — a child tag renders by calling the child's own server module (`import * as __wizzServer_<Name> from "./<Name>.server.js"`, evaluated props via `buildComponentPropsSource`), and its serialized state rides under the framework-reserved `__wizz` key as `state.__wizz.components["<componentId>"]` (nested-nested slices nest the same way; the key is emitted only when the template contains component tags — a static presence check, so a tag in an untaken branch still emits it — keeping component-free pages byte-identical in state output; reactive names cannot start with `__wizz`, so the namespace is framework-owned). The eligibility gate broadened from "rejects blocks and components" to "is the whole tree statically renderable": `{#if}`/`{#each}` are always gate-eligible on the server target (each bodies keep the browser target's restrictions — one root element, no components, no `on:`), while a component tag requires `options.componentServerRenderable[name]` (a missing entry conservatively rejects). Because renderability of a component tag depends on the child's own template, eligibility is computed **bottom-up over the import graph at build level** (`computeServerEligibility` in `build.js`, memoized DAG walk over payload imports): a file is eligible iff its own `compileServer` and `compile({hydratable:true})` compile with each rendered import vouched by the child's own eligibility. `.server.js`/`.hydrate.js` are written for **every eligible file, pages and components alike**; ineligible files log one note chaining the deepest underlying reason (`Underlying reason: <child's own gate failure>`), and cyclic component imports report ineligibility (`its import graph contains a cycle.`) instead of recursing forever. Hydration extends across boundaries: `hydrateCreate` walks the same flattened child sequence the server emitted (branch selection re-evaluated against seeded state, comments stripped), adopts each-item roots positionally and rebuilds the records map with key-aware update closures (creating only the list anchor — an empty text node cannot survive HTML serialization), and adopts nested components through a new **additive public export `hydrateRoot(rootNode, props, state)`** (alongside `hydrateComponent`) that adopts the *given* node as the component root: the parent walk verifies only that the component-tag position holds an element, then runs `__wizzHydrate_<Name>.hydrateRoot(childNode, props, childSlice)` after its own walk passes, so `setProps` and nested teardown keep working and a mismatch at any depth remounts **inside the child's root** — never detaching anything from the parent or failing it. Component-tag walk refs are declared at `hydrateCreate` scope (a tag inside a branch is visited inside that branch, but the adoption block references the ref at function scope). Adjacency markers (`<!-- -->`) are emitted at branch boundaries in addition to the between-text rule (over-marking is harmless — the walk strips comments). Versions bumped to compiler 1.5.0 / syntax 1.1.0 / output 1.5.0: 1.4.0 was the additive broadening (previously-rejected templates now compile; default non-hydratable output is byte-identical apart from the header stamp), and 1.5.0 fixes the if-with-else traversal bug the broadened surface exposed — the parser's `children` alias repoints to the alternate at `{:else}`, so the dependency analyzer, ID assigner, and component-ref collector missed consequent content (no IDs/deps/refs for reactive elements and component tags in a taken-branch-with-else; all three traversals now walk both branches explicitly), which changes generated output for those templates. Known limitation: author scripts referencing browser globals are the author's responsibility — the gate passes but `renderComponent` fails at runtime and the dev server logs `Server rendering failed for /: …` and streams the plain shell, exactly as SvelteKit defers nondeterministic module state to the author. The showcase route demonstrates the escape hatch: `App.wizz` moved its `document.location.search` read behind `onMount`, so `/` now server-renders the "friend" default and the reactivity engine applies the query-param name after hydration (mount hooks run after state seeding on both client paths). Full suite: 414 tests.

## 15. Own the Document Head from Components

**Goal:** Give components ownership of document head metadata in the SvelteKit `svelte:head` direction: a page declares a `<wizz:head>` block containing `<title>`, `<meta>`, and `<link>` elements, server-delivered route documents carry that head server-side, and client navigations swap head content without duplicates or stale leftovers. Document-wide defaults (charset, favicon, base links) keep living in `index.html` — Wizz has no layout system, so head blocks are per-page declarations, not a wrapper component.

- ~~Add `<wizz:head>` as a special block in the parser and analyzer (colon spelling to match the existing `on:` directive convention): a `HeadBlock` node, not a literal element, so it never renders into body markup. Restrict children to `title`, `meta`, and `link` with located, file-aware diagnostics for anything else (`<wizz:style>` delivery is deliberately deferred to the styles milestone; reactive head updates are deliberately out of scope — head follows navigation, not state changes).~~
- ~~Allow the existing expression machinery inside head blocks: `<title>{title}</title>` text and dynamic attribute values (`content={description}`) evaluate at render time server-side and at mount time client-side, reusing the dynamic-attribute analyzer and the existing escape helpers.~~
- ~~Broaden the server target additively: `renderComponent()` returns a `head` field alongside `{ html, state }`; a child component's head bubbles up through its parent's render and concatenates in tree order — the same recursion pattern as `__wizz` state. The development server injects the page's head markup before `</head>` in the streamed document using function-form `String.replace` (string form corrupts `$`-sequences).~~
- ~~Add a small client head module to the runtime (owner-tagged head nodes): insert on mount, remove on destroy. The router's existing destroy cascade cleans up navigation for free, and hydration adopts server-delivered head nodes positionally instead of re-inserting, so a hydrated first render never duplicates head content.~~
- ~~Define the conflict policy deterministically: multiple `<title>` declarations resolve last-in-tree-wins with one development warning naming both locations; multiple `<meta>`/`<link>` elements concatenate (legal HTML). No silent first-wins.~~
- ~~Test end to end: head markup arrives in the streamed document for `wizz dev`, hydration adopts without duplicating, navigating between two pages with different titles swaps them (old nodes removed), conflicting titles warn, expression output is escaped, and illegal head children fail compilation with located diagnostics.~~
- ~~Assess version impact before implementation: new accepted component syntax (syntax version) and an additive server-render contract field (output version) are expected; follow the Compatibility and Versioning contract and record the bump in the CHANGELOG.~~

**~~Done when:~~** ~~a page declaring `<wizz:head>` delivers its title and meta server-side from `wizz dev`, hydration adopts the delivered head without duplicating it, in-app navigation swaps title/meta correctly (old page's head nodes removed), and a `<wizz:head>` containing an unsupported element fails compilation with a located diagnostic.~~

Implementation notes: the parser accepts exactly one root-level `<wizz:head>` per component (no attributes, no nesting, colon spelling matching `on:`), builds a `HeadBlock` node restricted to `title`/`meta`/`link` children (meta/link void; bare text, expressions, directives, and elements inside `<title>` all rejected with located diagnostics), and the extractor prunes it from the template AST before generation so body markup never sees it. Expressions inside head reuse the existing machinery: `<title>{title}</title>` runs as RCDATA text (static and dynamic segments coalesce into one escaped text write — titles never carry `<!-- -->` markers) and dynamic attributes (`content={description}`) use the tokenizer's `{name, value, dynamic}` shape; `on:` directives are skipped in both targets. The server target gains `hasHeadMarkup` (own head or any rendered component tag) as a static presence gate: when set, `renderComponent(props, options)` threads `options.headOwner` (page `'r'`, child `'r/<componentId>'`) so every emitted node carries `data-wizz-head-id` plus a `data-wizz-loc` (file-qualified when the compile carries `filePath`), collects markup in `__wizzHeadParts`, and returns the additive `head` field; a head-free component-free page keeps the exact old `{ html, state }` shape and byte-identical output. One deliberate deviation from the original plan: **no server-side title de-duplication** — dropping the page's own title from the delivered run would break per-owner slice verification (each component verifies its delivered nodes against compile-time expectations), so all titles are delivered and precedence is resolved client-side at mount time: `__wizzApplyHead`/`__wizzClaimHead` put the owning component's titles at the head front, the position `document.title` reads, so the deepest component's title wins and releasing it (destroy) lets the previous owner's title resume naturally — no shell-title strip needed either. The dev server only injects the run (`<!--wizz:head-start-->` + head + `<!--wizz:head-end-->` before `</head>`, function-form replace, skipped when empty). The client side is emitted under a `headActive` gate (own head, or hydratable rendering head-declaring children) so head-free modules are byte-identical apart from the header stamp: six flush-left helpers (`__wizzApplyHead` prepend-on-mount with the duplicate-title warning, `__wizzReleaseHead` destroy-time removal, `__wizzClaimHead` hydration ownership with title-fronting, `__wizzFindHeadRun`/`__wizzStripHeadRun` marker-run handling, `__wizzStripOwnedHeadSlice` per-owner fallback cleanup). Hydration verifies without creating DOM: compile-time expectation structures `{ tag, text, attrs: [[name, value]], flags: [[name, ''|null]] }` (pair arrays, not attr objects — no `__proto__` object-literal pollution) verify tag, coalesced title text, attributes, and boolean presence; the page reads the marker run filtered to its owner path while nested children scan `document.head` for their `'r/<id>'` slice (the page's claim removes delivery tags first, so filters cannot collide); success consumes the markers and returns `headNodes` for destroy-time release, and any mismatch — text, tag, attribute, boolean flag, count, or unclaimed leftover delivery tags — warns once and falls back by releasing claimed nodes, stripping the run (or the component's own slice), and remounting fresh inside the existing root, exactly like a body-tree mismatch. Client instances claim fresh owners `'h' + ++__wizzHeadOwnerSeq` per module (the tag is informational; slice lookup always uses server owner paths, which cannot collide). Head blocks are not dependency-analyzed (head expressions ride the same dynamic-attribute evaluation as body attributes), and reactive head updates remain out of scope: head follows navigation, not state changes — the `<wizz:style>` milestone delivers styles through this machinery. Versions bumped to compiler 1.6.0 / syntax 1.2.0 / output 1.6.0: new accepted component syntax plus the additive server `head` field and client head-management surface. The showcase `App.wizz` declares a `<wizz:head>` with an evaluated title and a dynamic `description` meta (computed in the author script — dynamic attributes accept only identifier/member expressions per the milestone 14 surface, so the ternary moved into script state). Full suite: 435 tests.

## 16. Scoped Component Stylesheets

**Goal:** ~~Make scoped component styles a first-class part of `.wizz` files through a `<wizz:style>` block (joining the `<wizz:head>` framework namespace): two components imported onto one page — each with its own `h2 { font-size }` rule — keep their own sizes, because every selector is scoped to its own component. Styles are delivered without a flash of unstyled content, never duplicated across pages, and extracted for production builds. The global style layer is deliberately *not* a framework feature: document-wide styles (resets, shared tokens) live in the document stylesheet as they do today, so `:global(...)` is deferred until a real need is shown.~~

- ~~Teach the tokenizer that `<wizz:style>` is a raw-text element (parallel to the existing `<script>` raw-text mode): CSS braces, colons, and quotes must never reach the template expression lexer — today `p { color: red; }` throws `Template Expression Error` because braces parse as template expressions. A plain `<style>` block in a component is rejected with a located diagnostic pointing to `<wizz:style>`, keeping the scoping contract explicit instead of silently inverting HTML's global-`<style>` meaning.~~
- ~~Analyze style content per component as opaque author text. Styles are trusted author input like scripts: expression output is not interpolated into CSS (values stay static), which sidesteps the injection class entirely. Both the server and client targets treat style blocks as non-body content — never rendered into `#app` markup.~~
- ~~Scope the styles: when a component has a `<wizz:style>` block, the analyzer stamps a generated scope attribute onto every element that component renders (riding the same attribute-stamping path as `data-wizz-id`, so the server emission, client `create()`, and hydration walk agree with no new verification logic). Components without a style block keep byte-identical markup.~~
- ~~Rewrite selectors with a minimal zero-dependency CSS scanner (the milestone's long pole — brace matching, string/comment awareness, `@media` descent; not a full CSS parser): each selector's terminal element gains the scope attribute (`h2 { … }` → `h2[data-wizz-s="<scope>"]`), and `@keyframes` names are scope-suffixed since keyframe names are document-global otherwise.~~
- ~~Deliver styles through the milestone 15 head machinery: the development server and hydration path hoist one deduped `<style>` per component module (deduped by module, not instance — a component imported by several pages must inject exactly once), and `wizz build` extracts all component styles into `dist/app.css` with a link tag in the copied document shell. This milestone therefore depends on milestone 15.~~
- ~~Add a `:global(...)` escape hatch as a follow-up bullet once scoped styles ship: paren-aware selector rewriting so a component can reach outside its scope. Deferred until a real need is shown; the document stylesheet covers today's global cases.~~
- ~~Test end to end: raw-text parsing (braces, quotes, `@media` blocks), the two-components-with-conflicting-`h2`-rules case, single injection across pages sharing a styled component, server-delivered styles with no duplicate after hydration, `wizz build` extraction, and failure states (unclosed `<wizz:style>`, plain `<style>` diagnostic, style blocks inside `{#each}` bodies).~~
- ~~Assess version impact before implementation: `<wizz:style>` acceptance is a syntax change; scoped markup (the scope attribute on styled components' elements) is an output-version change; extraction is build-level. Follow the Compatibility and Versioning contract and record the bump in the CHANGELOG.~~

**~~Done when:~~** ~~two components imported onto one page, each with its own `h2 { font-size }` rule, render with their own sizes applied from the first `wizz dev` load (server-delivered in the head, adopted on hydration without duplicates, never present in `#app` body markup), an unscoped `<h2>` in the page itself matches neither rule, and `wizz build` produces `dist/app.css` linked from the shell.~~

Implementation notes: the tokenizer treats `<wizz:style>` as a raw-text element (parallel to `<script>`, sharing the merged raw-text switch — which also fixed a latent `<script defer>` re-entry bug) and the parser builds a `StyleBlock` node restricted to one root-level, attribute-free block per component; a plain `<style>` element is rejected in both open and self-closing paths with a diagnostic pointing at `<wizz:style>` (`Plain <style> blocks are not supported — use <wizz:style> for scoped component styles at <line>:<col>.`), and the extractor prunes the block before generation. The scope is a deterministic FNV-1a + djb2 mix over the component's full source (base36, `s` prefix) computed with no compile options so server and client always agree. Scoping runs through a minimal zero-dependency CSS scanner (`scopeCss`): literal-aware brace/string/comment matching via a same-length mask so structure analysis never trips on CSS that only looks like markup, terminal-compound insertion (type/`*`/`&` selectors gain the attribute appended; class/id/attribute/pseudo terminals get it prepended), descent restricted to `@media`/`@supports`/`@container` (every other at-rule verbatim), `@keyframes` names scope-suffixed with `animation`/`animation-name` references rewritten in a second pass, and unclosed blocks preserved byte-faithfully via a `closed` flag rather than "fixed". The analyzer stamps `data-wizz-s` on every element before the reactive `data-wizz-id` check (an author-written `data-wizz-s` wins; imported component tags and style-free components are untouched). Delivery rides the milestone 15 head machinery with one deliberate design choice: **style tags carry no `data-wizz-head-id` delivery tag** — runtime scope dedup makes compile-time slice expectations impossible, and per-owner positional verification is untouched. The server target threads a `__wizzStyleScopes` accumulator (page-created, shared down through the component options argument) so each styled component injects exactly one `<style data-wizz-style data-wizz-loc>` per document regardless of how many pages import it; client `__wizzApplyHead` dedups by scope with `data-wizz-refs` refcounting (insert = 1, adoption/re-apply increment, `__wizzReleaseHead` decrements and removes at zero), and hydration adoption reuses the same apply path — delivered styles are refcounted, never recreated, and a hydration fallback's fresh apply adopts the delivered copy (a discarded probe node is created and never inserted, so head metrics count exactly one extra element on the styled hydrate path). CSS text is raw-text escaped (`<` → `\3c `, entities do not work inside `<style>`) so rules can never terminate the tag early. `wizz build` extracts every compiled component's scoped rules into `dist/app.css` through the same `scopeCss` (discovery order, per-file header comments, byte-stable) and copies the document shell — probing the input directory then its parent for the conventional `wizz build src dist` layout — injecting the `/app.css` link before `</head>` unless the author already linked it. `:global(...)` remains deferred. Versions bumped to compiler 1.7.0 / syntax 1.3.0 / output 1.7.0: new accepted component syntax plus scoped markup (`data-wizz-s` on styled components' elements) and the refcounted style surface in head management. The showcase demonstrates the motivating case live: `Card.wizz` and `Panel.wizz` each carry a conflicting `h2 { font-size }` rule on the Home page with an unscoped page-level `<h2>` matching neither, and `Counter.wizz` styles its button. Full suite: 502 tests.

## 17. Package the Framework for Release

**Goal:** Turn wizz.js from a framework you run from a repository checkout into a versioned artifact users can download and install: a `package.json`-defined package with a strict file surface, a license, CI that gates every change on the full test suite, and a tagged-release pipeline that produces the downloadable package — without adding a single runtime dependency to the framework (CI workflows may use GitHub-hosted tooling; the shipped package may not).

- Prune the showcase to the documented example: delete the progression-testing scratch files (`src/components/TestProps.wizz`, `src/pages/About.wizz`, `src/pages/Contact.wizz`, and the root `test.js` compile demo) and update the references that survive them (`scripts/ssr-demo.js` names About/Contact as the server-target rejection examples; `STRUCTURE.md` lists `test.js`; `README.md` tells readers to run it). Keep `src/pages/Home.wizz`, `Card.wizz`, `Panel.wizz`, `Counter.wizz`, and the root `index.html`/`App.css` shell — the live examples the documentation, the SSR demo, and the build's shell-copy logic read.
- Add `package.json`: a `bin` entry mapping `wizz` to `scripts/cli.js` (which already carries the node shebang), a `files` whitelist shipping only the compiler, runtime, `build.js`, the CLI and dev-server scripts, and the documentation — explicitly excluding the showcase, tests, and build output — `engines` pinned to Node 18+, zero dependencies, and a package version kept in lockstep with the compiler version.
- Add a LICENSE (the repository has none, which blocks any distribution) and reference it from the package metadata.
- Add an npm-pack smoke test asserting the tarball contains exactly the shipped surface: every whitelisted file present and none of the showcase, test, or `dist` paths anywhere in the archive.
- Add a CI workflow running the full `node --test` suite on every push and pull request across a Node 18/20/22 matrix, so the merge gate no longer depends on someone remembering to run the suite locally.
- Add a release workflow triggered by `v*` tags: run the full suite, `npm pack`, and attach the tarball to a GitHub Release as the downloadable artifact. Registry publication stays out of scope until there is an npm account decision.
- Rework `scripts/install-cli.sh` to install from a downloaded release tarball instead of copying the working tree — today it copies all of `src/`, demo pages included — while keeping a documented local-tree path for development installs.
- Assess version impact before implementation: this milestone is packaging and workflow only (no parsing, analysis, generation, or runtime changes are planned), so VERSIONS should stay at 1.7.0/1.3.0/1.7.0; any deviation must be justified in the implementation notes.

**Done when:** pushing a `v*` tag produces a GitHub Release with a downloadable tarball that passes the pack test; installing from that tarball on a clean machine yields working `wizz dev` and `wizz build` commands with no showcase or scratch files in the package; CI runs the suite on every pull request.

## 18. Scaffold Projects and Expose Structured Diagnostics

**Goal:** Give the CLI the two surfaces the ecosystem work depends on: a canonical way to create a project (`wizz init`) so "a Wizz application" has a defined shape, and machine-readable compiler diagnostics (stable codes plus a JSON output mode) so tooling — the future MCP server above all — never has to parse prose to know what failed.

- Add `wizz init [directory]`: scaffold the canonical project shape (document shell, `src/pages/`, `src/components/`, a minimal `Home.wizz` demonstrating hydration, and a styled stateful component demonstrating `<wizz:style>` plus state) so a fresh project runs correctly under both `wizz dev` and `wizz build` with no manual editing.
- Make init conservative by default: refuse to write into a non-empty directory unless explicitly overridden, never overwrite an existing file, and print exactly what it created.
- Add `wizz --version` printing the compiler/syntax/output triple from the version contract, so an installed user can see exactly what they have.
- Assign stable diagnostic codes to compiler diagnostics (parse, analyze, generate) while leaving the existing prose messages and locations untouched in human-facing output.
- Add a machine-readable diagnostics path: a compile option and a `wizz build --json` flag emitting structured diagnostics — code, severity, message, file, line/column — with a documented, versioned shape downstream tools can consume without string matching.
- Test everything adjacent to the code: init's file tree and refusal behaviors, the version triple, code stability across the existing diagnostic corpus, and the JSON shape for a deliberately broken component.
- Assess version impact before implementation: stable codes and a JSON shape are additive compiler behavior with no accepted-syntax change expected, so the syntax version likely holds; the compiler version moves only if the underlying pipeline changes.

**Done when:** `wizz init demo && cd demo && wizz dev` serves a working, styled, hydrated page on the first run and `wizz build` produces a correct `dist/`; every compiler diagnostic carries a stable code; and a JSON diagnostics dump for a deliberately broken component can be consumed without parsing prose.

## Later Ecosystem Work

Milestones 17 and 18 are the runway for this work: milestone 17 makes the framework a downloadable, CI-gated artifact, and milestone 18 defines the canonical project shape and a machine-readable diagnostics surface, so an MCP server and other tooling build on documented contracts instead of repository internals.

- **MCP:** Expose the Wizz project structure, component language contract, compiler diagnostics, build command, and development workflow through a Model Context Protocol server so AI agents can inspect an application and safely create or update Wizz web applications autonomously. Keep filesystem permissions explicit and project-scoped; do not make the core compiler depend on an AI runtime.
- **ORM:** Keep it separate from the core renderer/compiler so application persistence choices do not define component semantics.

## Development Server Decision

~~Keep using Python's `python3 -m http.server` for the current single-example demo. It is dependency-free, adequate for ES module loading, and avoids building tooling before the build output structure exists.~~

~~Do add a Node development server later, as part of milestone 5, because the framework will need a single command that understands Wizz's output directory, triggers compilation, watches source files, and provides SPA fallback for client-side routes. It can remain zero-dependency by using Node's built-in `node:http`, `node:fs`, and `node:path` modules.~~ Do not add an application backend server to the framework core; the development server should serve static build output only. Milestone 13 narrows this deliberately: route documents may be server-rendered through the milestone 12 compiler target, but the server still gains no API layer, request-time data fetching, sessions, or persistence — eligibility and delivery are compilation artifacts, not backend behavior.
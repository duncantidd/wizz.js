# Changelog

All notable changes to Wizz are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), adapted for this project's roadmap-driven workflow: work is grouped by roadmap milestone rather than by release, since nothing has shipped a numbered release yet. Everything below lives under **Unreleased**.

- **Added** for new features.
- **Changed** for changes in existing behavior.
- **Fixed** for bug fixes.
- **Docs** for documentation-only work.

## [Unreleased]

### Milestone 16 — Scoped Component Stylesheets

#### Added

- `<wizz:style>` blocks: a component may declare one top-level `<wizz:style>` block holding raw CSS text (a `StyleBlock` node, tokenized as a raw-text element parallel to `<script>` — CSS braces, colons, and quotes never reach the template expression lexer). The block is root-only, attribute-free, and mutually exclusive with elements/expression children per the parser guards; a second block, a nested block, a self-closing block with content, and any plain `<style>` element all fail compilation with a located, file-aware diagnostic pointing at `<wizz:style>`. The extractor prunes the block from the template AST before generation so it never renders into body markup, and the payload carries `style: { css, scope, loc }` (`src/compiler/parser/tokenizer.js`, `src/compiler/parser/templateParser.js`, `src/compiler/parser/extractor.js`, `src/compiler/parser/index.js`).
- Deterministic scope hashing: a component's scope is an FNV-1a + djb2 mix over its full source (`Math.imul(fnv ^ djb2, 0x27d4eb2d) >>> 0`, base36 with an `s` prefix), computed by `computeStyleScope(source)` with no compile options — server and client always agree on a component's scope regardless of build flags (`src/compiler/parser/index.js`).
- Minimal zero-dependency CSS scanner: `scopeCss(css, scope)` rewrites each selector's terminal compound — type selectors, `*`, and `&` gain the scope attribute appended (`h2 { … }` → `h2[data-wizz-s="<scope>"] { … }`), while `.class`, `#id`, `[attr]`, and pseudo-* terminals have it prepended — descending into `@media`/`@supports`/`@container` prelude blocks only (every other at-rule passes through verbatim). Brace matching, strings, and comments are literal-aware (a same-length mask keeps structure analysis honest while insertions preserve formatting), and `@keyframes` names are scope-suffixed with all `animation`/`animation-name` references rewritten to match. It is deliberately not a full CSS parser: unknown at-rules and malformed input are passed through rather than rejected (`src/compiler/analyzer/cssScanner.js`).
- Scope attribute stamping: when a component has a style block, the analyzer stamps `data-wizz-s="<scope>"` on every element that component renders (imported component tags excluded — they carry their own component's scope), riding the same attribute-stamping path as `data-wizz-id`; an author-written `data-wizz-s` wins over the generated value, and style-free components keep byte-identical markup (`src/compiler/analyzer/idAssigner.js`).
- Server style delivery: styled components inject one deduped `<style data-wizz-style="<scope>" data-wizz-loc="…">` per document — the server target threads a `__wizzStyleScopes` accumulator through component emission (page-created, shared with children via the options argument), so a component imported by several pages or rendered twice injects exactly once per document. Style tags ride the head run **without** a `data-wizz-head-id` delivery tag: runtime scope dedup makes compile-time slice expectations impossible, and the positional slice verification from milestone 15 is untouched. CSS text is escaped for raw-text delivery (`<` → `\3c `, entities do not work inside `<style>`) so a rule can never terminate the tag early. Styled-only components activate the head run gate (`src/compiler/generator/serverGenerator.js`).
- Client style dedup and refcounting: `__wizzApplyHead` dedups `<style>` nodes by their `data-wizz-style` scope attribute — a fresh insert sets `data-wizz-refs="1"`, finding an existing copy (delivered by the server, or applied by an earlier mount) increments the refcount and reuses it instead of duplicating — and `__wizzReleaseHead` decrements on destroy, removing the stylesheet at zero. Hydration adoption reuses the same apply path, so server-delivered styles are adopted (refcounted, never recreated) and a hydration fallback's fresh apply adopts the delivered copy too. Orphaned delivered styles (the component never mounts client-side) are harmless dead weight; remounts adopt rather than duplicate because dedup is scope-based, not owner-based (`src/compiler/generator/componentGenerator.js`, `src/compiler/generator/hydrationGenerator.js`).
- Production extraction: `wizz build` writes one `dist/app.css` carrying every compiled component's scoped rules in discovery order under per-file header comments (computed through the same `scopeCss` the generators use), and copies the project's document shell (probing the input directory, then its parent for the conventional `wizz build src dist` layout) with `<link rel="stylesheet" href="/app.css">` injected before `</head>` — leaving shells that already link `/app.css` untouched and shell-less projects on the old behavior with a logged note. Style-free projects write no stylesheet and copy the shell verbatim (`build.js`).

#### Changed

- The hydration generator's leftover-run check reads delivery tags loosely (`!= null`), so absent `data-wizz-head-id` attributes read as claimed identically in real DOMs (`null`) and test shims (`undefined`).
- The document shell is now copied into the output directory by `wizz build` (previously hand-placed); `wizz dev` continues to require it at serve time.

#### Fixed

- Editing a child component no longer requires restarting `wizz dev`: each rebuild stamps child `.server.js` import specifiers with a fresh `?v=<timestamp>-<sequence>` query (a new `moduleQuery` compile option threaded from the dev server through `buildProject`/`compileServer` into the server generator), because Node's module cache keys on the full URL and queries never propagate through static imports — without the stamp, a rebuild re-evaluated only the page module while its cached children kept serving the first build's stale markup, scope hashes, and styles. Production builds omit the option and emit clean specifiers, byte-identical to before.

#### Docs

- ROADMAP §16 records the implementation notes; the compiler READMEs document the `StyleBlock` node, the raw-text style mode, the CSS scanner, scope stamping, and the style delivery/refcounting contract; STRUCTURE.md and the CHANGELOG are synced.

### Milestone 15 — Own the Document Head from Components

#### Added

- `<wizz:head>` blocks: a component may declare one top-level `<wizz:head>` block containing only `<title>`, `<meta>`, and `<link>` elements (the parser produces a `HeadBlock` node that never renders into body markup, and extracts it from the template AST before generation). Anything else — nested elements, elements inside `<title>`, bare text or expressions outside `<title>`, attributes on `<wizz:head>` itself, a second head block, a closing tag on a void element — fails compilation with a located, file-aware diagnostic (`src/compiler/parser/templateParser.js`, `src/compiler/parser/extractor.js`).
- Server-rendered head output: `renderComponent()` returns an additive `head` field — the component's own head markup followed by each rendered child's head in tree order, every node tagged `data-wizz-head-id="<ownerPath>"` (page owner `'r'`, child `'r/<componentId>'`) and `data-wizz-loc="<filePath>:<line>:<col>"` when the compile carries a `filePath`. Title text and dynamic attribute values evaluate at render time through the existing escape helpers; a head-free component-free page returns exactly the old `{ html, state }` shape with byte-identical output (`src/compiler/generator/serverGenerator.js`).
- Development-server head injection: `renderServerRoute` now destructures `head` from `renderComponent()` and injects `<!--wizz:head-start-->` + head + `<!--wizz:head-end-->` before `</head>` (function-form `String.replace`; skipped when the head is empty). The markers delimit the delivered run so the client can locate, verify, and consume it. No title de-duplication happens server-side — per-owner slice verification on the client requires every component's nodes delivered verbatim; precedence is resolved at mount time instead (`scripts/dev.js`).
- Client head management, emitted only when a component has its own head or renders head-declaring children (`headActive` — otherwise the module is byte-identical apart from the header stamp): six flush-left helpers drive the lifecycle. Fresh mounts build head nodes (`createHeadNodes()`: title text via one `textContent` assignment, attributes via `setAttribute`, `on:` directives skipped), tag them `data-wizz-head="h<n>"`, prepend them to `document.head`, and release them on destroy — so the router's existing destroy cascade swaps heads on navigation for free. Because the freshly applied title is the document's first title element (the one `document.title` reads), the deepest mounted component's title wins, matching the conflict policy without any de-duplication (`src/compiler/generator/componentGenerator.js`).
- Hydration head adoption: `hydrateCreate` accepts the server owner path (`'r'`, `'r/1'`, …), reads the marker-delimited run (pages) or scans `document.head` (nested children), and verifies each claimed node against a compile-time expectation structure (tag, coalesced title text, attribute name/value pairs, boolean presence flags) **without creating DOM**. Success claims the slice — ownership re-tagged, delivery tags consumed, titles moved to the head front, markers removed; any mismatch (wrong text, wrong tag, wrong attribute, wrong count, or unclaimed leftover delivery tags) warns once and falls back: claimed nodes released, the delivered run (or the component's own slice) stripped, and the component remounts fresh inside its existing root exactly like a body-tree mismatch. `hydrateRoot` threads the child's owner path (`'r/<componentId>'`) down to child adoptions (`src/compiler/generator/hydrationGenerator.js`).
- Title conflict policy: multiple `<title>` declarations resolve last-in-tree-wins with one development warning naming both locations (`Existing: <loc> Latest: <loc>`), fired from both mount (`__wizzApplyHead`) and claim (`__wizzClaimHead`). `<meta>`/`<link>` concatenate (legal HTML). Because claimed titles move to the head front on both mount and adoption paths, the last-declared title in tree order is the first title element — deterministic precedence with no silent first-wins.

#### Docs

- ROADMAP §15 records the implementation notes; compiler READMEs document the `HeadBlock` node, the additive `head` field, and the head helpers' runtime contract; STRUCTURE.md gains the head ownership summary.

### Milestone 14 — Render the Full Template Surface Server-Side

#### Added

- Recursive server rendering of component tags: the server target now renders an imported component by calling the child's own server module (`import * as __wizzServer_<Name> from "./<Name>.server.js"`, evaluated props at the tag position), so a page's delivered markup embeds its components' rendered HTML exactly where the tags appear. Child state snapshots serialize under the framework-reserved `__wizz` key as `state.__wizz.components["<componentId>"]` (nested trees nest the same way); the key is emitted only when the template contains component tags (a static presence check, so a tag in an untaken branch still emits it), keeping component-free state output byte-identical to milestone 12. Reactive names cannot start with `__wizz`, so the namespace stays framework-owned (`src/compiler/generator/serverGenerator.js`).
- `{#if}` and `{#each}` render server-side: the initially-taken branch is selected by re-evaluating the test against render-time state, and each lists render the initial collection with the item variable in scope. Each bodies keep the browser target's restrictions (exactly one root element, no components, no `on:` directives). Adjacency markers are now also emitted at branch boundaries so the browser cannot merge text across a branch boundary (`src/compiler/generator/serverGenerator.js`).
- Bottom-up eligibility over the import graph: `build.js` computes server-rendering eligibility bottom-up with a memoized DAG walk over each payload's component imports — a file is eligible when its own `compileServer` and `compile({ hydratable: true })` compile with every rendered import vouched for by the child's own eligibility. Eligible **component files** now also ship `<Name>.server.js` and `<Name>.hydrate.js` beside their client module (the milestone 13 "components never ship server builds" rule flips deliberately: a page's server module imports its components' server modules). Ineligible files log one note chaining the deepest underlying reason (`Underlying reason: <child's own gate failure>`), and cyclic component imports are reported as ineligibility (`its import graph contains a cycle.`) instead of recursing forever (`build.js`, exported as `computeServerEligibility`).
- Nested hydration through a new additive public export: hydratable modules now export **`hydrateRoot(rootNode, props, state)`** alongside `hydrateComponent` (`mountInstance(target, props, hydrate, state, adoptSelf)` internally). `hydrateRoot` adopts the *given* node as the component root; the parent's adoption walk verifies only that the component-tag position holds an element, then adopts the child through the child's own hydratable module seeded with the state slice under `__wizz.components`. Reactive prop bindings re-apply through `setProps`, and a mismatch at any depth remounts **inside the child's root** — nothing is detached from the parent and the parent never fails. The adoption walk flattens if/each sequences (branch tests re-evaluated against seeded state), adopts each items positionally while rebuilding the records map with key-aware update closures so client list updates mutate adopted nodes, and creates only the list anchor (an empty text node cannot survive HTML serialization) (`src/compiler/generator/hydrationGenerator.js`).

#### Fixed

- A component tag inside an `{#if}` branch had its hydration walk ref declared inline inside the generated branch block while the adoption block after the walk references it at function scope — hydrating such a page threw `ReferenceError`. Component-tag refs are now pre-allocated at `hydrateCreate` scope (`src/compiler/generator/hydrationGenerator.js`).
- The template parser's `IfBlock.children` alias repoints to the alternate at `{:else}`, so the dependency analyzer, ID assigner, and the component-ref collector all walked consequent content only in blocks *without* an else branch: expressions in a taken-branch-with-else got no dependency metadata, reactive elements got no `data-wizz-id`, and component tags got no `componentId` (surfacing as `Component <Counter> is missing its componentId` on any page with an imported component inside an `{#if}`-with-else). All three traversals now walk `consequent` and `alternate` explicitly (`src/compiler/analyzer/dependencyAnalyzer.js`, `src/compiler/analyzer/idAssigner.js`, `src/compiler/generator/domGenerator.js`).

#### Changed

- Showcase route `/` now server-renders: `App.wizz` moved its top-level `document.location.search` read (which failed `renderComponent()` at runtime in Node and streamed the plain shell) behind `onMount`. The server target's `onMount` is a no-op, so the page delivers the `"friend"` default server-side; mount hooks run after state seeding on both client paths, so the reactivity engine applies the query-param name after hydration.
- Compiler and generated-output contracts bumped to 1.5.0 (component syntax stays 1.1.0): previously-rejected templates (blocks, component tags with eligible import graphs) now compile; default non-hydratable `compile()` output stays byte-identical apart from the version header stamp. `compileServer(source, options)` and `compile(source, { hydratable: true })` gain the gate options `componentServerRenderable` (import names vouched for by their child's eligibility; a missing entry conservatively rejects that tag) and `componentIneligibilityReasons` (child gate failures chained into the diagnostic). The 1.4.0 → 1.5.0 step fixes the if-with-else traversal bug above, which changes generated output (corrected IDs, dependency flags, and component refs) for if-with-else templates.

#### Docs

- README's server-rendering section documents the recursive surface, bottom-up eligibility, the chained ineligibility note, and the `hydrateRoot` nested-adoption contract; ROADMAP §14 records the implementation notes including the author-script limitation (browser globals in author scripts fail `renderComponent()` at runtime and stream the plain shell).

### Milestone 13 — Serve Server-Rendered Routes from the Development Server

#### Added

- Build emission for server rendering: `build.js` compiles every route page (`App.wizz` and `src/pages/*`, resolved by `getRoutePath`) through both milestone 12 server targets and emits `dist/pages/Home.server.js` (compileServer output, no source map) and `dist/pages/Home.hydrate.js` (hydratable compile, with source map when the page has reactive markers) beside the byte-unchanged client module. Non-route files (`src/components/*.wizz`) never attempt server emission. Eligibility is decided by compiling both server targets before writing either: a client-compile failure remains a build failure, while a server-target failure after a successful client compile is treated as the server-renderability gate — the page stays client-only and the build logs one `Note: server rendering skipped for <file> — <reason> Serving the client build only.` note (never an error). This preserves the invariant that a delivered state script always implies a hydratable build exists.
- Route manifest fields: `dist/runtime/routes.js` page entries gain `serverModulePath` and `hydratableModulePath` (dist-relative POSIX paths) for eligible pages, `null` otherwise. Builds never clean `dist/`, so the manifest — not file existence — is authoritative for eligibility; a page whose server build becomes ineligible leaves its old artifacts orphaned and ignored.
- Dev-server delivery: `scripts/dev.js` resolves document requests against the generated manifest per request (the `JSON.stringify` array literal in `routes.js` is parsed synchronously — no cached route table, so a render can never be stale after a watch rebuild). For a matching route with a server module it imports the module cache-busted by file mtime, calls `renderComponent()`, and streams the document shell with the rendered HTML inside `#app` and `serializeInitialState()` output as its sibling script. Injection uses function-form `String.replace` so `$&`/`$'`/`$$` sequences in rendered HTML cannot corrupt the document. Route matching mirrors the client router exactly (exact pathname, routes lowercased at build time), so unmatched paths, ineligible routes, unknown assets (HTTP 404), and the SPA fallback behave byte-for-byte as before; any render failure logs `Server rendering failed for <route>: …` and falls back to the plain shell.
- Runtime hydration on first load: `src/runtime/main.js` builds a `hydratableRoutes` map from non-null manifest fields and passes it to the router. `src/runtime/router.js` hydrates only on the first render: it finds `script[type="application/wizz-state"]` beside the mount point, removes it after reading, imports the route's `hydrateComponent`, and adopts the delivered markup — the standard client module is never loaded on this path. Unreadable state, a missing hydratable build, or failed adoption drops the server markup and mounts fresh, never a duplicate DOM; server markup is likewise dropped before a first-render not-found render. A monotonic `renderSequence` token checked after every `await` abandons a render superseded by a newer navigation, which also fixes a pre-existing double-mount race when `popstate` fires while a route import is in flight.

#### Changed

- No version bump: compiler sources and both generated module contracts are untouched — the manifest and runtime entry are unversioned build/runtime artifacts, and eligibility is a build-time decision, not a compiler behavior change.

#### Docs

- README's server-rendering section documents the native `wizz dev` delivery recipe; `scripts/ssr-demo.js` remains the manual application-owned reference. Browser support adds the runtime hydration requirements (`Document.querySelector()`, `Element.remove()`) and removes a stale duplicate `Browser Support` section that still claimed no SSR or hydration.

- Reactive DOM updates are now scoped to each mounted component root rather than the whole document. Imported components can therefore reuse local `data-wizz-id` values without their event-driven updates overwriting reactive nodes in a parent or sibling component.

### Milestone 12 — Add Server-Side Rendering

#### Added

- Server compilation target: `compileServer(source, { filePath })` in `src/compiler/index.js` runs the standard pipeline (`parseComponent` → `analyzeDependencies` → `assignNodeIds`) and emits a self-contained ES module with no DOM dependency. It exports `renderComponent(props = {})` returning `{ html, state }` — the HTML string plus a snapshot of the component's reactive non-prop state — and `serializeInitialState(state)`, which renders the delivery script `<script type="application/wizz-state">…</script>` with every `<` escaped so hostile state content cannot close the tag early. Server output carries no source map: server output is an HTML string evaluated at request time, not a positional DOM artifact.
- The server target accepts a deliberately narrow v1 surface: the root element, static markup, text interpolations, dynamic attributes, and top-level props. Templates using `{#if}`, `{#each}`, component tags, void elements with children, reactive names matching `__proto__` or the reserved `__wizz` prefix, or malformed `on:` directives fail the compile with located, file-aware diagnostics (`src/compiler/generator/serverGenerator.js`). The author's top-level script executes verbatim and trusted on both targets; event handlers and lifecycle hooks are client-only (on the server target `onMount`/`onDestroy` are collected but never invoked, and `on:` attributes are skipped).
- HTML string escaping: text output escapes `&`, `<`, `>`; attribute values additionally escape `"`. Dynamic `value`/`checked`/`disabled` render as `checked`/`disabled` bare attributes only when truthy and always render `value`; void elements (`br`, `input`, …) never emit self-closing syntax so browser parsing preserves the exact node layout. Adjacent text-like children are separated by `<!-- -->` markers — Wizz templates cannot contain comments, so the marker is unambiguous — because browsers would otherwise merge adjacent text nodes and break the positional `childNodes[<index>]` targeting `update()` relies on.
- Hydration: `compile(source, { hydratable: true })` gates the component against the same server-renderable surface and emits an additional `hydrateComponent(target, props, state)` named export alongside the unchanged default `mountComponent` (`src/compiler/generator/hydrationGenerator.js` + `src/compiler/generator/componentGenerator.js`). Hydration adopts the mount point's first element and verifies it positionally against the template AST — lowercased tag names, stripped comment markers, exact child-node counts, `data-wizz-id` values read from the AST attribute, and text contents re-evaluated against the seeded state. Event listeners are collected during the walk and attached only after it passes. Any mismatch produces exactly one `console.warn('[wizz] hydration mismatch: … Falling back to client rendering.')`, clears the mount point, and falls back to a full client mount; a hostile `__proto__` key in the state object cannot pollute prototypes (seeding uses `Object.prototype.hasOwnProperty.call` + bracket access, and props are never seeded).
- End-to-end coverage: `test/hydration.test.js` renders the `test/fixtures/hydration.wizz` component on the server, delivers its markup and state script into a DOM shim with a browser-faithful HTML parser, hydrates with zero `createElement`/`createTextNode` calls, verifies byte-identical markup round-tripping and entity decoding, drives event-driven reactive updates on the adopted nodes, and covers the mismatch fallbacks (tampered text, empty or mistagged mount point, injected whitespace) plus prototype-pollution and escaping-boundary cases. The benchmark suite pins hydration operation counts: zero DOM creation, one initial reactive text write, and one targeted lookup per reactive variable (`test/benchmarks.test.js`).
- `{#if}` and `{#each}` block nodes now record their source location (`loc`) so server-target rejections point at the directive (`src/compiler/parser/templateParser.js`).

#### Changed

- Compiler and generated-output contracts bumped to 1.3.0 (component syntax stays 1.1.0): the compiler gains an explicit server target and an opt-in `hydratable` flag, and the output contract additively gains the optional `hydrateComponent(target, props, state)` export on hydratable modules. Default `compile()` output is unchanged — byte-for-byte — and is now pinned by an exact-string regression test.
- `generateComponent(astPayload, options)` accepts an options object; the existing single-argument call shape is unaffected.



### Milestone 11 — Build a VS Code Extension (in progress)

#### Added

- Initial first-party VS Code extension in `vscode-extension/`: `.wizz` language registration, TextMate syntax highlighting, language configuration, file-watch and save-triggered compiler diagnostics, Go to Definition for default component imports, route-aware page navigation, and command-palette integration for the stable `wizz build` and `wizz dev` commands.
- Focused Node tests for compiler-diagnostic location parsing, component-import target resolution, and CLI command routing. The extension host uses only VS Code's supplied `vscode` module and Node built-ins, keeping the core compiler and runtime dependency-free.

#### Fixed

- Added the `Run Wizz Extension` Extension Development Host launch configuration at both the repository root and extension folder, which opens the Wizz project automatically, and clarified that editor features are available in the separate development-host window, not in the extension source window.
- Removed redundant activation-event declarations now generated by VS Code from the extension's language and command contributions.

### Docs

- Clarified that the managed `wizz` CLI is a copied installation: rerun `./scripts/install-cli.sh` after pulling compiler, runtime, build, or CLI changes, while ordinary `.wizz` source edits do not require reinstalling.

### Milestone 10 — Add Component Props

#### Added

- Component props: a child declares inputs with `export let name = <default>;` (or a bare `export let count;` for `undefined`) and a parent passes them as attributes on an imported component tag. Static attributes pass their string, bare attributes pass `true`, and dynamic attributes pass the evaluated expression; the child factory receives an explicit props object — `mountComponent(target, props = {})` — so instances never read ambient parent state.
- Reactive prop updates: the parent's generated `update()` delivers changes through guarded `component_<id>.setProps({ prop: value })` calls on factory-scope instance references, so children rerender in place through their own batched scheduler without remounting, and child identity is stable across parent rerenders. `setProps()` skips destroyed children, ignores undeclared keys, compares with `Object.is` so identical updates are free, and re-applies the declared default when the parent explicitly passes `undefined`.
- Read-only props: any statement-level mutation of a prop name (`name = x`, `name++`, `name += x`, `name.prop = x`) is a compile-time error with a source location, enforced by a new `findReactiveMutations()` export from the assignment interceptor that shares the syntax-aware scanner. Function parameters and block-scoped `let`/`const`/`var` declarations now shadow reactive names for their scope, so locally shadowed names can be mutated without triggering the check or a spurious update notification.
- Prop extraction: a new `src/compiler/parser/propExtractor.js` finds `export let` statements on the scriptLexer token stream, records `{ name, defaultValue }` in declaration order, and removes the statements from the raw script. Extents are syntax-aware, so strings, template literals, comments, and regex literals cannot hide a semicolon or a nested `export`; non-`let` exports, multi-declarator statements, missing semicolons, statement-swallowing extents, reserved names (`props`, `__proto__`, strict-mode reserved words, and the framework-reserved `__wizz` prefix) are all compile-time errors with locations.
- Analyzer component identity: `assignNodeIds()` now assigns a sequential `componentId` to imported component tags (never `data-wizz-id`, since component tags create no DOM), giving the generated `create()` and `update()` a shared factory-scope instance reference.
- Conditional-branch updates: the update generator now walks `{#if}` branches, so reactive text, dynamic attributes, and component props inside conditional branches participate in updates. Previously the analyzer assigned them `data-wizz-id` targets but no update code was ever emitted for them.
- Tests: prop extraction and invalid-syntax coverage, prop dependency and componentId analyzer coverage, props-object emission and setProps routing in both generators, executed-module tests for the props contract (defaults, missing props, read-only enforcement, `Object.is` deduplication, undefined-default reapplication, teardown no-ops, a regression for a prop named `value` that once collided with a generated local), and mounted end-to-end tests in `test/componentProps.test.js` covering static/dynamic/boolean props, defaults, nested prop chains, identity preservation, teardown cascades, and build-time rejection of invalid prop syntax.

#### Changed

- Versions bumped under the documented policy: component syntax 1.0.0 → 1.1.0 (prop declarations and attributes on component tags are additive syntax), generated output 1.1.0 → 1.2.0 (`mountComponent(target, props)` signature, optional `setProps()` handle member, prop bindings, and component instance references are additive), compiler 1.1.0 → 1.2.0.
- `scriptLexer.js` moved from `src/compiler/generator/` to `src/compiler/` as a shared compiler-root utility alongside `errorAugmenter.js` and `sourceMapGenerator.js`, because both the parser (prop extraction) and the generator (assignment interception) now consume it. Import paths updated; no behavior change.
- Component tags previously rejected all attributes ("does not support attributes or children"); they now accept attributes as props and still reject children, `on:*` directives, and `__proto__` prop names.

### Milestone 7 — Production Hardening (in progress)

#### Added

- Compatibility and versioning policy: `src/compiler/version.js` exports a frozen `VERSIONS` table with `compiler`, `syntax`, and `output` semver entries. `compile()` returns the versions a component was compiled with, every generated module is stamped with a first-line header (`// Generated by Wizz 1.1.0 (component syntax 1.0.0, generated output 1.1.0). Edits will be overwritten.`), and the generated-output contract surface (`mountComponent(target)`, the returned `{ destroy() }` handle, and the `__wizz*` root-node properties) is pinned by a test so any breaking codegen change fails the suite until the version is bumped deliberately. Documented in the READMEs under "Compatibility and Versioning".
- Syntax-aware JavaScript handling: a new `scriptLexer.js` tokenizes component script (strings, template literals with nested `${}` interpolations, comments, regex literals with a regex-vs-division heuristic matching real engines, multi-character operators, radix and BigInt numbers) while preserving source offsets, and `assignmentInterceptor.js` was rewritten to decide rewrites on the token stream with a context stack instead of character scanning.
- Reactive mutations are now rewritten inside function and arrow callback bodies: `onMount(() => { status = "ready"; })`, `setTimeout(() => { count = 1 }, 100)`, event handlers, object methods, getters/setters, class methods, async and generator functions, IIFEs, `switch` cases, and `try`/`catch`/`finally` blocks all notify the scheduler. Previously these passed through unrewritten because parentheses hid their bodies.
- Parameter shadowing: function, arrow, and `catch` parameters shadow component state, so mutations of parameter names inside their own bodies (`items.map(count => { count = 1; })`) are left alone; suppression ends when the body closes.
- Automatic semicolon insertion: semicolon-less statements are intercepted correctly, including statements that end at a newline and prefix/postfix `++`/`--` across line breaks.
- 67 interceptor tests and 25 lexer tests covering the capability and safety matrix, including executed generated scripts verifying `queueUpdate({ count: true })` dispatch.
- Benchmark fixtures and deterministic regression tests: 1,000 repeated event updates must schedule one update and make one reactive DOM lookup/write; 25 listener-heavy mount/destroy cycles must remove every tracked listener; and a 121-element static tree must mount without reactive lookups. The tests report local durations without using unstable timing thresholds.
- Browser support and deployment contract: Wizz documents its evergreen ES-module browser baseline, required browser APIs, no-polyfill/SSR boundary, and HTTP(S) serving requirement. Security guidance now makes the trusted-component-code boundary, dynamic-attribute validation responsibility, development-server limits, production hosting/CSP responsibility, and source-map source exposure explicit. Generated-code assumptions document DOM ownership, single-use destruction, cleanup responsibility, and the current document-wide reactive-ID limitation.

#### Changed

- Compiler version bumped to 1.1.0 and generated-output contract to 1.1.0 (component syntax stays 1.0.0) under the new bump rules: the interceptor change is an additive capability, not a breaking one.
- The interceptor's non-interception boundary is now deliberate and documented: assignments in expression position (call arguments, conditions, object literals, class field initializers, template `${}` interpolations), unbraced `if`/`else`/`while`/`do` bodies, chained assignments beyond the first target, and destructuring pass through untransformed, and any statement whose extent cannot be established confidently is never rewritten — a missed interception is acceptable, corrupted output is not.

#### Fixed

- Division followed by a regular expression no longer corrupts output. The old character scanner treated `average = total / count;` followed by `const re = /x = 5/;` as one unterminated regex region and merged the statements, placing the update notification after the wrong statement.

### Milestone 8 — Promote a Public CLI (in progress)

#### Added

- Managed local `wizz` installation without npm or a package registry: `scripts/install-cli.sh` copies the required runtime to an XDG data directory and installs a launcher in an XDG bin directory. `wizz build` delegates to the existing project compiler with `src` and `dist` defaults, `wizz build <input-directory> <output-directory>` accepts explicit paths, and `wizz dev` delegates to the existing development server for the directory where it is invoked. Command parsing rejects unknown commands, incomplete build paths, and unsupported dev arguments with actionable usage guidance.
- CLI stability contract: the installed `wizz` interface is the supported automation surface, while direct Node entry points remain implementation details. Build failures, invalid commands, invalid argument combinations, and missing development document shells exit non-zero with actionable errors; `wizz dev` validates `index.html` before it opens a server.
- Command-level tests cover command parsing, the conventional default build, explicit build paths, development-server delegation, propagated build failures, missing document shells, and a managed local installation in an isolated home directory.

### Milestone 9 — Generate File-Based Routes

#### Added

- File-based browser routing: every build generates `dist/runtime/routes.js` from `src/App.wizz` and `.wizz` files below `src/pages`. The browser runtime builds lazy dynamic imports from that manifest rather than using a repository-owned route table.
- Route conventions: `App.wizz` or `pages/index.wizz` maps to `/`; nested page paths map to lowercase URL segments; nested `index.wizz` maps to its containing directory.
- Build validation rejects duplicate normalized routes and `/runtime`-prefixed routes, reporting the component paths involved. Rebuilds regenerate the manifest, so deleted pages no longer claim a route.
- Build and runtime tests cover manifest generation, root and nested paths, direct page loads, lazy imports, collisions, reserved paths, and page removal.

#### Fixed

- Development watching now includes a 250 ms source-file polling fallback alongside native events. This keeps `wizz dev` rebuilds reliable on mounted filesystems such as WSL's `/mnt/c` when native file notifications are missed.

### Milestone 6 — Expand Core Component Features Deliberately

#### Added

- Event directives: `on:<event>={handler}` compiles to native `addEventListener()` bindings. A handler may be a component-local function or any non-empty listener expression, such as `(event) => increment(event.detail)`.
- Dynamic attributes and properties: brace-valued attribute expressions update on reactive changes; `value`, `checked`, and `disabled` use property assignment while other dynamic attributes use HTML attributes.
- Conditional rendering: `{#if condition}` / `{:else}` blocks with generated update code.
- List rendering with keyed reconciliation: `{#each items as item (item.key)}` for object collections, plus a keyless positional form `{#each list as item}` for primitive arrays using index-based keys. Each blocks must be nested inside a native element and contain exactly one native root element; event directives and nested `{#if}`/`{#each}` blocks inside a body are compile-time errors rather than silently dropped or stale-closing code.
- Component imports: a `.wizz` component can import another `.wizz` component and use it as a tag. The build rewrites the import to the compiled module, imported tags mount as child components, and destroying a parent destroys all mounted children.
- Lifecycle hooks: `onMount(hook)` and `onDestroy(hook)` are provided by the generated closure with no import needed. Mount hooks run after the DOM is attached, child components are mounted, and the initial render completes; destroy hooks run at the start of `destroy()` while the DOM is still attached.
- Scheduler batching: `queueUpdate()` merges change flags into a pending set and flushes exactly one `update()` pass per microtask, so one handler mutating several reactive variables produces one DOM update. Calls before mounting completes are ignored, and a pending batch is cancelled by `destroy()`.
- Tracked listener cleanup: listeners Wizz attaches through `on:` directives are registered in a factory-scope registry and removed during `destroy()`.

### Milestone 5 — Add a Wizz Development Command

#### Added

- `node scripts/dev.js`: one command that runs the project build, serves the output directory over HTTP using Node's built-in modules (zero dependencies), and reports the local URL and compilation errors cleanly.
- Watch mode: source files are watched and changed `.wizz` files are rebuilt. (The dev server caches compiler modules in memory, so restart it after changing compiler code under `src/compiler`.)
- SPA fallback: unknown non-file requests return `index.html` so direct navigation to a client-side route works.

### Milestone 4 — Add Minimal Client-Side Routing

#### Added

- Explicit route table (not file-based routing) mapping paths to dynamic component imports.
- Route resolution from `window.location.pathname` to a component module, with a not-found component for unmatched paths.
- `navigate()` helper using `history.pushState()` with rerender, plus `popstate` handling so browser Back and Forward mount the expected component without a page reload.
- Teardown contract: the currently mounted component is destroyed before the next one mounts.
- Tests for route resolution, teardown, not-found behavior, and history navigation.

### Milestone 3 — Define the Application Entry Contract

#### Added

- `index.html` is a document shell only: it supplies `<div id="app"></div>` and loads one module entry instead of importing an example component inline.
- Browser entry module `src/runtime/main.js` that locates the mount target and reports a missing target.
- The build emits runtime modules into the output directory alongside compiled components.

### Milestone 2 — Make the Build Script a Project Compiler

#### Added

- `node build.js src dist`: compiles every `.wizz` file below the input directory, recursively, preserving relative paths (`src/pages/Home.wizz` → `dist/pages/Home.js`) and creating missing output directories.
- Independent compilation: every file is compiled and every failure is reported with its file path; the process exits non-zero when one or more files fail.
- Source protection: source files are never overwritten and the source directory is never used as build output.
- Tests using a temporary fixture tree covering nested inputs, successful output, and invalid components.

### Milestone 1 — Stabilize the Compiler Contract

#### Added

- Single public compiler API: `compile(source, { filePath })` runs parsing, dependency analysis, node ID assignment, and generation, returning the generated module source, the analyzed payload, and version information.
- Compiler errors include the input file path as well as source location when compilation is initiated from a file.
- End-to-end fixtures that compile representative `.wizz` components and execute the generated module against a minimal DOM.

#### Changed

- The script transformation boundary is documented as deliberately scoped: the assignment interceptor is not a JavaScript parser, and the docs must not represent it as one. (Superseded in Milestone 7 by the syntax-aware rewrite, which keeps the same never-corrupt-valid-JavaScript guarantee.)

#### Docs

- Parser, analyzer, generator, and their README files are kept synchronized whenever behavior changes.

### Project foundation (pre-roadmap)

#### Added

- The compiler pipeline itself: component parser, state scanner and dependency analyzer, node ID assigner (`data-wizz-id` attributes for update targeting), DOM/update generators, code builder, and the original assignment interceptor.

## Test status

The suite stands at 304 passing tests (compiler, generator, build, dev server, and runtime) as of 2026-09-06, with one pre-existing failure: `build.test.js`'s "rejects colliding page routes" writes `Home.wizz` and `home.wizz` into the same directory, which cannot coexist on a case-insensitive filesystem such as default macOS, so the collision never materializes there. Run it with:

```bash
node --test "src/**/*.test.js" build.test.js "test/**/*.test.js"
```

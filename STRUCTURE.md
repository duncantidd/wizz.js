# Project Structure

Wizz currently consists of a zero-dependency, build-time compiler written in Node.js. It transforms a component source string into a mountable ES module that creates and updates DOM with platform-native browser APIs, or — through the explicit `compileServer()` target — into a DOM-free server module that renders the same component surface (including imported components, `{#if}` branches, and `{#each}` lists) to escaped HTML strings for browser hydration.

```text
.
├── STRUCTURE.md                         Project map and compiler pipeline
├── ROADMAP.md                           Ordered development milestones
├── CHANGELOG.md                         Notable changes, grouped by milestone
├── package.json                         npm package definition (zero dependencies, files whitelist, bin wizz)
├── packaging.test.js                    Package lockstep, tarball surface, and workflow pins plus a packed-install end-to-end test
├── LICENSE                              MIT license
├── .github/workflows/                   CI (Node 18/20/22 matrix) and v* tag release pipelines
├── .vscode/launch.json                  Repository-root Extension Development Host debug profile
├── vscode-extension/                    First-party VS Code language and project tooling
│   ├── extension.js                      Extension-host activation, diagnostics, navigation, and commands
│   ├── services.js                       Pure diagnostic/import utility functions
│   ├── language-configuration.json      Wizz bracket, comment, and pairing behavior
│   ├── syntaxes/wizz.tmLanguage.json    TextMate grammar for Wizz source
│   ├── scripts/pack.js                   Zero-dependency .vsix packer (CRC-32, zip writer, escaped vsix manifest)
│   ├── scripts/pack.test.js              Round-trip, manifest, escaping, and refusal tests for the packer
│   ├── .vscode/launch.json              Extension Development Host debug profile
│   └── test/services.test.js             Focused Node tests for extension utilities
├── scripts/
│   ├── cli.js                            Public wizz init/build/dev/update/install-vscode-extension/version command dispatcher
│   ├── dev.js                            Builds, serves dist (server-rendering eligible routes), and watches .wizz source files
│   ├── init.js                           wizz init scaffolding with conservative refusals (all-or-nothing, never overwrites)
│   ├── initTemplates.js                  Showcase starter templates scaffolded by wizz init
│   ├── releaseAssets.js                  Shared GitHub release resolution and asset download for the release-backed commands
│   ├── update.js                         wizz update: fetches the latest release tarball and swaps the managed installation (rollback-capable)
│   ├── installVscodeExtension.js         wizz install-vscode-extension: probes code first, then downloads and installs the release vsix
│   ├── ssr-demo.js                       Manual zero-dependency SSR delivery reference (milestone 12; wizz dev now delivers natively)
│   ├── install-cli.sh                    Installs wizz from a release tarball (default) or --local from the working tree
│   ├── cli.test.js                       Focused Node tests for the CLI dispatcher
│   ├── init.test.js                      Focused Node tests for init, including the serve-and-build done-when
│   ├── initTemplates.test.js             Template compile targets for both compiler targets
│   ├── releaseAssets.test.js             Fake GitHub API server tests for release resolution and downloads
│   ├── update.test.js                    Fake-install and real-tarball tests: swaps, refusals, locks, and rollback
│   ├── installVscodeExtension.test.js    Probe-first, PATH-stubbed code, and cleanup tests
│   └── install-cli.test.js               Focused Node tests for the installer (tarball, --local, and refusal paths)
├── test/
│   ├── componentImports.test.js          Builds component-importing pages and delivers/hydrates them through the real generated modules
│   ├── hydration.test.js                 Renders server HTML, hydrates it, and pins mismatch fallbacks
│   ├── benchmarks.test.js                 Benchmark-fixture operation-count regressions
│   ├── dev.test.js                       Development server and SPA fallback tests
│   ├── endToEnd.test.js                 Compiles fixture components and executes them against a minimal DOM
│   └── fixtures/                        Representative .wizz components loaded from disk by the e2e suite
└── src/
  └── compiler/
      ├── index.js                     Public compile(source) and compileServer(source) entry point
      ├── version.js                   Compatibility contract versions (compiler, syntax, output)
      ├── diagnostics.js               Frozen stable diagnostic code catalog (WIZZ-P###/WIZZ-G###) and the code-stamping helper
	├── errorAugmenter.js            Adds file paths, source excerpts, code frames, and structured line/column to compiler errors
	├── sourceMapGenerator.js        Maps copied author script lines back to Wizz source
	├── scriptLexer.js               Shared script tokenizer for syntax-aware statement extents
      ├── parser/                      1. Component source -> parser handoff
	  ├── README.md                 Parser contracts and module reference
	  ├── index.js                  Public parseComponent() entry point
	  ├── tokenizer.js              Template markup tokenizer
	  ├── templateParser.js         Token stream -> template AST
	  ├── expressionLexer.js        Interpolation expression tokenizer
	  ├── prattParser.js            Expression token stream -> expression AST
	  ├── integrator.js             Attaches expression ASTs to template nodes
	  ├── extractor.js              Extracts and removes <script> from template AST
	  ├── componentImportExtractor.js Extracts default .wizz imports from component scripts
	  ├── propExtractor.js          Extracts export let prop declarations from component scripts
	  ├── stateScanner.js           Recognizes script declarations and persist(key, default) persistent-state markers
	  └── *.test.js                 Focused Node tests for each parser module
	├── analyzer/                    2. Parser handoff -> reactive metadata
	│   ├── README.md                 Analyzer contracts and module reference
	│   ├── dependencyAnalyzer.js     Tags expressions with reactive dependencies
	│   ├── idAssigner.js             Adds data-wizz-id to reactive DOM targets and componentId to component tags
	│   ├── cssScanner.js             Minimal zero-dependency CSS scoping (scopeCss) for wizz:style blocks
	│   └── *.test.js                 Focused Node tests for analyzer modules
	├── generator/                   3. Analyzed payload -> ES module source
	  ├── README.md                 Generator contracts and module reference
	  ├── codeBuilder.js            Indented source-code builder
	  ├── domGenerator.js           Emits create() DOM construction function
	  ├── updateGenerator.js        Emits update() reactive text and prop-update functions
	  ├── assignmentInterceptor.js  Syntax-aware rewriter for reactive script mutations
	  ├── persistInitializer.js     Splices persist(key, default) markers into target-specific initializers
	  ├── serverGenerator.js        Emits the server-side HTML string renderer and the static-renderability gate (blocks, components, escaping)
	  ├── hydrationGenerator.js     Emits the hydrateComponent()/hydrateRoot() DOM adoption walk
	  ├── componentGenerator.js     Emits the mountable default-export module
	  └── *.test.js                 Focused Node tests for generator modules
	└── runtime/                     Browser application entry modules
	  ├── main.js                   Builds route and hydratable-route loaders and starts the router
	  └── router.js                 Resolves routes, hydrates on first load, mounts views, and handles history
```

`src/compiler/index.test.js` and `src/compiler/errorAugmenter.test.js` hold the focused Node tests for the public `compile()` contract and its file-path error behavior.

`test/benchmarks.test.js` compiles representative benchmark fixtures and pins operation-count regressions for batched repeated updates, tracked-listener teardown, a 121-element static tree, and hydration's zero-DOM-creation adoption walk. It reports local timings without enforcing machine-dependent time limits.

`test/hydration.test.js` exercises the full server-render → deliver → hydrate → update → destroy cycle: `compileServer()` renders the hydration fixture to HTML plus a serialized state script, a browser-faithful HTML parser places the markup in a mount point, the `hydratable` client module adopts it without creating any nodes, and event-driven reactive updates land on the adopted DOM. Tampered text, empty or mistagged mount points, and injected whitespace each produce exactly one mismatch warning followed by a clean client-render fallback. The same file pins the head cycle end to end: a delivered `wizz:head` run (marker-delimited in the document head, tagged with owner paths) is adopted with zero created nodes, claimed (ownership re-tagged, titles fronted, markers consumed), and released on destroy so a static shell title resumes; a tampered delivered title strips the run and remounts a fresh head with no duplicates.

Milestone 15's `<wizz:head>` blocks give components ownership of the document head: the parser produces a pruned `HeadBlock` (title/meta/link only, located diagnostics otherwise), the server target returns the additive `head` field beside `{ html, state }` with per-owner delivery tags, the dev server injects the run before `</head>`, and the client mounts/releases head nodes per component instance — the router destroy cascade swaps heads on navigation for free, and hydration adopts the delivered head by verifying compile-time expectation structures without creating DOM (mismatch strips and remounts fresh, body and head alike).

`src/runtime/main.js` and `src/runtime/router.js` are copied to `dist/runtime/` by `build.js`, which also generates `dist/runtime/routes.js` from `src/App.wizz` and the `src/pages` tree and assembles the document set: the shell (`index.html`, found in the input directory or its parent) is copied with the extracted `app.css` link injected before `</head>`, and a global `App.css` beside the located shell ships too — the dev server copies it the same way, so the shell's `./App.css` link resolves in production builds (a shell-less project copies neither). Eligibility is computed bottom-up over the import graph (`computeServerEligibility`): every file whose own server and hydratable targets compile with all rendered imports vouched for by their children ships `<name>.server.js` (milestone 12 server renderer, extended to blocks and component tags) and `<name>.hydrate.js` (hydratable client build) — pages *and* imported components, since a page's server module imports its components' server modules. The route manifest advertises the builds per page via `serverModulePath`/`hydratableModulePath`, or `null` for pages that fail the gate; ineligible files log one note chaining the deepest underlying reason. The entry module finds `<div id="app"></div>`, builds lazy route and hydratable-route loaders from that manifest, and starts the router. On the first render the router adopts server-delivered markup by reading the sibling `script[type="application/wizz-state"]` and importing the route's `hydrateComponent` (dropping the markup and mounting fresh when the payload is unreadable, the hydratable build is absent, or adoption fails); afterwards it dynamically imports the component for the current path, destroys the previously mounted component before replacement, renders a not-found view for unmatched paths, and rerenders after history navigation. A monotonic render token abandons renders superseded by newer navigation. The document shell loads the entry module rather than importing an application component itself.

`scripts/install-cli.sh` provides the managed local installation path without npm. It copies the runtime to `${XDG_DATA_HOME:-~/.local/share}/wizz` and installs a `wizz` launcher in `${XDG_BIN_HOME:-~/.local/bin}`. The launcher delegates to `scripts/cli.js`: `wizz init [directory] [--force]` scaffolds the canonical starter project (refusing non-empty directories without `--force` and never overwriting existing files), `wizz build` compiles the conventional `src` directory into `dist` (`--json` in any position prints the machine-parsable `wizz-build-diagnostics@1` envelope of structured diagnostics instead of prose), `wizz build <input-directory> <output-directory>` passes both explicit directories to the project compiler, `wizz dev` starts the existing development workflow in the directory where the command is invoked, `wizz update` resolves the latest GitHub release through `scripts/releaseAssets.js`, downloads its tarball, and swaps the managed installation with rollback (refusing to downgrade a locally newer install and serializing concurrent updates with an advisory lock), `wizz install-vscode-extension` probes for the `code` command before any download and installs the release's `wizz-vscode-<version>.vsix` through it, and `wizz --version` prints the compiler/contract version triple. The release-backed commands resolve asynchronously: `runCli` returns a promise of an exit code that the entry block settles into `process.exitCode`. The public CLI validates commands and argument combinations, propagates build failures through a non-zero exit code, and requires the project's `index.html` before opening a development server. `node scripts/dev.js` runs a project build for `src` into `dist`, copies the document shell and stylesheet into `dist`, serves that directory at `http://localhost:3000`, and watches `.wizz` files with native events plus a 250 ms polling fallback for mounted filesystems. It returns `index.html` for unknown extensionless paths so client-side routes can load directly, while missing asset paths return HTTP 404. For document requests matching a manifest route whose `serverModulePath` is non-null, it instead imports the server module (cache-busted by file mtime), renders the page with `renderComponent()`, and streams the shell with the rendered HTML inside the `#app` mount point plus the serialized state script as its sibling — when the page declares `<wizz:head>` (or renders head-declaring children), the returned `head` markup is injected between `<!--wizz:head-start-->`/`<!--wizz:head-end-->` markers before `</head>` for the client to adopt or strip — eligibility comes from the fresh manifest per request, so watch rebuilds take effect immediately and any render failure falls back to the plain shell.

The generated component module contains its own small `create()` and `update()` functions, alongside the component author's script and a `{ setProps?, destroy() }` API. Imported components are mounted with an explicit props object (`mountComponent(target, props = {})`); reactive prop changes are delivered to mounted child instances through `setProps()`.

A `let name = persist(key, default)` declaration keeps every reactive behavior and adds persistence: the parser records the marker with its storage key and default (`stateScanner`, which also rejects markers outside top-level `let` initializers — inside a block or function body, or nested in another `persist()` default — and lets an author-defined `persist` binding opt out of marker recognition; `propExtractor` rejects `persist()` on props), and the generators rewrite the initializer per target — client modules read storage through `__wizzPersistRead`, write statement mutations back through `__wizzPersistWrite`, and subscribe the mount through `__wizzPersistSubscribe` on a per-page `globalThis.__wizzStateBus` bus (BroadcastChannel delivery with a storage-event fallback, storage reads/writes guarded as untrusted input); server modules render the declared default and snapshot the value for hydration, whose adoption walk verifies the delivered markup against the delivered state before the initial update pass syncs the adopted markup to the stored value. Subscriptions unregister on destroy, and components without persistent declarations emit no persistence machinery at all.

## Compilation Pipeline

`compile(source)` is the primary public compiler entry point. It runs the full pipeline and returns the mountable ES module source together with the final analyzed handoff payload:

```text
Wizz component source
	-> compile(source, { filePath })
	-> { source, payload, sourceMap }
```

`compileServer(source, { filePath })` runs the same parse and analysis stages but emits a DOM-free server module exporting `renderComponent(props, options)` (returning `{ html, state }`, plus the additive `head` field when a `<wizz:head>` block or rendered head-declaring child is present) and `serializeInitialState(state)`. It always returns `sourceMap: null` — server output is an HTML string with no positional DOM artifact to map — and restricts the component to the statically renderable surface: the root element, static markup, text interpolations, dynamic attributes, top-level props, the initially-taken `{#if}` branch, `{#each}` lists, and imported component tags when each import is vouched for through the `componentServerRenderable` option (a missing entry rejects that tag; `componentIneligibilityReasons` chains the child's own failure into the diagnostic). Compiling the same component with `compile(source, { hydratable: true })` adds `hydrateComponent(target, props, state)` and `hydrateRoot(rootNode, props, state)` exports that adopt the delivered markup in the browser, verify it positionally against the template AST (including if/each sequences and nested components), and fall back to a full client mount on any mismatch.

When `options.filePath` is supplied (for example by `build.js`, which compiles files read from disk), compiler failures identify the file as well as their source location: location references in the message become file-qualified, followed by a source excerpt and caret code frame. The thrown error carries `error.filePath`, `error.sourceExcerpt`, and `error.codeFrame` programmatically when a location is available. Messages without a location are prefixed with the path and do not receive a frame. Without the option, error messages keep their original source-only locations.

For a file-backed component with an author `<script>`, `compile()` also returns a v3 `sourceMap` that maps copied script lines to their original Wizz coordinates and embeds the original source. `build.js` writes the map beside the generated module and adds the corresponding `sourceMappingURL` directive. Framework scaffolding and template-generated code remain intentionally unmapped until the generator records precise per-emission locations.

Internally it composes the three compiler stages in order:

```text
Wizz component source
	-> parseComponent(source)
	-> { template, script, rawScript, head }
	-> analyzeDependencies(payload)
	-> expression nodes gain dependencies
	-> assignNodeIds(payload)
	-> reactive parent elements gain data-wizz-id attributes
	-> generateComponent(payload)
	-> mountable ES module source
```

1. **Parse:** Converts markup into a template AST, parses interpolation expressions, extracts `<script>` content, and scans recognized state declarations.
2. **Analyze:** Connects reactive `let` declarations to the interpolation expressions that read them, then assigns DOM-targeting IDs to their direct parent elements.
3. **Generate:** Emits framework-free JavaScript that creates the DOM tree, renders reactive text initially, updates it when the generated `changed` flags are set, and exposes `destroy()`.

## Current Entry Points

- `src/compiler/index.js` exports `compile(source, options)` and `compileServer(source, options)`, the public entry points that run parsing, analysis, ID assignment, and the requested generator — optionally in `diagnostics: 'collect'` mode, which returns structured diagnostic records instead of throwing.
- `src/compiler/diagnostics.js` exports the frozen stable diagnostic code catalog (`CODES`), the `WIZZ-P###`/`WIZZ-G###` format pattern, and `compilerDiagnostic(code, message, ErrorConstructor)`, the helper every author-facing compiler throw uses to stamp its code.
- `src/compiler/errorAugmenter.js` exports `augmentErrorWithFile(error, filePath, source, options)`, which implements the file-aware diagnostic contract used by `compile()` and stamps structured `error.line`/`error.column` fields, and `buildDiagnosticRecord(error, filePath, source)`, which builds the collect-mode record shape.
- `src/compiler/sourceMapGenerator.js` creates the author-script v3 source map returned by file-backed `compile()` calls.
- `src/compiler/parser/index.js` exports `parseComponent(source)`.
- `src/compiler/analyzer/dependencyAnalyzer.js` exports `analyzeDependencies(payload)`.
- `src/compiler/analyzer/idAssigner.js` exports `assignNodeIds(payload)`.
- `src/compiler/analyzer/cssScanner.js` exports `scopeCss(css, scope)`, the minimal CSS scoping pass shared by the server, client, and build style outputs.
- `src/compiler/generator/componentGenerator.js` exports `generateComponent(payload, options)`.
- `src/compiler/generator/serverGenerator.js` exports `generateServerComponent(payload, options)` and the shared `assertServerRenderable(payload, options)` surface gate.
- `src/compiler/generator/hydrationGenerator.js` exports `generateHydrationFunction(templateAST)`, the `hydrateComponent()`/`hydrateRoot()` adoption-walk emitter.
- `test.js` demonstrates the complete pipeline and prints the generated module source.

## Validation

Each compiler stage has adjacent Node tests, and `test/endToEnd.test.js` compiles the fixture components in `test/fixtures/` and executes the generated modules against a minimal DOM. Run all current compiler tests from the repository root with:

```bash
node --test
```

For detailed current behavior, language support, generated-code contracts, and known boundaries, see the README in each compiler stage directory.
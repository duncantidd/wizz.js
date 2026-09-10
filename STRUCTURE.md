# Project Structure

Wizz currently consists of a zero-dependency, build-time compiler written in Node.js. It transforms a component source string into a mountable ES module that creates and updates DOM with platform-native browser APIs, or — through the explicit `compileServer()` target — into a self-contained server module that renders the same component surface to escaped HTML strings for browser hydration.

```text
.
├── STRUCTURE.md                         Project map and compiler pipeline
├── ROADMAP.md                           Ordered development milestones
├── CHANGELOG.md                         Notable changes, grouped by milestone
├── .vscode/launch.json                  Repository-root Extension Development Host debug profile
├── vscode-extension/                    First-party VS Code language and project tooling
│   ├── extension.js                      Extension-host activation, diagnostics, navigation, and commands
│   ├── services.js                       Pure diagnostic/import utility functions
│   ├── language-configuration.json      Wizz bracket, comment, and pairing behavior
│   ├── syntaxes/wizz.tmLanguage.json    TextMate grammar for Wizz source
│   ├── .vscode/launch.json              Extension Development Host debug profile
│   └── test/services.test.js             Focused Node tests for extension utilities
├── scripts/
│   ├── cli.js                            Public wizz build/dev command dispatcher
│   ├── dev.js                            Builds, serves dist (server-rendering eligible routes), and watches .wizz source files
│   ├── ssr-demo.js                       Manual zero-dependency SSR delivery reference (milestone 12; wizz dev now delivers natively)
│   └── install-cli.sh                    Managed local installation script for wizz
├── test.js                              End-to-end compilation example
├── test/
│   ├── componentImports.test.js          Builds and mounts nested imported Wizz components
│   ├── hydration.test.js                 Renders server HTML, hydrates it, and pins mismatch fallbacks
│   ├── benchmarks.test.js                 Benchmark-fixture operation-count regressions
│   ├── dev.test.js                       Development server and SPA fallback tests
│   ├── endToEnd.test.js                 Compiles fixture components and executes them against a minimal DOM
│   └── fixtures/                        Representative .wizz components loaded from disk by the e2e suite
└── src/
  └── compiler/
      ├── index.js                     Public compile(source) and compileServer(source) entry point
      ├── version.js                   Compatibility contract versions (compiler, syntax, output)
	├── errorAugmenter.js            Adds file paths, source excerpts, and code frames to compiler errors
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
	  ├── stateScanner.js           Recognizes script declarations
	  └── *.test.js                 Focused Node tests for each parser module
	├── analyzer/                    2. Parser handoff -> reactive metadata
	│   ├── README.md                 Analyzer contracts and module reference
	│   ├── dependencyAnalyzer.js     Tags expressions with reactive dependencies
	│   ├── idAssigner.js             Adds data-wizz-id to reactive DOM targets and componentId to component tags
	│   └── *.test.js                 Focused Node tests for analyzer modules
	├── generator/                   3. Analyzed payload -> ES module source
	  ├── README.md                 Generator contracts and module reference
	  ├── codeBuilder.js            Indented source-code builder
	  ├── domGenerator.js           Emits create() DOM construction function
	  ├── updateGenerator.js        Emits update() reactive text and prop-update functions
	  ├── assignmentInterceptor.js  Syntax-aware rewriter for reactive script mutations
	  ├── serverGenerator.js        Emits the server-side HTML string renderer and v1-surface gate
	  ├── hydrationGenerator.js     Emits the hydrateComponent() DOM adoption walk
	  ├── componentGenerator.js     Emits the mountable default-export module
	  └── *.test.js                 Focused Node tests for generator modules
	└── runtime/                     Browser application entry modules
	  ├── main.js                   Builds route and hydratable-route loaders and starts the router
	  └── router.js                 Resolves routes, hydrates on first load, mounts views, and handles history
```

`src/compiler/index.test.js` and `src/compiler/errorAugmenter.test.js` hold the focused Node tests for the public `compile()` contract and its file-path error behavior.

`test/benchmarks.test.js` compiles representative benchmark fixtures and pins operation-count regressions for batched repeated updates, tracked-listener teardown, a 121-element static tree, and hydration's zero-DOM-creation adoption walk. It reports local timings without enforcing machine-dependent time limits.

`test/hydration.test.js` exercises the full server-render → deliver → hydrate → update → destroy cycle: `compileServer()` renders the hydration fixture to HTML plus a serialized state script, a browser-faithful HTML parser places the markup in a mount point, the `hydratable` client module adopts it without creating any nodes, and event-driven reactive updates land on the adopted DOM. Tampered text, empty or mistagged mount points, and injected whitespace each produce exactly one mismatch warning followed by a clean client-render fallback.

`src/runtime/main.js` and `src/runtime/router.js` are copied to `dist/runtime/` by `build.js`, which also generates `dist/runtime/routes.js` from `src/App.wizz` and the `src/pages` tree. For each route page the build also emits `<page>.server.js` (milestone 12 server renderer) and `<page>.hydrate.js` (hydratable client build) when the page compiles through both server targets; the manifest advertises them per entry via `serverModulePath`/`hydratableModulePath`, or `null` for pages that fail the server-renderability gate. The entry module finds `<div id="app"></div>`, builds lazy route and hydratable-route loaders from that manifest, and starts the router. On the first render the router adopts server-delivered markup by reading the sibling `script[type="application/wizz-state"]` and importing the route's `hydrateComponent` (dropping the markup and mounting fresh when the payload is unreadable, the hydratable build is absent, or adoption fails); afterwards it dynamically imports the component for the current path, destroys the previously mounted component before replacement, renders a not-found view for unmatched paths, and rerenders after history navigation. A monotonic render token abandons renders superseded by newer navigation. The document shell loads the entry module rather than importing an application component itself.

`scripts/install-cli.sh` provides the managed local installation path without npm. It copies the runtime to `${XDG_DATA_HOME:-~/.local/share}/wizz` and installs a `wizz` launcher in `${XDG_BIN_HOME:-~/.local/bin}`. The launcher delegates to `scripts/cli.js`: `wizz build` compiles the conventional `src` directory into `dist`, `wizz build <input-directory> <output-directory>` passes both explicit directories to the project compiler, and `wizz dev` starts the existing development workflow in the directory where the command is invoked. The public CLI validates commands and directory-argument combinations, propagates build failures through a non-zero exit code, and requires the project's `index.html` before opening a development server. `node scripts/dev.js` runs a project build for `src` into `dist`, copies the document shell and stylesheet into `dist`, serves that directory at `http://localhost:3000`, and watches `.wizz` files with native events plus a 250 ms polling fallback for mounted filesystems. It returns `index.html` for unknown extensionless paths so client-side routes can load directly, while missing asset paths return HTTP 404. For document requests matching a manifest route whose `serverModulePath` is non-null, it instead imports the server module (cache-busted by file mtime), renders the page with `renderComponent()`, and streams the shell with the rendered HTML inside the `#app` mount point plus the serialized state script as its sibling — eligibility comes from the fresh manifest per request, so watch rebuilds take effect immediately and any render failure falls back to the plain shell.

The generated component module contains its own small `create()` and `update()` functions, alongside the component author's script and a `{ setProps?, destroy() }` API. Imported components are mounted with an explicit props object (`mountComponent(target, props = {})`); reactive prop changes are delivered to mounted child instances through `setProps()`.

## Compilation Pipeline

`compile(source)` is the primary public compiler entry point. It runs the full pipeline and returns the mountable ES module source together with the final analyzed handoff payload:

```text
Wizz component source
	-> compile(source, { filePath })
	-> { source, payload, sourceMap }
```

`compileServer(source, { filePath })` runs the same parse and analysis stages but emits a self-contained server module exporting `renderComponent(props)` (returning `{ html, state }`) and `serializeInitialState(state)`. It always returns `sourceMap: null` — server output is an HTML string with no positional DOM artifact to map — and restricts the component to the server-renderable surface: `{#if}`, `{#each}`, component tags, and event-driven features fail the compile with located diagnostics. Compiling the same component with `compile(source, { hydratable: true })` adds a `hydrateComponent(target, props, state)` export that adopts the delivered markup in the browser, verifies it positionally against the template AST, and falls back to a full client mount on any mismatch.

When `options.filePath` is supplied (for example by `build.js`, which compiles files read from disk), compiler failures identify the file as well as their source location: location references in the message become file-qualified, followed by a source excerpt and caret code frame. The thrown error carries `error.filePath`, `error.sourceExcerpt`, and `error.codeFrame` programmatically when a location is available. Messages without a location are prefixed with the path and do not receive a frame. Without the option, error messages keep their original source-only locations.

For a file-backed component with an author `<script>`, `compile()` also returns a v3 `sourceMap` that maps copied script lines to their original Wizz coordinates and embeds the original source. `build.js` writes the map beside the generated module and adds the corresponding `sourceMappingURL` directive. Framework scaffolding and template-generated code remain intentionally unmapped until the generator records precise per-emission locations.

Internally it composes the three compiler stages in order:

```text
Wizz component source
	-> parseComponent(source)
	-> { template, script, rawScript }
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

- `src/compiler/index.js` exports `compile(source, options)` and `compileServer(source, options)`, the public entry points that run parsing, analysis, ID assignment, and the requested generator.
- `src/compiler/errorAugmenter.js` exports `augmentErrorWithFile(error, filePath, source)`, which implements the file-aware diagnostic contract used by `compile()`.
- `src/compiler/sourceMapGenerator.js` creates the author-script v3 source map returned by file-backed `compile()` calls.
- `src/compiler/parser/index.js` exports `parseComponent(source)`.
- `src/compiler/analyzer/dependencyAnalyzer.js` exports `analyzeDependencies(payload)`.
- `src/compiler/analyzer/idAssigner.js` exports `assignNodeIds(payload)`.
- `src/compiler/generator/componentGenerator.js` exports `generateComponent(payload, options)`.
- `src/compiler/generator/serverGenerator.js` exports `generateServerComponent(payload)` and the shared `assertServerRenderable(payload)` surface gate.
- `src/compiler/generator/hydrationGenerator.js` exports `generateHydrationFunction(templateAST)`, the `hydrateComponent()` adoption-walk emitter.
- `test.js` demonstrates the complete pipeline and prints the generated module source.

## Validation

Each compiler stage has adjacent Node tests, and `test/endToEnd.test.js` compiles the fixture components in `test/fixtures/` and executes the generated modules against a minimal DOM. Run all current compiler tests from the repository root with:

```bash
node --test
```

For detailed current behavior, language support, generated-code contracts, and known boundaries, see the README in each compiler stage directory.
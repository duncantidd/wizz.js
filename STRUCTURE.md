# Project Structure

Wizz currently consists of a zero-dependency, build-time compiler written in Node.js. It transforms a component source string into a mountable ES module that creates and updates DOM with platform-native browser APIs.

```text
.
├── STRUCTURE.md                         Project map and compiler pipeline
├── scripts/
│   └── dev.js                            Builds, serves dist, and watches .wizz source files
├── test.js                              End-to-end compilation example
├── test/
│   ├── componentImports.test.js          Builds and mounts nested imported Wizz components
│   ├── dev.test.js                       Development server and SPA fallback tests
│   ├── endToEnd.test.js                 Compiles fixture components and executes them against a minimal DOM
│   └── fixtures/                        Representative .wizz components loaded from disk by the e2e suite
└── src/
  └── compiler/
      ├── index.js                     Public compile(source) entry point
      ├── errorAugmenter.js            Qualifies compiler errors with the component file path
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
	  ├── stateScanner.js           Recognizes script declarations
	  └── *.test.js                 Focused Node tests for each parser module
	├── analyzer/                    2. Parser handoff -> reactive metadata
	│   ├── README.md                 Analyzer contracts and module reference
	│   ├── dependencyAnalyzer.js     Tags expressions with reactive dependencies
	│   ├── idAssigner.js             Adds data-wizz-id to reactive DOM targets
	│   └── *.test.js                 Focused Node tests for analyzer modules
	├── generator/                   3. Analyzed payload -> ES module source
	  ├── README.md                 Generator contracts and module reference
	  ├── codeBuilder.js            Indented source-code builder
	  ├── domGenerator.js           Emits create() DOM construction function
	  ├── updateGenerator.js        Emits update() reactive text function
	  ├── assignmentInterceptor.js  Scoped rewriter for reactive script mutations
	  ├── componentGenerator.js     Emits the mountable default-export module
	  └── *.test.js                 Focused Node tests for generator modules
	└── runtime/                     Browser application entry modules
	  ├── main.js                   Declares application routes and starts the router
	  └── router.js                 Resolves routes, mounts views, and handles history
```

`src/compiler/index.test.js` and `src/compiler/errorAugmenter.test.js` hold the focused Node tests for the public `compile()` contract and its file-path error behavior.

`src/runtime/main.js` and `src/runtime/router.js` are copied to `dist/runtime/` by `build.js`. The entry module defines an explicit route table, finds `<div id="app"></div>`, and starts the router. The router dynamically imports the component for the current path, destroys the previously mounted component before replacement, renders a not-found view for unmatched paths, and rerenders after history navigation. The document shell loads the entry module rather than importing an application component itself.

`node scripts/dev.js` runs a project build for `src` into `dist`, copies the document shell and stylesheet into `dist`, serves that directory at `http://localhost:3000`, and watches `.wizz` files for full rebuilds. It returns `index.html` for unknown extensionless paths so client-side routes can load directly, while missing asset paths return HTTP 404.

The generated component module contains its own small `create()` and `update()` functions, alongside the component author's script and a `destroy()` API.

## Compilation Pipeline

`compile(source)` is the single public compiler entry point. It runs the full pipeline and returns the mountable ES module source together with the final analyzed handoff payload:

```text
Wizz component source
	-> compile(source, { filePath })
	-> { source, payload }
```

When `options.filePath` is supplied (for example by `build.js`, which compiles files read from disk), compiler failures identify the file as well as their source location: location references in the message become file-qualified (`Unclosed tag <main> starting at src/pages/Home.wizz:1:1.`), messages without a location are prefixed with the path, and the thrown error carries the path programmatically as `error.filePath`. Without the option, error messages keep their original source-only locations.

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

- `src/compiler/index.js` exports `compile(source, options)`, the single public entry point that runs parsing, analysis, ID assignment, and generation.
- `src/compiler/errorAugmenter.js` exports `augmentErrorWithFile(error, filePath)`, which implements the file-path error contract used by `compile()`.
- `src/compiler/parser/index.js` exports `parseComponent(source)`.
- `src/compiler/analyzer/dependencyAnalyzer.js` exports `analyzeDependencies(payload)`.
- `src/compiler/analyzer/idAssigner.js` exports `assignNodeIds(payload)`.
- `src/compiler/generator/componentGenerator.js` exports `generateComponent(payload)`.
- `test.js` demonstrates the complete pipeline and prints the generated module source.

## Validation

Each compiler stage has adjacent Node tests, and `test/endToEnd.test.js` compiles the fixture components in `test/fixtures/` and executes the generated modules against a minimal DOM. Run all current compiler tests from the repository root with:

```bash
node --test
```

For detailed current behavior, language support, generated-code contracts, and known boundaries, see the README in each compiler stage directory.
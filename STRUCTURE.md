# Project Structure

Wizz currently consists of a zero-dependency, build-time compiler written in Node.js. It transforms a component source string into a mountable ES module that creates and updates DOM with platform-native browser APIs.

```text
.
├── STRUCTURE.md                         Project map and compiler pipeline
├── test.js                              End-to-end compilation example
└── src/
		└── compiler/
				├── parser/                      1. Component source -> parser handoff
				│   ├── README.md                 Parser contracts and module reference
				│   ├── index.js                  Public parseComponent() entry point
				│   ├── tokenizer.js              Template markup tokenizer
				│   ├── templateParser.js         Token stream -> template AST
				│   ├── expressionLexer.js        Interpolation expression tokenizer
				│   ├── prattParser.js            Expression token stream -> expression AST
				│   ├── integrator.js             Attaches expression ASTs to template nodes
				│   ├── extractor.js              Extracts and removes <script> from template AST
				│   ├── stateScanner.js           Recognizes script declarations
				│   └── *.test.js                 Focused Node tests for each parser module
				├── analyzer/                    2. Parser handoff -> reactive metadata
				│   ├── README.md                 Analyzer contracts and module reference
				│   ├── dependencyAnalyzer.js     Tags expressions with reactive dependencies
				│   ├── idAssigner.js             Adds data-wizz-id to reactive DOM targets
				│   └── *.test.js                 Focused Node tests for analyzer modules
				└── generator/                   3. Analyzed payload -> ES module source
						├── README.md                 Generator contracts and module reference
						├── codeBuilder.js            Indented source-code builder
						├── domGenerator.js           Emits create() DOM construction function
						├── updateGenerator.js        Emits update() reactive text function
						├── componentGenerator.js     Emits the mountable default-export module
						└── *.test.js                 Focused Node tests for generator modules
```

There is no standalone `src/runtime` directory yet. The current generated component module contains its own small `create()` and `update()` functions, alongside the component author's script and a `destroy()` API.

## Compilation Pipeline

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

- `src/compiler/parser/index.js` exports `parseComponent(source)`.
- `src/compiler/analyzer/dependencyAnalyzer.js` exports `analyzeDependencies(payload)`.
- `src/compiler/analyzer/idAssigner.js` exports `assignNodeIds(payload)`.
- `src/compiler/generator/componentGenerator.js` exports `generateComponent(payload)`.
- `test.js` demonstrates the complete pipeline and prints the generated module source.

## Validation

Each compiler stage has adjacent Node tests. Run all current compiler tests from the repository root with:

```bash
node --test src/compiler/**/*.test.js
```

For detailed current behavior, language support, generated-code contracts, and known boundaries, see the README in each compiler stage directory.
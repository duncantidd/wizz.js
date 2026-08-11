# Project Structure

This project separates build-time compilation from the small browser runtime.

```text
src/
├── compiler/                 Build-time code (Node.js)
│   ├── parser/               1. Tokenizer, template parser, and Pratt parser
│   ├── analyzer/             2. Dependency and reactivity tracking
│   └── generator/            3. Vanilla JavaScript code emission
└── runtime/                  Client-side browser glue
	├── scheduler.js
	└── hydration.js
```

## Compilation Pipeline

1. **Parse** source templates and expressions into a usable representation.
2. **Analyze** dependencies to determine what needs to react to change.
3. **Generate** framework-free JavaScript for the browser.

## Runtime

The runtime handles scheduling updates and hydrating generated output in the browser.
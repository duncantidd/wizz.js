# Wizz Compiler

## TL;DR

This directory is the public composition layer for the Wizz compiler. Most callers should use `compile()` or `compileServer()` rather than invoking parser, analyzer, and generator modules individually.

```js
const { compile, compileServer } = require('./src/compiler');

const { source, payload, sourceMap, version } = compile(componentSource, {
  filePath: 'src/pages/Home.wizz'
});

const serverResult = compileServer(componentSource, { filePath: 'src/pages/Home.wizz' });
```

`source` is a mountable ES module string. `payload` is the final parser and analyzer handoff used to generate it. `sourceMap` is an optional v3 source map for copied author script lines. `version` is the frozen compatibility contract the component was compiled with (see [Compatibility and Versioning](#compatibility-and-versioning)). `compileServer()` returns the same shape with `sourceMap: null` and a server-rendering module instead (see [Server Rendering](#server-rendering)).

The compiler runs each stage in its required order:

```text
Wizz component source
  -> parseComponent(source)
  -> analyzeDependencies(payload)
  -> assignNodeIds(payload)
  -> generateComponent(payload)
  -> { source, payload, version }
```

When a caller provides `filePath`, errors from the pipeline retain their original error type, are qualified with that path, and include a source excerpt with a caret code frame when a source location is available. This lets project builds identify both the component file and the exact source location that failed.

## Input and Output

`compile(source, options)` accepts a raw component source string and an optional options object:

```js
const result = compile(
  '<script>let count = 0;</script><p>Count: {count}</p>',
  { filePath: 'src/components/Counter.wizz' }
);

result.source;  // Generated `export default function mountComponent(target, props = {}) { ... }`
result.payload; // Final analyzed payload passed to the generator
result.sourceMap; // v3 map for the component's copied <script> lines, or null
result.version; // Frozen `{ compiler, syntax, output }` semver table
```

The returned payload has the shape established by the parser and enriched by the analyzer:

```js
{
  template: { /* parsed template AST with dependency and ID metadata */ },
  script: [ /* recognized declaration metadata */ ],
  rawScript: 'let count = 0;'
}
```

The analyzer and ID assigner mutate this payload in place before it is returned. Consumers that only need compiled output should rely on `result.source`; `payload` is exposed for testing and compiler tooling.

`compile()` accepts one additional option: `hydratable: true` restricts the component to the server-renderable surface (see [Server Rendering](#server-rendering)) and makes the generated module additionally export `hydrateComponent(target, props, state)`, which adopts markup delivered by the server target instead of recreating it. Without the flag, generation is unchanged.

## Server Rendering

`compileServer(source, options)` shares the parse → analyze → assign pipeline but emits a self-contained server module with no DOM dependency:

```js
const { source } = compileServer(
  '<script>let count = 0;</script><p>Count: {count}</p>',
  { filePath: 'src/components/Counter.wizz' }
);

// The module exports:
//   renderComponent(props = {}) -> { html, state }
//   serializeInitialState(state) -> '<script type="application/wizz-state">…</script>'
```

The v1 server-renderable surface is deliberately narrow: the root element, static markup, text interpolations, dynamic attributes, and top-level props. `{#if}`, `{#each}`, imported component tags, void elements with children, reactive names matching `__proto__` or the reserved `__wizz` prefix, and malformed `on:` directives fail the compile with located diagnostics. The author's top-level script runs verbatim and trusted on both targets; event handlers and lifecycle hooks are client-only.

Escaping and delivery boundaries: text output escapes `&`, `<`, `>`; attribute values additionally escape `"`. Adjacent text-like children carry `<!-- -->` markers so browser parsing preserves the positional node layout client updates target. State serializes through `serializeInitialState()` with every `<` escaped; the delivery script is a sibling of the mount point, never a child.

**No source map for server output.** Server modules render HTML strings at request time; there is no generated DOM artifact whose positions could map back to the template. `compileServer()` therefore always returns `sourceMap: null`, including for file-backed compiles. Error augmentation with `filePath` works exactly as for `compile()`.

## Source Maps

When a file-backed component contains author `<script>` content, `compile()` returns a standard v3 source map. It embeds the original component source in `sourcesContent` and maps the generated module's copied author-script lines to their original Wizz coordinates. Generated framework scaffolding intentionally has no mapping: it has no equivalent source location in the component and mapping it would give debuggers false locations.

`build.js` writes this map alongside the generated module, for example `dist/pages/Home.js.map`, sets its `file` field to `Home.js`, and adds `//# sourceMappingURL=Home.js.map` as the generated module's final line. Components without author script receive `sourceMap: null` and no `.map` file.

## Error Contract

Without `filePath`, compiler errors retain their original source-only message:

```text
Unclosed tag <main> starting at 1:1.
```

With `filePath`, locations are qualified and the same error instance carries programmatic `filePath`, `sourceExcerpt`, and `codeFrame` properties when the error has a source location:

```js
try {
  compile('<main><p>{count}</p>', { filePath: 'src/pages/Home.wizz' });
} catch (error) {
  error instanceof SyntaxError; // true
  error.filePath;               // 'src/pages/Home.wizz'
  error.sourceExcerpt;          // '<main><p>{count}</p>'
  error.codeFrame;
  // 'src/pages/Home.wizz:1:1\n1 | <main><p>{count}</p>\n  | ^'
  error.message;
  // 'Unclosed tag <main> starting at src/pages/Home.wizz:1:1.\n\n' + error.codeFrame
}
```

Messages without a location are prefixed with the file path instead:

```text
src/pages/Home.wizz: Component template must contain a root element.
```

The optional `options` value is normalized defensively. Omitting it, passing `null`, or passing a non-object does not replace an underlying compiler error with an options-access error. A file path is used only when it is a non-empty string.

## Compatibility and Versioning

`src/compiler/version.js` is the single source of truth for Wizz's compatibility contract. It exports one frozen table:

```js
{
  compiler: '1.3.0', // The compiler itself
  syntax: '1.1.0',   // The component language contract
  output: '1.3.0'    // The generated module contract
}
```

**What `syntax` covers.** The component language surface a `.wizz` file may use: template directives (`on:`, `{#if}`, `{:else}`, `{#each}` with keyed and keyless forms, imports, interpolation expressions, attributes on imported component tags, which pass as props) and the script boundary (reactive `let` declarations, `export let` prop declarations, named functions, lifecycle hooks). Within one `syntax` major version, any component that compiled before keeps compiling with the same meaning. New syntax may be added in a minor version; existing syntax never changes meaning without a major bump.

**What `output` covers.** The surface of every generated module: a default-exported `mountComponent(target, props)` factory that appends the component's root element to `target` and returns `{ setProps?, destroy() }` (the optional `setProps(next)` handle exists on components that declare props); `destroy()` running destroy hooks, destroying child components, removing tracked `on:` listeners, and removing the root from the target; and the `__wizzChildComponents`, `__wizzMountChildren`, and `__wizzListUpdates` root-node properties the framework consumes. Optionally — for compiles requested with `hydratable: true` — the module additionally exports `hydrateComponent(target, props, state)`, which adopts server-rendered markup through the documented hydration traversal. Within one `output` major version, generated modules keep this surface and their runtime behavior. A test in `componentGenerator.test.js` pins this surface (byte-for-byte for default output), so a codegen change that breaks it fails the suite until the version is bumped deliberately.

**Bump rules.** A breaking change to a contract bumps its major version and the compiler's major version. Additive capabilities bump the affected minor version. Fixes bump patch versions. `version.test.js` pins the current values, so a bump can only happen by editing `version.js` and its test together.

**Where the versions are surfaced.**

- `compile()` returns them as its frozen `version` field, and the compiler exports the same `VERSIONS` table.
- Every generated module self-identifies with a first-line comment stamped from the table:

  ```js
  // Generated by Wizz 1.3.0 (component syntax 1.1.0, generated output 1.3.0). Edits will be overwritten.
  ```

  Server modules stamp the same table with a `server output` label.

  Compiled artifacts therefore stay traceable to the compiler and contracts that produced them, even when separated from their source.

## Files

### `index.js` - Public Compiler Facade

**Exports:** `compile(source, options)`, `compileServer(source, options)`, `augmentErrorWithFile(error, filePath, source)`, `VERSIONS`

`compile()` is the primary public compiler entry point. It imports and composes the parser, dependency analyzer, ID assigner, and component generator so callers cannot accidentally omit a required stage or run them in the wrong order. `compileServer()` runs the same pipeline but composes the server generator (see [Server Rendering](#server-rendering)).

Its responsibilities are:

1. Parse raw component source into the standard `{ template, script, rawScript }` handoff.
2. Add reactive dependency metadata to parsed interpolation expressions.
3. Assign `data-wizz-id` attributes to elements that require targeted updates.
4. Generate the mountable ES module source, stamped with the compatibility versions (`compileServer()` generates the server-rendering module instead; `hydratable: true` adds the hydration traversal and its surface gate).
5. Add file-path context, source excerpts, and code frames to location-aware errors when the caller supplied `options.filePath`.
6. Return the generated source, any author-script source map (`null` for server output), the analyzed payload, and the frozen version table.

`compile()` does not read or write files. File callers, such as `build.js`, read a `.wizz` file themselves and pass its path through `options.filePath` for diagnostics.

### `errorAugmenter.js` - Compiler Error Qualifier

**Export:** `augmentErrorWithFile(error, filePath, source)`

`augmentErrorWithFile()` returns the original `Error` instance after adding file context. It preserves the error constructor and stack, sets `error.filePath`, and, for a location-aware error with source text, sets `error.sourceExcerpt` and `error.codeFrame`. The code frame is appended to the message after the file-qualified error text. Errors without a location retain the path-prefixed message and have no excerpt or code frame.

| Original message | Augmented result |
| --- | --- |
| `Mismatched closing tag at 1:6.` | `Mismatched closing tag at App.wizz:1:6.` |
| `Template Expression Error at 1:7 - Unexpected token Number` | `Template Expression Error at App.wizz:1:7 - Unexpected token Number` |
| `Component template must contain a root element.` | `App.wizz: Component template must contain a root element.` |

Every occurrence matching `at <line>:<column>` is qualified. The function is intentionally conservative: it leaves non-`Error` thrown values, missing or non-string paths, and errors already carrying `filePath` unchanged. This prevents an outer compiler boundary from duplicating a file path applied by an inner boundary.

### `sourceMapGenerator.js` - Author Script Source Map

**Export:** `createSourceMap(componentSource, generatedSource, filePath, rawScript)`

`createSourceMap()` creates a v3 map only when a non-empty author script and file path are available. It encodes mappings without an external dependency, maps each copied script line from the generated `Developer Logic` section, and embeds the full Wizz source for debugger inspection. The build owns output-specific metadata such as the map's `file` field and `sourceMappingURL` directive.

## Current Boundaries

- `compile()` and `compileServer()` emit module source but do not execute it, write it to disk, or resolve imports.
- The generated module and script transformation have the language and runtime boundaries documented in [generator/README.md](generator/README.md). The server-renderable surface and hydration traversal boundaries are documented there as well.
- Source locations come from the parser and expression integrator. The augmenter only formats existing `at line:column` locations; it does not create source locations. When source text is available, it displays the line at the first reported location with a caret code frame.
- Source maps cover copied author script lines only, and only for `compile()`. Server output is an HTML string with no positional DOM artifact to map, so `compileServer()` returns `sourceMap: null`. Wizz template expressions and generated framework code are currently unmapped, because the generator does not yet retain enough per-emission source metadata to map them accurately.
- File paths are caller-supplied labels. They are not normalized, checked for existence, or made relative by this layer.
- The parser, analyzer, and generator modules remain separately exported for their focused tests and internal development. Application build code should use `compile()` and `compileServer()` as the stable compiler contracts.

## Tests

- `index.test.js` verifies pipeline composition, generated source, mounted behavior against a minimal DOM, static components, compiler error propagation, and the versioned compile result — plus the `compileServer()` module contract, its executed render/serialize behavior, located server-target rejections, and the `hydratable` option's dual exports and surface gate.
- `version.test.js` verifies the version table's shape, semver format, immutability, pinned values, and the policy invariant that the compiler major version leads both contract majors.
- `errorAugmenter.test.js` verifies location qualification, source excerpts, code frames, location-free errors, repeated locations, invalid file paths, and non-`Error` thrown values.
- `sourceMapGenerator.test.js` verifies VLQ encoding, multiline mappings, unavailable map inputs, and script-location anchoring.
- `../../test/endToEnd.test.js` compiles fixture `.wizz` files through this public API and executes their generated modules against a minimal DOM.

Run the full repository test suite from the project root with:

```bash
node --test
```
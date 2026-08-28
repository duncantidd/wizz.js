# Wizz Generator

## TL;DR

This directory is the final build-time stage of the Wizz compiler. It turns the analyzed component payload into one ES module that creates DOM nodes, mounts them into a target, performs initial reactive rendering, and exposes a `destroy()` method.

The generator expects parser and analyzer work to be complete:

```text
component source
  -> parser
  -> dependency analyzer
  -> node ID assigner
  -> generator
  -> ES module source string
```

`generateComponent()` in `componentGenerator.js` is the public entry point. It composes the other generator modules:

```text
analyzed payload
  -> interceptAssignments(rawScript, reactive names)
  -> generateCreateFunction(template)
  -> generateUpdateFunction(template)
  -> CodeBuilder
  -> export default function mountComponent(target) { ... }
```

The output is JavaScript source, not an immediately mounted component. The caller is responsible for bundling or evaluating the emitted ES module and calling its default `mountComponent(target)` export in a browser-like environment.

## Input Requirements

The generator consumes the payload produced by this sequence:

```js
const { parseComponent } = require('../parser');
const { analyzeDependencies } = require('../analyzer/dependencyAnalyzer');
const { assignNodeIds } = require('../analyzer/idAssigner');
const { generateComponent } = require('./componentGenerator');

const payload = assignNodeIds(analyzeDependencies(parseComponent(source)));
const moduleSource = generateComponent(payload);
```

The relevant payload fields are:

| Field | Producer | Generator use |
| --- | --- | --- |
| `rawScript` | Parser | Scanned for supported reactive mutations, then inserted into the component factory as developer logic. |
| `script` | Parser | Finds reactive declarations for context getters and initial change flags. |
| `template` | Parser | Drives DOM creation. |
| `Expression.value` | Parser | Becomes the JavaScript expression evaluated during updates. |
| `Expression.dependencies` | Dependency analyzer | Determines which `changed` flags should trigger each expression update. |
| `data-wizz-id` attributes | ID assigner | Lets generated update code locate the correct parent DOM element. |

Calling `generateComponent()` without the analyzer stages can still produce source, but dynamic expressions will not have the metadata required for targeted updates. In particular, `generateUpdateFunction()` reads both `dependencies` and `data-wizz-id` values.

## Generated Module Contract

For a component with `let count = 0;` and `<p>Count: {count}</p>`, the result follows this shape:

```js
export default function mountComponent(target) {
  // Developer logic is emitted here.
  let count = 0;

  const ctx = {
    get count() { return count; },
  };

  function create(ctx) {
    // Create elements and text nodes, then return the root element.
  }

  function update(ctx, changed) {
    // Update dynamic text when changed.count is true.
  }

  const rootNode = create(ctx);
  target.appendChild(rootNode);
  update(ctx, { count: true });

  return {
    destroy() {
      target.removeChild(rootNode);
    }
  };
}
```

The original script and generated `create()`/`update()` functions share the `mountComponent()` lexical scope. This is why a generated update assignment can evaluate the raw expression text, such as `count + 1`, against the component's current local state.

`ctx` currently exposes getter access to each reactive declaration and is passed to both lifecycle functions. It establishes the framework context boundary and ensures a getter reads the current local binding; the present generated expression code evaluates directly in the factory closure rather than reading through `ctx`.

## Files

### `codeBuilder.js` - Source Formatting Utility

**Export:** `CodeBuilder`

`CodeBuilder` is the small shared utility that produces readable, deterministic generated code. It stores output as lines and applies two spaces per indentation level when adding each line.

#### `new CodeBuilder()`

The constructor initializes an empty `lines` array and `indentLevel` of zero. A fresh builder generates an empty string until code is added.

#### `add(code)`

Adds one string line at the current indentation level and returns `this`, enabling fluent emission:

```js
builder.add('function create() {')
  .indent()
  .add('return node_1;')
  .dedent()
  .add('}');
```

It throws `TypeError` for non-string input. Keeping this validation at the formatting boundary catches generator mistakes before an invalid value is quietly converted into code text.

#### `indent()` and `dedent()`

`indent()` increases indentation for subsequent lines. `dedent()` decreases it only when above zero, so an unmatched call cannot produce negative indentation. Both return `this` for chaining.

#### `generate()`

Joins accumulated lines with `\n` and returns the final source string. It does not append a trailing newline, which makes output stable for string-based tests and embedding in larger generated modules.

### `domGenerator.js` - DOM Creation Emitter

**Export:** `generateCreateFunction(templateAST)`

`generateCreateFunction()` emits a `function create(ctx) { ... }` declaration that builds the static structure of the component using native DOM APIs. It does not mount the result; it returns the constructed root node to the component wrapper.

#### Root Selection

Components currently require a top-level `Element` node. The generator uses the first such child under `templateAST.children` and ignores surrounding root-level text, which allows formatting whitespace outside the component element. It throws:

```text
Component template must contain a root element.
```

when no top-level element exists.

#### `walk(node, parentVarName)`

The nested walker emits one local variable per AST node, named sequentially as `node_1`, `node_2`, and so on. It stores the correspondence in `nodeVariables`, which is maintained as generation-time bookkeeping for AST-to-variable associations.

For each supported node type, it emits:

| AST node | Generated DOM operation |
| --- | --- |
| `Element` | `document.createElement(name)` plus attribute assignment |
| Imported component tag | Invokes the imported component's mount function with its parent element |
| `Text` | `document.createTextNode(value)` |
| `Expression` | `document.createTextNode(String(expression))` |

Every generated child is appended to `parentVarName` immediately after creation. The recursive traversal then creates descendants in source order. This produces the same child-node indexing that `updateGenerator.js` later uses for reactive text updates.

For attributes, a normal value produces `setAttribute(name, value)`. A parser-produced boolean attribute has `value: null` and produces `setAttribute(name, "")`, matching HTML's presence-based boolean attribute representation. An explicit event directive such as `on:click={handleClick}` emits `addEventListener("click", handleClick)` instead of an inline attribute, so the listener retains access to the component factory's local state and functions. Event directive values must currently be a single handler identifier.

Names, text content, and attribute values are embedded with `JSON.stringify()`. That is important for correct generated JavaScript when source contains quotes, backslashes, or newlines; they are emitted as valid string literals rather than interpolated unsafely into source code.

An imported component is recognized only when its tag name matches a default `.wizz` import from the component script, for example `import Counter from './Counter.wizz';` with `<Counter />`. The generated module moves this import to module scope and changes the specifier to `./Counter.js`. Component tags must be self-closing, nested in a native element, and have no attributes or children. Their mount results are retained so the parent component's `destroy()` can destroy each child before removing the parent root.

Expressions create text nodes from `String(expression)` during initial DOM construction. This renders both reactive `let` values and non-reactive `const` values at mount time. `componentGenerator.js` still invokes `update()` once during mount so the reactive update path is exercised consistently.

### `updateGenerator.js` - Reactive Text Update Emitter

**Export:** `generateUpdateFunction(templateAST)`

`generateUpdateFunction()` emits `function update(ctx, changed) { ... }`. The generated function walks no AST at runtime. Instead, this generator walks the analyzed AST at build time and writes direct DOM operations for every known reactive interpolation.

#### `walk(node)`

The nested walker handles `Root` and `Element` nodes. For each element, it reads the `data-wizz-id` attribute assigned by the analyzer, then iterates its immediate children with their `childIndex`.

When a child is an expression with a non-empty `dependencies` array, it emits one guarded update block per dependency:

```js
if (changed.count) {
  const target_1 = document.querySelector('[data-wizz-id="1"]');
  target_1.childNodes[1].nodeValue = String(count + 1);
}
```

Each generated block:

1. checks the specific property in the `changed` object;
2. looks up the expression's parent element by `data-wizz-id`;
3. uses the source-order child index to target the exact text node; and
4. assigns `String(expression)` to `nodeValue`.

`String()` ensures numeric expression results become valid text-node content. For an expression with several dependencies, a block is emitted for each one, so a change to any referenced reactive variable recalculates the complete expression.

Templates with no reactive expressions generate an empty `update()` body and no `document.querySelector()` calls. The AST walk remains recursive so expressions nested beneath arbitrary elements are emitted.

### `assignmentInterceptor.js` - Reactive Mutation Rewriter

**Export:** `interceptAssignments(rawScript, reactiveVars)`

`interceptAssignments()` preserves the component's script source while adding a `queueUpdate({ name: true })` call after each supported mutation of a reactive variable. For example:

```js
count += 1;
// becomes
count += 1; queueUpdate({ count: true });
```

It uses a small stateful scanner instead of a regular expression over the entire script. The scanner skips single-quoted strings, double-quoted strings, template literals, line comments, block comments, and slash-delimited regions, so text that merely resembles an assignment is never rewritten. Treating every non-comment slash as opaque can miss mutations in complex division expressions, but avoids inspecting or corrupting regular expression literals. Rewrites are only attempted at statement level, outside `(` and `[` nesting; for-loop headers, arrow-function default parameters, and unbraced control-flow bodies are left untouched. It supports direct and property mutations using `=`, compound arithmetic assignment operators, `++`, and `--`, and preserves the original assignment text rather than reconstructing its whitespace. Braces are deliberately not treated as nesting: function and block bodies are legitimate statement-level mutation sites, and telling them apart from object literals would require parsing. The component wrapper provides `queueUpdate()` before executing developer logic; it calls `update()` only after initial mounting completes. This makes initialization assignments safe because DOM creation reads their final values directly.

The scanner is deliberately scoped and is not a JavaScript parser, and nothing in the compiler should represent it as one. Its limits are part of its contract: statements that omit semicolons, mutations nested inside parentheses, unbraced control-flow bodies, and mutations in slash-delimited regions pass through untouched. Unrecognized syntax is preserved untransformed rather than approximated — a missed interception is acceptable, corrupted output is not. Broader language coverage should come from replacing this module with a syntax-aware JavaScript transform, as planned in the production-hardening milestone, not from widening these heuristics.

### `componentGenerator.js` - Mountable ES Module Emitter

**Export:** `generateComponent(astPayload)`

`generateComponent()` is the public composition layer. It creates a `CodeBuilder`, emits the factory function, delegates DOM and update function bodies to their dedicated generators, then emits mounting and teardown code.

Its generated factory has these phases:

1. **Factory signature:** emits `export default function mountComponent(target) {`.
2. **Developer logic:** emits a guarded `queueUpdate()` dispatcher, sends `rawScript` and reactive declaration names through `interceptAssignments()`, then writes the resulting source line by line into the factory closure. Recognized mutations update mounted components, while initialization-time mutations are safe because they run before `isMounted` is set.
3. **Framework context:** filters `astPayload.script` for reactive declarations and emits a getter for each name. `const` declarations and function declarations do not become context getters.
4. **DOM creation:** inserts the source from `generateCreateFunction(astPayload.template)`.
5. **Reactivity engine:** inserts the source from `generateUpdateFunction(astPayload.template)`.
6. **Initialization:** calls `create(ctx)`, appends the returned root node to `target`, invokes `update(ctx, changed)` with every reactive variable set to `true`, then sets `isMounted` to `true`. Creation renders every expression initially; this first update establishes the regular reactive update path before intercepted mutations can trigger it.
7. **Public API:** returns `{ destroy() { target.removeChild(rootNode); } }`.

The initial `changed` object is derived from reactive script declarations, for example `{ count: true, user: true }`. When no reactive declarations exist, it is emitted as `{  }`; `update()` remains safe because it has no dependency guards to satisfy.

## Current Runtime Boundaries

The generated output is intentionally small and uses direct DOM APIs. Its current behavior has a few boundaries that future work should address deliberately:

- Components must have at least one top-level element. Root-level formatting text is ignored, and additional top-level elements are not mounted because creation selects the first root element.
- Dynamic expressions are supported only as direct text-node children of elements. Dynamic attributes are not generated yet.
- Explicit event directives use `on:<event>={handler}` and compile to native `addEventListener()` bindings. Their handler value is currently limited to one component-local identifier; inline event attributes and arbitrary expressions are not supported.
- Generated updates assume the analyzer gave every reactive expression's parent element a `data-wizz-id`. Skipping `assignNodeIds()` can yield a lookup for `data-wizz-id="null"` if dependencies are present without an ID.
- The update function queries the document each time a dependency changes and assumes the target still exists. The current output has no null-target guard or caching layer.
- Repeated dependencies generate separate guards by expression dependency, which is correct but not batched or scheduled. Runtime scheduling is outside this directory's current scope.
- The emitted developer script must be valid JavaScript in the component factory context. The current interceptor only rewrites semicolon-terminated statement-level mutations outside protected strings, comments, template literals, and regular expression literals; it is not a complete JavaScript parser or sandbox.
- `destroy()` removes the generated root from the provided target. Native event listeners become unreachable with their removed nodes, but lifecycle hooks and explicit listener cleanup are not emitted yet.

## Tests

Each generator module has a focused Node test file. Run the complete generator suite from the repository root with:

```bash
node --test src/compiler/generator/*.test.js
```

The tests verify source formatting, safe reactive-assignment interception, DOM construction, preservation of escaped source text, missing-root errors, dependency-specific text updates, no-query static output, ES module export shape, reactive context getters, initial rendering, and `destroy()` behavior. Update the nearest test whenever changing generated source or its runtime contract.
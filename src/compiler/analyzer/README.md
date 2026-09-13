# Wizz Analyzer

## TL;DR

This directory is the second stage of the Wizz compiler. It enriches the parsed component handoff with the information needed to generate targeted DOM updates:

- `dependencyAnalyzer.js` records which reactive `let` declarations each template interpolation reads. Declared props (`export let`) are reactive declarations too, so template expressions and dynamic attributes depending on a prop are tracked identically to state.
- `idAssigner.js` adds a stable-in-the-payload `data-wizz-id` attribute to elements that directly contain reactive interpolations, and a `componentId` to imported component tags so the generated create() and update() code can share one instance reference.

The analyzer runs after `parseComponent()` and before code generation:

```text
component source
  -> parser: { template, script, rawScript, imports, props }
  -> analyzeDependencies()
  -> assignNodeIds()
  -> generator
```

Both analyzer functions mutate the payload they receive and return that same object. This keeps the compiler pipeline simple and avoids copying a nested template AST at each stage.

## Input and Output

The parser provides a component payload such as:

```js
{
  template: {
    type: 'Root',
    children: [
      {
        type: 'Element',
        name: 'p',
        attributes: [],
        children: [
          {
            type: 'Expression',
            value: 'user.name + count',
            expressionAST: {
              type: 'BinaryExpression',
              operator: '+',
              left: {
                type: 'MemberExpression',
                object: { type: 'Identifier', name: 'user' },
                property: { type: 'Identifier', name: 'name' }
              },
              right: { type: 'Identifier', name: 'count' }
            }
          }
        ]
      }
    ]
  },
  script: [
    { type: 'VariableDeclaration', kind: 'let', name: 'user', isReactive: true },
    { type: 'VariableDeclaration', kind: 'let', name: 'count', isReactive: true },
    { type: 'VariableDeclaration', kind: 'const', name: 'title', isReactive: false }
  ],
  rawScript: '...'
}
```

After `analyzeDependencies()`, every parsed `Expression` node has a `dependencies` array. The example above becomes:

```js
{
  type: 'Expression',
  value: 'user.name + count',
  expressionAST: { /* preserved parser AST */ },
  dependencies: ['user', 'count']
}
```

After `assignNodeIds()`, the direct parent element receives a DOM targeting attribute:

```js
{
  type: 'Element',
  name: 'p',
  attributes: [{ name: 'data-wizz-id', value: '1' }],
  children: [/* expression above */]
}
```

The generator can use the dependency list to decide what to update and `data-wizz-id` to locate the affected element in the browser.

## Analysis Rules

The current analyzer is intentionally conservative and works with the parser's present expression AST types.

| Source form | Dependency result | Why |
| --- | --- | --- |
| `{count}` | `['count']` when `count` is a reactive `let` | Direct reactive state read. |
| `{count + count}` | `['count']` | Dependencies are collected in a `Set`, so repeated reads appear once. |
| `{user.name}` | `['user']` | The root object is state; `name` is a property key, not a separate state reference. |
| `{user.name + count}` | `['user', 'count']` | Dependencies follow expression traversal order. |
| `{title}` where `title` is `const` | `[]` | `const` declarations are currently non-reactive. |
| Static text or ordinary elements | No `dependencies` property | Only parsed interpolation nodes participate in dependency tracking. |
| `<wizz:head>` contents | Not analyzed | The head block is pruned by the parser's `extractHeadBlock()` before analysis; its expressions ride the same dynamic-attribute/text evaluation paths as body markup at generation time, so they carry no separate dependency metadata (head follows navigation, not reactive state — reactive head updates are out of scope). |

`assignNodeIds()` marks an element when one of its **immediate children** is a reactive expression or when it has a reactive dynamic attribute. It does not mark ancestors merely because a descendant is reactive. For example, in `<section><div><p>{count}</p></div></section>`, only the `p` is assigned an ID.

## Files

### `dependencyAnalyzer.js` - Reactive Dependency Tagging

**Export:** `analyzeDependencies(astPayload)`

`analyzeDependencies()` receives the parser's `{ template, script, rawScript }` object and returns the same object after adding dependency metadata to expression nodes.

Its first step derives `reactiveVars`, a `Set` of names from script declarations that meet both conditions:

```js
decl.type === 'VariableDeclaration' && decl.isReactive
```

Today, the parser sets `isReactive: true` for recognized `let` declarations and `false` for `const` declarations. The analyzer therefore does not infer reactivity itself; it respects the parser's declaration metadata as the source of truth.

#### `extractIdentifiers(exprAST, deps = new Set())`

This nested helper walks an expression AST and adds only recognized reactive names to `deps`.

- For `Identifier`, it records the identifier only when its name is in `reactiveVars`.
- For `BinaryExpression`, it walks `left` then `right`.
- For `MemberExpression`, it walks only `object`. In `user.name`, `user` is the reactive dependency; `name` is not independently evaluated as a state variable.
- For a missing AST or an AST type not currently recognized, it returns the collected set unchanged.

Using a `Set` removes duplicates while preserving insertion order. This makes `{count + count}` depend on `count` once and gives deterministic output for generators and tests.

#### `walkTemplate(node)`

This nested recursive walker visits the full template tree. At every `Expression` node that has an `expressionAST`, it sets:

```js
node.dependencies = Array.from(extractIdentifiers(node.expressionAST));
```

It then walks `children` when present. Text nodes, regular elements, and expressions without a parsed AST are otherwise left unchanged. The traversal is recursive so dependencies are attached at any nesting depth.

### `idAssigner.js` - DOM Update Targets

**Export:** `assignNodeIds(astPayload)`

`assignNodeIds()` receives the dependency-enriched payload and returns the same object after adding `data-wizz-id` attributes to eligible elements. IDs begin at `'1'` for each invocation and are stored as strings because they are HTML attribute values.

Imported component tags (element names matching `astPayload.imports`) take a separate path: each tag receives `node.componentId`, a sequential integer, and is never given `data-wizz-id`. Component tags create no DOM element, so they cannot be located by attribute lookup — the generated code uses the componentId to build the factory-scope instance reference (`component_<id>`) that both mounting and prop updates read.

#### `walk(node)`

The nested walker is responsible for deciding whether each element needs a generated target ID and then traversing its children.

For an `Element`, `hasReactiveChildren` is true when at least one immediate child:

1. has `type: 'Expression'`;
2. has a `dependencies` property; and
3. has at least one dependency.

When that condition is true, the function ensures `node.attributes` exists and looks for an existing `data-wizz-id`. It appends the next sequential value only when no such attribute is already present. This makes the operation idempotent for a payload that has already been assigned IDs: a second call does not append duplicate attributes.

After handling the current element, the walker recursively visits its children. Because assignment occurs before recursion, IDs follow depth-first pre-order for nodes newly assigned during one invocation.

## Ordering and Boundaries

Call the stages in this order:

```js
const { parseComponent } = require('../parser');
const { analyzeDependencies } = require('./dependencyAnalyzer');
const { assignNodeIds } = require('./idAssigner');

const parsed = parseComponent(source);
const analyzed = analyzeDependencies(parsed);
const identified = assignNodeIds(analyzed);
```

`assignNodeIds()` depends on `Expression.dependencies`, so calling it before `analyzeDependencies()` produces no reactive target IDs. Conversely, the dependency analyzer depends on parser-produced `script` declaration metadata and `expressionAST` values.

The current scope deliberately has several limits:

- Dependency analysis handles the parser's `Identifier`, `BinaryExpression`, and `MemberExpression` nodes only. Adding expression grammar requires extending this visitor for any new AST node that can contain state references.
- The parser's script scanner determines which declarations exist and which are reactive. It is not a full JavaScript semantic analyzer.
- Dynamic brace-valued attributes are analyzed using their parsed expression AST and receive an ID when they read reactive state.
- Declared props participate in dependency tracking like `let` state because the parser records them as reactive declarations with `isProp: true`; the analyzer does not distinguish them.
- An element is marked only for direct reactive expression children. Parent elements and elements containing only non-reactive expressions remain unmarked.
- Existing `data-wizz-id` attributes are preserved. Because ID generation restarts from `1` for each call, callers should treat assignment as a one-time stage on a newly parsed payload rather than merge independently assigned AST fragments.

## Tests

The adjacent test files define the current behavioral contract. Run them from the repository root with:

```bash
node --test src/compiler/analyzer/*.test.js
```

The tests cover reactive versus non-reactive declarations, nested template traversal, member-expression dependency handling, sequential IDs, ancestor exclusion, and repeated assignment on the same payload. Extend the closest test whenever changing an analysis rule or the payload shape consumed by the generator.
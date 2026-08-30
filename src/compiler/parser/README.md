# Wizz Parser

## TL;DR

This directory is the first stage of the Wizz compiler. It converts a component source string into a compiler handoff object containing:

- a renderable template AST, with each `{expression}` parsed into its own expression AST;
- declarations discovered in the component's `<script>` block; and
- the original script source for later compiler stages that need it.

`parseComponent()` in `index.js` is the public entry point. Its pipeline is:

```text
component source
  -> tokenize
  -> parseTemplate
  -> integrateExpressions
  -> extractScriptBlock
  -> scanState
  -> { template, script, rawScript }
```

The parser is build-time Node.js code. It does not execute component JavaScript or create DOM nodes. Its job is to preserve enough source structure and location data for the analyzer and generator to make correct later decisions.

## Public Handoff

```js
const { parseComponent } = require('./index.js');

const component = parseComponent(`
  <script>
    let count = 0;
    function increment() { count += 1; }
  </script>
  <main>Count: {count + 1}</main>
`);
```

The result has this shape:

```js
{
  template: {
    type: 'Root',
    children: [/* Element, Text, and Expression nodes */]
  },
  script: [
    {
      type: 'VariableDeclaration',
      kind: 'let',
      name: 'count',
      initialValue: '0',
      isReactive: true
    },
    {
      type: 'FunctionDeclaration',
      name: 'increment'
    }
  ],
  rawScript: '\n    let count = 0;\n    function increment() { count += 1; }\n  '
}
```

`template` intentionally excludes the `<script>` element. A script block supplies component logic, not renderable DOM. `rawScript` is always a string, including when there is no script block; `script` is always an array.

### Template Node Shapes

All template nodes originating from source have `loc.start` and `loc.end` positions, each with `offset`, `line`, and `column`. These locations make compiler diagnostics refer back to the component source.

```js
// Rendered element
{
  type: 'Element',
  name: 'main',
  attributes: [{ name: 'class', value: 'counter' }],
  children: [],
  loc: { start: { offset: 0, line: 1, column: 1 }, end: {} }
}

// Literal template text
{ type: 'Text', value: 'Count: ', loc: {} }

// An interpolation after integration
{
  type: 'Expression',
  value: 'count + 1',
  expressionAST: {
    type: 'BinaryExpression',
    operator: '+',
    left: { type: 'Identifier', name: 'count' },
    right: { type: 'Literal', value: 1 }
  },
  loc: {}
}
```

## Supported Language Surface

The current implementation is intentionally small. Documentation should distinguish support that exists today from syntax that may be familiar from JavaScript but is not yet parsed.

| Area | Supported | Current boundary |
| --- | --- | --- |
| Elements | Named opening, closing, and self-closing tags | Tag names begin with a letter and continue with letters, digits, `:`, `_`, or `-`. |
| Attributes | Boolean attributes, single- or double-quoted values, event directives, and dynamic brace-delimited values such as `value={name}` | Dynamic values use the current expression grammar. Their reactive dependencies are analyzed like text interpolations. |
| Interpolations | `{...}` in template text, nested braces, quotes, and escapes while locating the end brace | The expression grammar below determines which interpolation contents can be compiled. |
| Conditionals | `{#if condition}...{:else}...{/if}` | Conditions are evaluated during mounting; reactive branch replacement is not supported yet. |
| Keyed lists | `{#each items as item (item.id)}...{/each}` | Each blocks require an identifier collection, item alias, explicit `item.key`, and exactly one native root element in their body. |
| Expressions | Identifiers, integer and string literals, `+`, `-`, `*`, `/`, `.`, `===`, and parentheses | No booleans, calls, arrays, objects, assignments, non-strict comparisons, optional chaining, or unary operators. |
| Component imports | Default imports ending in `.wizz`, such as `import Counter from './Counter.wizz';` | Imported modules are rewritten to `.js` in generated output. Named, namespace, dynamic, and non-Wizz imports are outside this contract. |
| Script scanning | Semicolon-terminated `let`/`const` assignments and named `function` declarations | It is a targeted regex scanner, not a JavaScript parser. `var`, classes, arrow functions, and syntax without the recognized forms are not reported. |

## Files

### `index.js` - Component Parser Facade

**Export:** `parseComponent(source)`

This is the module downstream compiler stages should use. It owns the ordering of all parser steps, so each stage receives the representation it expects:

1. `tokenize()` converts raw component markup into structural tokens.
2. `parseTemplate()` verifies nesting and builds the template tree.
3. `integrateExpressions()` adds expression ASTs to interpolation nodes.
4. `extractScriptBlock()` removes script content from the render tree while returning that content.
5. `scanState()` turns recognized declarations into lightweight metadata.

It throws `TypeError` unless `source` is a string. A component without `<script>` receives `script: []` and `rawScript: ''`, keeping the compiler handoff stable and avoiding special cases downstream.

### `tokenizer.js` - Markup State Machine

**Exports:** `STATES`, `tokenize(input)`

`tokenize()` is a character-by-character finite-state scanner for Wizz template markup. It converts the source into these token types:

```js
{ type: 'OpenTag', name, attributes, start, end, loc }
{ type: 'CloseTag', name, start, end, loc }
{ type: 'SelfClosingTag', name, attributes, start, end, loc }
{ type: 'Text', value, start, end, loc }
{ type: 'Expression', value, start, end, loc }
```

The positional fields are recorded here, at the point exact character information still exists. `start` and `end` are zero-based offsets; `loc` uses one-based line and column values.

`STATES` names the scanner's modes: text, tag parsing, quoted and brace-delimited attribute parsing, interpolation parsing, quoted interpolation strings, escape handling, and script content. Exporting it makes the state vocabulary explicit for tests and future maintenance.

Important behavior:

- `emitText()` flushes accumulated text only when non-empty, preventing empty text nodes.
- `emitTag()` centralizes open, close, and self-closing tag token construction.
- `commitAttribute()` stores boolean attributes (`value: null`), quoted values, and the contents of brace-delimited directive values without their surrounding braces.
- `EXPRESSION`, `EXPRESSION_STRING`, and `EXPRESSION_ESCAPE` track brace depth and quotes, so a nested object literal or a brace inside a string does not prematurely end `{...}`.
- `SCRIPT` treats everything as text until the exact `</script>` sequence. This preserves JavaScript such as `"Hello, {name}"` rather than tokenizing its braces as template interpolations.
- `fail()` consistently reports source coordinates for malformed markup, missing quotes, and unclosed tags or expressions.

The tokenizer establishes lexical structure only. It does not validate matching opening and closing tags; that is the template parser's responsibility.

### `templateParser.js` - Structural AST Builder

**Export:** `parseTemplate(tokens)`

`parseTemplate()` consumes tokenizer output and builds a nested AST rooted at `{ type: 'Root', children: [] }`. It uses a stack whose final entry is always the current parent. Opening elements are appended and pushed; closing tags validate and pop; self-closing elements are appended without being pushed.

This module owns structural validation because only it has the complete nesting context:

- a closing tag with no open parent is rejected;
- a closing tag must match the currently open element;
- every opening tag must be closed by the end of the token stream; and
- unknown token types fail instead of being silently discarded.

Text and expression tokens become `Text` and `Expression` AST nodes. An `Expression` node retains its raw `value` until `integrateExpressions()` processes it. Element locations come from their opening-tag tokens, which makes an unclosed-element diagnostic point at the element that needs attention.

### `expressionLexer.js` - Interpolation Lexer

**Export:** `lexExpression(input)`

`lexExpression()` tokenizes the raw string inside an interpolation. It is deliberately independent of the markup tokenizer: markup needs to find interpolation boundaries, while this lexer knows the smaller expression language.

It emits `Identifier`, `Number`, operator/delimiter tokens for `+`, `-`, `*`, `/`, `.`, `(`, and `)`, followed by a mandatory `EOF` token. Whitespace is skipped. Identifiers begin with a letter or underscore and may then contain letters, digits, and underscores. Numbers are currently non-negative integer literals and are converted to JavaScript `Number` values.

Every token has line and column information relative to the interpolation string. This local location is remapped to the component location by `integrator.js`. Invalid characters raise a `SyntaxError` at the offending local coordinate.

### `prattParser.js` - Expression AST Parser

**Exports:** `PRECEDENCE`, `parseExpression(tokens)`

`parseExpression()` implements a Pratt parser over the expression-lexer tokens. A Pratt parser keeps precedence rules near the operators that use them, making this small grammar easy to extend without reorganizing a large recursive-descent parser.

`PRECEDENCE` assigns low binding power to `EOF`, then addition/subtraction, multiplication/division, and finally property access. As a result, `user.name + 1 * 2` parses property access first, multiplication second, and addition last.

The parser's internal parselets produce these AST forms:

```js
{ type: 'Identifier', name: 'count' }
{ type: 'Literal', value: 1 }
{ type: 'BinaryExpression', operator: '+', left, right }
{ type: 'MemberExpression', object, property: { type: 'Identifier', name: 'name' } }
```

Prefix parselets handle identifiers, numbers, and grouped expressions. Infix parselets handle arithmetic and member access. The final `EOF` check is essential: it rejects partial parses such as `1 2` instead of accepting the first valid fragment and ignoring the rest. Parser errors include the location supplied by the lexer, including missing `)` and a non-identifier property after `.`.

### `integrator.js` - Template Expression Integration

**Export:** `integrateExpressions(node)`

`integrateExpressions()` recursively visits a template AST. For each `Expression` node, it calls `lexExpression(node.value)` and `parseExpression(tokens)`, then assigns the result to `node.expressionAST`.

It intentionally mutates and returns the same AST. The mutation preserves template node identity for callers while enriching it with compiler-ready expression structure. Keeping the original `value` alongside `expressionAST` also preserves the source form for diagnostics or future transforms.

The error wrapper is a key boundary in the pipeline. Expression lexer/parser locations are local to the interpolation; this module translates them using `node.loc.start` and throws a `SyntaxError` in component coordinates:

```text
Template Expression Error at <line>:<column> - <expression error>
```

That translation ensures a developer can find a bad expression from the original component file rather than manually calculating offsets inside a brace-delimited fragment.

### `extractor.js` - Script Extraction and Pruning

**Export:** `extractScriptBlock(ast)`

`extractScriptBlock()` walks the integrated template AST looking for `Element` nodes named `script`. When it finds one, it reconstructs its source content, removes that node from its parent's `children`, and returns the reconstructed script string. It returns `null` when no script node exists.

Traversal visits children in reverse order. That allows `splice()` to remove a child safely while iteration continues and means multiple script blocks, if present, are all pruned. Because `scriptContent` is overwritten on each match, the returned value is the earliest script in source order after reverse traversal completes. The component facade normalizes `null` to `rawScript: ''`.

Script reconstruction handles both `Text` and `Expression` children. Normally the tokenizer's `SCRIPT` state makes a script entirely `Text`; wrapping an expression child back in `{}` keeps reconstruction resilient if an AST is supplied from another source or transformed before extraction.

### `stateScanner.js` - Lightweight Script Declaration Scanner

**Export:** `scanState(scriptContent)`

`scanState()` extracts compiler metadata from raw script text without parsing or running JavaScript. It returns an empty array for missing, empty, or non-string input.

It performs two global scans:

1. `variableRegex` recognizes `let` and `const` declarations with an identifier, `=`, and a terminating semicolon. Its non-greedy multi-line value capture lets object and array initializers be recorded as source text. It emits `VariableDeclaration` nodes with `kind`, `name`, trimmed `initialValue`, and `isReactive`. Only `let` is marked reactive.
2. `functionRegex` recognizes named `function` declarations and emits `FunctionDeclaration` nodes with their names.

Variables are reported before functions because each regular expression completes its full scan before the next begins; this is part of the current output contract even when functions appear first in the script source. The scanner deliberately stops short of full JavaScript semantics. Future syntax support should replace or extend this module with a real JavaScript parser rather than continually broadening the regular expressions.

## Tests

Each implementation has an adjacent Node test file. Run the complete parser suite from the repository root with:

```bash
node --test src/compiler/parser/*.test.js
```

The tests cover normal AST construction and public error behavior, including source locations. When extending grammar or handoff shapes, update the closest test first so changes to this compiler boundary remain explicit.
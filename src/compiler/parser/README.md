# Wizz Parser

## TL;DR

This directory is the first stage of the Wizz compiler. It converts a component source string into a compiler handoff object containing:

- a renderable template AST, with each `{expression}` parsed into its own expression AST;
- declarations discovered in the component's `<script>` block;
- declared component props; and
- the original script source for later compiler stages that need it.

`parseComponent()` in `index.js` is the public entry point. Its pipeline is:

```text
component source
  -> tokenize
  -> parseTemplate
  -> integrateExpressions
  -> extractScriptBlock
  -> extractHeadBlock
  -> extractStyleBlock
  -> extractComponentImports
  -> extractProps
  -> scanState
  -> desugarBindings
  -> { template, script, rawScript, scriptSource, scriptStart, head, style, imports, props }
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
  rawScript: '\n    let count = 0;\n    function increment() { count += 1; }\n  ',
  imports: [],
  props: []
}
```

Prop declarations (`export let name = 'Guest';`) appear in `props` as `{ name, defaultValue }` in declaration order, with `defaultValue: null` when the declaration has no initializer. They also join `script` as `VariableDeclaration` entries with `isReactive: true` and `isProp: true`, so the analyzer treats them like reactive state, and they are removed from `rawScript` entirely — `export` inside the generated factory function would be invalid JavaScript.

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

// Block nodes ({#if}, {#each}) also carry their directive's location, so
// later stages (for example the server-renderability gate) can point
// diagnostics at the construct rather than at a generic position.
{ type: 'IfBlock', test: 'flag', consequent: [], alternate: [], children: [], loc: { start: { offset: 6, line: 1, column: 7 }, end: {} } }
```

```js
// The <wizz:head> block: extracted from the AST by extractHeadBlock() before
// generation, delivered through the payload's `head` field. Its children are
// Elements restricted to title (with text/interpolation children) and the
// void meta/link (static and dynamic attributes).
{
  type: 'HeadBlock',
  name: 'wizz:head',
  children: [
    { type: 'Element', name: 'title', children: [{ type: 'Expression', value: 'title', /* ... */ }], loc: {} },
    { type: 'Element', name: 'meta', attributes: [{ name: 'name', value: 'x' }, { name: 'content', value: 'd', dynamic: true }], children: [], loc: {} }
  ],
  loc: {}
}
```

```js
// The <wizz:style> block: extracted from the AST by extractStyleBlock() before
// generation and delivered through the payload's `style` field. The raw CSS
// text is opaque author input — no expressions are parsed inside it — and
// index.js stamps the deterministic scope hash alongside the CSS.
{
  type: 'StyleBlock',
  name: 'wizz:style',
  value: 'h2 { font-size: 24px }',
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
| Conditionals | `{#if condition}...{:else}...{/if}` | The parser attaches the parsed condition as `testAST`. A condition that reads reactive state is re-evaluated when that state changes and the branch is replaced; one that reads none is evaluated once, during mounting. |
| Lists | `{#each items as item (item.id)}...{/each}` and `{#each items as item}...{/each}` | Each blocks require an identifier collection and an item alias; the `item.key` parentheses are optional. Keyed and keyless forms both require exactly one native root element in their body. `on:` directives inside the body are ordinary attributes to the parser; the generator binds them per item with the item alias in scope. |
| Expressions | Identifiers; number (`1`, `1.5`), string, `true`/`false`/`null` literals; `+ - * /`; `=== !== < > <= >=`; `&&`/`\|\|`; unary `!` and `-`; the conditional `a ? b : c`; member access; calls of a name or method (`plural(n)`, `s.trim()`); parentheses | No indexing, arrays, objects, assignments, update operators (`++`/`--`, WIZZ-P056), loose comparisons, `??`, optional chaining, template literals, arrow functions, or calling a call result (WIZZ-P059). Reserved words cannot be read as names (WIZZ-P061). An expression that calls cannot mention `eval`, `Function`, `constructor`, `__proto__`, `setTimeout`, or `setInterval` (WIZZ-P060). |
| Component imports | Default imports ending in `.wizz`, such as `import Counter from './Counter.wizz';` | Imported modules are rewritten to `.js` in generated output. Named, namespace, dynamic, and non-Wizz imports are outside this contract. |
| Component props | `export let name = 'Guest';` and bare `export let count;` declarations | One prop per statement, terminated with a semicolon. `export` followed by anything other than `let` is an error. Prop names cannot be reserved words, `props`, `__proto__`, or use the reserved `__wizz` prefix. |
| Script scanning | Semicolon-terminated `let`/`const` assignments and named `function` declarations | It is a targeted regex scanner, not a JavaScript parser. `var`, classes, arrow functions, and syntax without the recognized forms are not reported. |
| Head blocks | Exactly one root-level `<wizz:head>` containing only `<title>`, `<meta>`, and `<link>` | No attributes on the block, no nesting, no second block. Bare text, expressions, or directives directly inside the block are rejected; elements inside `<title>` are rejected; void closes (`</meta>`) are rejected. |
| Style blocks | Exactly one root-level `<wizz:style>` block of raw CSS text | No attributes, no nesting, no second block, no self-closing form with content. A plain `<style>` element is rejected with a diagnostic pointing at `<wizz:style>`. CSS braces, colons, and quotes are raw text — they never reach the expression lexer — and expressions are not interpolated into CSS. |

## Files

### `index.js` - Component Parser Facade

**Export:** `parseComponent(source)`

This is the module downstream compiler stages should use. It owns the ordering of all parser steps, so each stage receives the representation it expects:

1. `tokenize()` converts raw component markup into structural tokens.
2. `parseTemplate()` verifies nesting and builds the template tree.
3. `integrateExpressions()` adds expression ASTs to interpolation nodes.
4. `extractScriptBlock()` removes script content from the render tree while returning that content.
5. `extractHeadBlock()` prunes the root-level `<wizz:head>` block and returns the `HeadBlock` node (or `null`).
6. `extractStyleBlock()` prunes the root-level `<wizz:style>` block and returns the `StyleBlock` node (or `null`); the facade then computes the component's deterministic scope hash and attaches `style: { css, scope, loc }`.
7. `extractComponentImports()` lifts `.wizz` imports out of the script.
8. `extractProps()` lifts `export let` prop declarations out of the script and records them.
9. `scanState()` turns recognized declarations into lightweight metadata.
10. `desugarBindings()` rewrites `bind:` directives into their attribute and handler halves; it runs last because it needs the declarations.

The facade also returns `scriptSource`, the unmodified script text (imports and `export let` lines still in place), and `scriptStart`, the component position of its first character (`null` without a script). Removing prop declarations shifts `rawScript`'s lines, so analyses that report component coordinates (the WIZZ-G026 warnings) scan `scriptSource` instead.

It throws `TypeError` unless `source` is a string. A component without `<script>` receives `script: []`, `rawScript: ''`, `imports: []`, and `props: []`, keeping the compiler handoff stable and avoiding special cases downstream.

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

`STATES` names the scanner's modes: text, tag parsing, quoted and brace-delimited attribute parsing, interpolation parsing, quoted interpolation strings, escape handling, and the raw-text content modes for `<script>` and `<wizz:style>`. Exporting it makes the state vocabulary explicit for tests and future maintenance.

Important behavior:

- `emitText()` flushes accumulated text only when non-empty, preventing empty text nodes.
- `emitTag()` centralizes open, close, and self-closing tag token construction.
- `commitAttribute()` stores boolean attributes (`value: null`), quoted values, and the contents of brace-delimited directive values without their surrounding braces.
- `EXPRESSION`, `EXPRESSION_STRING`, and `EXPRESSION_ESCAPE` track brace depth and quotes, so a nested object literal or a brace inside a string does not prematurely end `{...}`.
- `ATTRIBUTE_EXPRESSION`, `ATTRIBUTE_EXPRESSION_STRING`, and `ATTRIBUTE_EXPRESSION_ESCAPE` do the same for dynamic attribute values, so `class={on ? "}" : "{"}` ends at the right brace. `on:` handler values are full JavaScript, where a comment, regex, or template literal can hold an unpaired quote, so they keep plain brace counting (a conservative choice: handlers that compile today keep compiling).
- `SCRIPT` and `STYLE` treat everything as text until the exact `</script>` / `</wizz:style>` sequence. This preserves JavaScript such as `"Hello, {name}"` and CSS such as `p { color: red; }` rather than tokenizing their braces as template interpolations. All raw-text entries share one `enterRawText()` helper so open-tag variants (`<script defer>`) re-enter raw mode correctly.
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

#### Pre-family newline normalization

The HTML tree builder drops a single newline immediately after a `pre`, `textarea`, or `listing` start tag and immediately after its end tag (the authoring newline that keeps source indentation out of a preformatted box). The parser strips that one newline from the AST — a `\r\n` pair counts as the one newline; a lone `\r` is conservatively left alone — and pushes no text node at all when the newline was the whole token, so the AST models the DOM the delivered markup actually produces. The drop fires only when a Text token is the *immediately* next token: an expression or block in between could emit runtime text the compiler cannot see, so under-normalizing there is safe (worst case an adoption fallback, never wrong rendered content). Without this, the server emitted the newline, the browser dropped it from the delivered markup, and the hydration walk verified text the browser never stored.

### `expressionLexer.js` - Interpolation Lexer

**Export:** `lexExpression(input)`

`lexExpression()` tokenizes the raw string inside an interpolation. It is deliberately independent of the markup tokenizer: markup needs to find interpolation boundaries, while this lexer knows the smaller expression language.

It emits `Identifier`, `Number`, `String`, and operator/delimiter tokens (`===`, `!==`, `<=`, `>=`, `&&`, `||`, `+`, `-`, `*`, `/`, `.`, `(`, `)`, `!`, `<`, `>`, `?`, `:`, `,`, matched longest-first), followed by a mandatory `EOF` token. Whitespace is skipped. Identifiers begin with a letter or underscore and may then contain letters, digits, and underscores. Numbers are non-negative integer or decimal literals (`1.5`) converted to JavaScript `Number` values.

The generators emit an expression's raw source verbatim, so every token boundary must be the one JavaScript draws. The lexer therefore rejects source that JavaScript would read differently or refuse to load: `++`/`--` (an update operator, never two signs; WIZZ-P056), `==`/`!=` (with a pointer to the strict form), leading-zero numbers and `1.foo` (WIZZ-P057), raw line breaks inside strings, and malformed `\x`/`\u`/octal escapes (WIZZ-P057). Escapes are matched in place with sticky regexes, so escape-heavy strings lex in linear time, and the braced `\u{...}` form accepts leading zeros as JavaScript does, up to code point `10FFFF`. String escapes follow JavaScript (`\'` does not end the string) and the token's value is the cooked string; the emitted source is untouched.

Every token has line and column information relative to the interpolation string. This local location is remapped to the component location by `integrator.js`. Invalid characters raise a `SyntaxError` at the offending local coordinate.

### `prattParser.js` - Expression AST Parser

**Exports:** `PRECEDENCE`, `parseExpression(tokens)`

`parseExpression()` implements a Pratt parser over the expression-lexer tokens. A Pratt parser keeps precedence rules near the operators that use them, making this small grammar easy to extend without reorganizing a large recursive-descent parser.

`PRECEDENCE` mirrors JavaScript for the accepted subset, loosest first: `EOF`, the conditional `?`, `||`, `&&`, `===`/`!==`, `< > <= >=`, `+`/`-`, `*`/`/`, prefix `!`/`-` (`unary`), and finally member access and calls. As a result, `user.name + 1 * 2` parses property access first, multiplication second, and addition last; `-a.b` is `-(a.b)`; and `a ? b : c ? d : e` groups to the right. Because the emitted code is the raw source, a grouping that differed from JavaScript's would make dependency analysis reason about a different expression than the one that runs. `expressionParser.test.js` checks that the two agree by evaluating the AST against the source run as strict-mode JavaScript, over hand-picked cases and a seeded fuzz corpus.

The parser's internal parselets produce these AST forms:

```js
{ type: 'Identifier', name: 'count' }
{ type: 'Literal', value: 1 }
{ type: 'BinaryExpression', operator: '+', left, right }
{ type: 'MemberExpression', object, property: { type: 'Identifier', name: 'name' } }
{ type: 'Literal', value: true }                            // also false, null, strings, numbers
{ type: 'UnaryExpression', operator: '!', argument }        // or '-'
{ type: 'LogicalExpression', operator: '&&', left, right }  // or '||'
{ type: 'ConditionalExpression', test, consequent, alternate }
{ type: 'CallExpression', callee, arguments: [] }           // callee: Identifier or MemberExpression
```

Prefix parselets handle identifiers, numbers, strings, `!`/`-`, and grouped expressions. `true`/`false`/`null` become `Literal`. Strict-mode reserved words such as `new`, `delete`, `typeof`, and `import` are WIZZ-P061: they never loaded as names, and with calls in the grammar `new(x)` or `import(url)` would construct objects or load code. Infix parselets handle arithmetic, comparisons, `&&`/`||`, the conditional (a missing `:` is WIZZ-P058), member access, and calls. A callee must be a name or a method (WIZZ-P059), and arguments are comma-separated with no trailing comma.

An expression containing a call gets one more check after parsing: `eval`, `Function`, `constructor`, `__proto__`, `setTimeout`, and `setInterval` anywhere in it are WIZZ-P060, since those are the ways to turn a string into running code (`x.constructor.constructor(s)` is `Function(s)`). Template expressions share the script's trust, so this is defense in depth rather than a sandbox. Expressions without a call are not checked, so `{x.constructor.name}` keeps compiling as before. The check walks the AST iteratively, and every recursive parselet (groups, prefix operators, conditional branches, call arguments) draws on the WIZZ-P053 depth budget. The final `EOF` check is essential: it rejects partial parses such as `1 2` instead of accepting the first valid fragment and ignoring the rest. Parser errors include the location supplied by the lexer, including missing `)` and a non-identifier property after `.`.

### `integrator.js` - Template Expression Integration

**Export:** `integrateExpressions(node)`

`integrateExpressions()` recursively visits a template AST. For each `Expression` node, it calls `lexExpression(node.value)` and `parseExpression(tokens)`, then assigns the result to `node.expressionAST`.

Static (quoted) attribute values are checked too: a `{...}` group inside one whose content parses as an expression (`class="card {tone}"`) throws `WIZZ-P055`, naming the attribute and suggesting the unquoted form (`class={"card " + tone}`). An operand that binds as loosely as `+` or looser is parenthesized in the suggestion (`class={"card " + (on ? 'a' : 'b')}`). Brace groups that are not expressions (`'{"a":1}'`, `{}`) stay literal text, and `on:` attributes are skipped.

It intentionally mutates and returns the same AST. The mutation preserves template node identity for callers while enriching it with compiler-ready expression structure. Keeping the original `value` alongside `expressionAST` also preserves the source form for diagnostics or future transforms.

The error wrapper is a key boundary in the pipeline. Expression lexer/parser locations are local to the interpolation; this module translates them using `node.loc.start` and throws a `SyntaxError` in component coordinates:

```text
Template Expression Error at <line>:<column> - <expression error>
```

That translation ensures a developer can find a bad expression from the original component file rather than manually calculating offsets inside a brace-delimited fragment.

Dynamic attribute (WIZZ-P032) and `{#if}` test (WIZZ-P031) failures append the expression error's reason with its expression-local location removed, because errorAugmenter stamps the first `at L:C` in a message as the component location.

### `extractor.js` - Script Extraction and Pruning

**Export:** `extractScriptBlock(ast)`

`extractScriptBlock()` walks the integrated template AST looking for `Element` nodes named `script`. When it finds one, it reconstructs its source content, removes that node from its parent's `children`, and returns the reconstructed script string. It returns `null` when no script node exists.

Traversal visits children in reverse order. That allows `splice()` to remove a child safely while iteration continues and means multiple script blocks, if present, are all pruned. Because `scriptContent` is overwritten on each match, the returned value is the earliest script in source order after reverse traversal completes. The component facade normalizes `null` to `rawScript: ''`.

Script reconstruction handles both `Text` and `Expression` children. Normally the tokenizer's `SCRIPT` state makes a script entirely `Text`; wrapping an expression child back in `{}` keeps reconstruction resilient if an AST is supplied from another source or transformed before extraction.

**Export:** `extractHeadBlock(ast)` (also from this module)

`extractHeadBlock()` finds the root-level `HeadBlock` node the template parser created for `<wizz:head>`, splices it out of `Root.children` so body generation never sees it, and returns the node — or `null` when the component declares no head. The block's children (title text, static and dynamic attributes) ride along inside the returned node for the generators to consume.

**Export:** `extractStyleBlock(ast)` (also from this module)

`extractStyleBlock()` performs the same splice for the root-level `StyleBlock` node the template parser created for `<wizz:style>`, so the raw CSS never reaches body generation.

### `componentImportExtractor.js` - Component Import Extraction

**Export:** `extractComponentImports(scriptContent)`

`extractComponentImports()` scans the script for default imports ending in `.wizz`, records `{ name, source }` pairs in source order, and removes the statements from the returned script. Only imports that are alone on their line are recognized (the regex anchors to the line), so `import` inside larger statements passes through untouched. Missing or non-string input returns `{ imports: [], script }` unchanged.

### `propExtractor.js` - Prop Declaration Extraction

**Exports:** `extractProps(scriptContent)`, `RESERVED_PROP_NAMES`

`extractProps()` finds `export let` prop declarations, records `{ name, defaultValue }` in declaration order, and removes the statements from the returned script so the generator can emit the prop bindings in their place. `defaultValue` is the trimmed source text of the initializer, or `null` for a bare `export let count;`.

Statement extents are resolved on the shared scriptLexer token stream (`../scriptLexer.js`, a compiler-root utility also used by the generator's assignment interceptor), so strings, template literals, comments, and regex literals cannot hide a semicolon, a nested `export`, or a statement boundary. The scan runs at top level only — `export` inside a nested block is an error, while `config.export` property access and `export`-looking text inside strings or comments are ignored.

The default expression runs to the first `;` back at the declaration's own nesting depth; a terminating semicolon is required, and an identifier directly after a completed operand (the start of a new statement) or a bare comma (a second declarator) is rejected rather than silently absorbed. Defaults are author-script expressions — full JavaScript — not the narrower template expression grammar.

`persist()` cannot initialize a prop: a default whose text starts with `persist\s*\(` throws a located `SyntaxError` (`persist() cannot initialize the prop '<name>'; props are parent-owned…`), because a prop's value is parent-owned and storage-reading it client-side would split ownership between two components.

`RESERVED_PROP_NAMES` is the set of names that cannot be props: strict-mode reserved words, the generated closure's `props` parameter, `__proto__`, and every `__wizz`-prefixed name, which the framework reserves for generated identifiers.

### `bindings.js` - Two-Way Binding Desugaring

**Export:** `desugarBindings(template, { script, imports })`

`bind:value={name}` and `bind:checked={done}` (issue #73) are sugar. Each becomes exactly what an author writes by hand, in place in the element's attribute list:

```js
// <input bind:value={name} />
{ name: 'value', value: 'name', dynamic: true, expressionAST, bind: 'value' }
{ name: 'on:input', value: '(__wizzEvent) => { name = __wizzEvent.target.value; }', bindFor: 'value' }
```

Every later stage already handles both halves: the dependency analyzer tracks the attribute, the generator's inline-handler interception queues the update (and routes persistent state through its storage write), branches and hydration attach the listener in their own scopes, and the server renders the attribute and skips `on:`. `<select>` and checkboxes listen to `change`, everything else to `input`. A static `type="number"` or `"range"` coerces (`'' ? null : +value`) and marks the attribute `bind: 'number'`, which the generators write through the `__wizzSetNumber` guard. The handler's parameter carries the reserved `__wizz` prefix, so it cannot shadow the bound name.

Diagnostics, all located at the element:

- **WIZZ-P062** (`unsupportedBinding`): a property other than `value`/`checked`; an element other than `<input>`/`<textarea>`/`<select>`; `bind:value` on a checkbox, radio, or file input; `bind:checked` on anything but a checkbox; a dynamic `type`; an imported component tag; a binding inside an `{#each}` body (an item re-renders only when its collection changes, so the state-to-control half would go stale, and an item variable could shadow the bound name).
- **WIZZ-P063** (`invalidBindingTarget`): a quoted or bare value, a target that is not a plain identifier, a prop (read-only), a `const`, or an undeclared name.
- **WIZZ-P064** (`conflictingBinding`): an explicit `value`/`checked` beside the binding, or the same property bound twice.

An author `on:input` beside `bind:value` is kept; both listeners attach, the author's first in source order.

### `stateScanner.js` - Lightweight Script Declaration Scanner

**Export:** `scanState(scriptContent)`

`scanState()` extracts compiler metadata from raw script text without parsing or running JavaScript. It returns an empty array for missing, empty, or non-string input.

It performs two global scans:

1. `variableRegex` recognizes `let` and `const` declarations with an identifier, `=`, and a terminating semicolon. Its non-greedy multi-line value capture lets object and array initializers be recorded as source text. It emits `VariableDeclaration` nodes with `kind`, `name`, trimmed `initialValue`, and `isReactive`. Only `let` is marked reactive.
2. `functionRegex` recognizes named `function` declarations and emits `FunctionDeclaration` nodes with their names.

Variables are reported before functions because each regular expression completes its full scan before the next begins; this is part of the current output contract even when functions appear first in the script source. The scanner deliberately stops short of full JavaScript semantics. Future syntax support should replace or extend this module with a real JavaScript parser rather than continually broadening the regular expressions.

#### Persistent-state markers

When a variable declaration's initializer text starts with `persist\s*\(`, `scanState()` parses the marker instead of recording the raw text alone. A persistent declaration keeps every field above and adds `isPersistent: true`, `storageKey` (the cooked string-literal first argument), `defaultValue` (the source text of the second argument, trimmed), and the `initialValueStart`/`initialValueEnd` offsets of the whole `persist(…)` span — offsets, not re-matched text, so look-alike `persist(...)` text in earlier comments or strings cannot redirect the generator's later splice. Plain declarations keep their node shape byte-for-byte (no new fields), which the tests pin with a deepEqual.

Marker parsing is hand-rolled for the same reason the rest of the scanner is: no full parser, but no false confidence either. `walkPersistArguments()` tracks a mode stack (round/curly/square brackets, single/double/template quotes with the quote character itself as the mode, line and block comments) and splits only top-level commas, so defaults may contain object literals, nested calls, and comment noise. Everything malformed is a located compile error, never a silent guess: `persist()` on a `const` (it must be reactive), a missing or non-string-literal key (only simple `\`-escape sequences are cooked; `\x41`-style escapes reject), an argument count other than two, statements after the closing parenthesis, a missing closing parenthesis, mismatched brackets, and template-literal interpolation in the default (the default must survive string splicing into arbitrary target code, and interpolated expressions cannot). The default expression itself is carried as opaque source text — the generator decides how to embed it.

#### Marker placement

The marker must initialize a **top-level** `let` declaration, and the scanner enforces it because the generators hoist every state reference to the component's mount scope: a marker inside a function body or block would emit read/write/subscribe machinery that references a variable existing only in the callback's own scope, and the first template evaluation would die with a `ReferenceError` of the declaration's own name — a component this rejects never worked, so the located error strictly replaces the runtime failure (`persist() must initialize a top-level let declaration; 'rawClicks' is declared inside a block or function body at 2:17.`). A `persist()` call nested inside another `persist()` default would survive the initializer splice verbatim and fail at runtime with `persist is not defined`; it is rejected too (`persist() cannot be nested inside another persist() default…`).

Placement detection walks the script with `lexicalModesBefore()` — the same quote/comment/bracket mode stack as `walkPersistArguments()`, extended with regex-literal handling: a `/` opens a literal unless the previous significant character continues an expression (identifier character, closing bracket, quote, dot, or operator tail), so a regex literal containing quotes or comment starters cannot leave phantom modes open and make a top-level marker look nested. Division after prefix operators (`x++ /2/`) is the accepted residual ambiguity. An author who binds the name `persist` themselves — a `function persist()` or a `let/const persist =` — opts out of marker recognition entirely: no marker is recognized and no marker diagnostic applies, so scripts that compiled before the marker syntax existed keep compiling.

## Tests

Each implementation has an adjacent Node test file. Run the complete parser suite from the repository root with:

```bash
node --test src/compiler/parser/*.test.js
```

The tests cover normal AST construction and public error behavior, including source locations. When extending grammar or handoff shapes, update the closest test first so changes to this compiler boundary remain explicit.
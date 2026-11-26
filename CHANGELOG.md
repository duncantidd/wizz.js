# Changelog

All notable changes to Wizz are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), adapted for this project's roadmap-driven workflow: work is grouped by roadmap milestone rather than by release, since nothing has shipped a numbered release yet. Everything below lives under **Unreleased**.

- **Added** for new features.
- **Changed** for changes in existing behavior.
- **Fixed** for bug fixes.
- **Docs** for documentation-only work.

## [Unreleased]

### Added — Array Mutation Reactivity Documented and Guarded (milestone 26; compiler 1.25.0 → 1.26.0, output 1.13.0 → 1.13.1, syntax 1.6.0 unchanged)

#### Versions

- Compiler minor for a new analyzer finding. Warnings never change output and no component that compiled before is rejected, so syntax holds. Output patch for the rewriter fix under "Fixed (review of milestone 26)"; every other module is byte-identical apart from the version banner. `package.json` moves to 1.26.0 in lockstep.
- Recorded decision: local state never gains an identity check. Every statement-level assignment schedules an update, so `items.push(x); items = items;` keeps working; props keep their separate `Object.is` short-circuit in `setProps`. Proxy-based deep reactivity and instrumenting array methods stay out of scope.

#### Added

- **WIZZ-G027** (`CODES.generator.inPlaceMutation`), a compiler warning: a statement-level call of `push`, `pop`, `shift`, `unshift`, `splice`, `sort`, `reverse`, `fill`, or `copyWithin` on a reactive, non-prop `let` (persistent state included), inside a function body or inline `on:` handler, with no later mutation of that name (assignment, member write, or update operator; rewritten or untracked) before the outermost enclosing function closes. Reported through the WIZZ-G026 channels: `compile().warnings`, `Warning WIZZ-G027: …` lines in human builds, `diagnostics` records in `--json`, and the MCP `component_diagnostics` and `create_or_update_component` tools. The message is located at the call (handlers: at their element) and its hint names both fixes, specific to the method: `items.sort(…); items = items;` or `items = items.toSorted(…)`.
  - Not reported, by design: calls at the top level of the script (they run before the first render reads state), props (read-only, so reassignment is not the fix), names shadowed by a parameter, local declaration, for-header, or `{#each}` item, calls in expression position (`const n = items.push(x)`, `return items.pop()`, `g(items.push(x))`, an expression-bodied arrow outside a handler, an unbraced `if (x) items.push(x)` on one line), handler values that are not function literals, and a call followed by a reassignment in a nested callback (`setTimeout(() => { items = items; })`).
  - Documented blind spots (syntactic analysis): aliases (`const a = items; a.push(x)`), computed member names (`items['push'](x)`, `items.push.call(…)`), and `Map`/`Set` methods.
- `assignmentInterceptor.js`: `findInPlaceMutations(source, names)`, `findInPlaceHandlerMutations(expression, names)`, and `findUnscheduledChanges(source, names)`, which returns the untracked mutations and the unfollowed in-place calls from one scan. `scanReactiveMutations()` takes an optional `methodCalls` collector and marks function-body contexts (`opensFunctionBody()`); the rewrite is unchanged. In-place calls also begin a statement on a new line after `)` (semicolon-less scripts), which the rewriter's own ASI rule deliberately excludes. Suppression uses per-name sorted offsets and a binary search per call, and locations are computed in one ascending pass (`findUntrackedMutations()` now uses the same pass instead of rescanning the source per site).
- `untrackedWarnings.js` emits both codes: script findings merged in source order, then handler findings in template order (G026 before G027 within one handler). The component script is scanned once for both.

#### Docs

- README: the `{#each}` collection row (generated from the MCP limits table) teaches `items.push(x); items = items;` beside the copy form and names WIZZ-G027; a new "Arrays and objects" subsection explains that the assignment, not a new reference, is the trigger, that member writes schedule the root name, that keyed and keyless lists re-run each item's update for in-place-changed items, and why there is no deep reactivity; the Lists section links it; "Compiler Warnings" documents WIZZ-G027 and its limits.
- MCP `language_contract` script boundary gains the same rules; `src/compiler/README.md`, `src/compiler/generator/README.md`, and `STRUCTURE.md` describe the analysis.

#### Fixed (review of milestone 26)

- One parameter-list rule. `classifyParenGroup()` now backs the rewrite's parameter shadowing, the parameter-default check, and the new function-scope detection; before, `collectCallBodyParameters()` lagged behind the other two. Parameters of anonymous generators (`function* (items) {}`), computed methods (`[k](items) {}`), reserved-word methods (`set(items) {}`, `delete(items) {}`), and functions named by contextual keywords (`function set(items) {}`) now shadow reactive names. This removes false WIZZ-G027 and WIZZ-G026 reports, and the rewriter no longer emits a spurious `__wizzQueueUpdate({ items: true })` (plus a `__wizzPersistWrite` of the parameter's value for persistent state) when such a parameter is assigned. That last part is pre-existing behavior in generated code, hence the output patch.
- Functions named by contextual keywords (`get`, `set`, `of`, `async`, `static`) are function scopes, so an unfollowed in-place call inside `function set() {}` or `async function get() {}` is reported instead of being treated as script initialization.
- In semicolon-less scripts, the in-place check runs after the shadow tracking for the token, so the parameters of an expression-bodied arrow (`const copy = items => items.slice()`) and the bindings of an unbraced `for` header stop shadowing at the next statement. The unbraced body itself stays shadowed.
- Each inline handler is normalized and scanned once for both codes (`findUnscheduledHandlerChanges()`), mirroring the script path.
- Comments in `src/compiler/index.js`, `build.js`, `scripts/mcpTools.js`, and `src/compiler/parser/README.md` that described the warnings as WIZZ-G026 alone now name both codes.
- Known trade-off, kept: suppression is scoped to the outermost enclosing function, so inside an `onMount(() => { … })` callback a later assignment anywhere in that callback (a cleanup function, a sibling handler) silences an earlier nested call. This avoids false positives on synchronous callbacks such as `forEach`.

#### Tests

- `componentGenerator.test.js` pins the semantics with mounted components: a bare push does not update; push plus self-assignment updates a keyless list; an element write updates by its root name; a keyed list re-runs `update` for an item mutated in place under the same reference without recreating its node; a keyless list does the same by position; `{items.length}` and `{#if items.length === 0}` follow push plus self-assignment; `user.name = x` schedules `user`; inline-handler self-assignment updates; a self-assignment in a loop renders each item once.
- `assignmentInterceptor.test.js`: every method, suppression rules, function-scope kinds (arrow, async, function expression, generator, object and class methods, getters, `onMount` callbacks), control-flow blocks, shadowing, expression position, blind spots, optional chaining, comments, ASI, strings and regexes, unchanged rewrite, handlers, and a linear-time check. `untrackedWarnings.test.js`: located records, method-specific hints, ordering, props and persistent state, handlers, each shadowing, and prototype-named state. Channel tests in `index.test.js`, `build.test.js`, and `scripts/mcpTools.test.js`.

### Added — Compact Production Builds (milestone 23; compiler 1.24.0 → 1.25.0, syntax 1.6.0 and output 1.13.0 unchanged)

#### Versions

- Released as 1.25.0. The compactors are build-time tools applied to finished artifacts, not `compile()` stages, so generated module structure is untouched and a normal `wizz build` differs only in the version banner. The compiler moves because `scriptLexer.js` parsing changed (the line-terminator fix under Fixed) and because the package version is pinned in lockstep with it. Syntax 1.6.0 and output 1.13.0 hold.
- Dropping Node 18 and 20 ships in this minor by decision: it changes supported platforms, not any contract surface (component syntax, generated output, CLI, or the diagnostics envelope).

#### Added

- `wizz build --compact` (and `node build.js ... --compact`): accepted in any position, at most once, `build` only — `init` now rejects it explicitly instead of reading it as a directory, and `dev`, `mcp`, `update`, `install-vscode-extension`, and `--version` reject it through their existing strict checks. It combines with `--json` and `--adapter node`. `parseBuildArguments()` and `parseCommand()` results gain a `compact` boolean; `buildProject(..., { compact: true })` is the programmatic form.
- `src/compiler/compact/`: zero-dependency `compactJs`, `validateJs`, `compactCss`, and `compactHtml`. Each removes comments and insignificant whitespace only (no mangling or semantic transforms) and throws a `SyntaxError` with 1-based `line`/`column` on malformed input.
  - `compactJs` reuses `scriptLexer.js` and rewrites only inter-token gaps: nothing, one space where the touching characters would merge (`return x`, `a - -b`, `a / /re/`, `1 .toFixed()`, `c ? .5 : 1`), or one newline where the gap held a line break that ASI or a restricted production may depend on. Breaks are dropped only after a punctuator that cannot end a statement or before `) ] } , ; .`; a removed block comment containing a newline still counts as one. Lexically ambiguous `/` positions (after `)`, `}`, `of`, a keyword used as a property name, or a non-ASCII identifier character) copy the rest of their line verbatim, and the output is re-tokenized and must match the source token for token. Hashbang lines are preserved. Output is accumulated in parts so the scan stays linear (indexing a growing concatenated string makes V8 flatten it on every read).
  - `compactCss` keeps strings, unquoted `url()` bodies, escapes with their terminating whitespace, whitespace before `:` and `(` and after `)`, operator spacing in `calc()`, and an empty custom property's space; it drops whitespace next to `{ } ; ,`, after `:`/`(`, before `)`, and a block's final `;`. A comment that separated two tokens becomes `/**/`.
  - `compactHtml` collapses text whitespace runs to one character (a newline if the run had one) and removes comments except conditional comments and `<!--wizz` markers. Tags and attributes are copied byte for byte, as are `script` (every type, including `application/wizz-state`), `style`, `pre`, `textarea`, `listing`, `xmp`, `iframe`, `noembed`, `noframes`, and `plaintext` content.
- Under `--compact` the build compacts the client, `.server.js`, and `.hydrate.js` modules, the copied `dist/runtime/**`, both manifests, `wizz.css` (without the per-file header comments; `@import` rules stay hoisted first), the copied `App.css`, `dist/index.html`, and `dist/server.mjs` when the node adapter runs. Authored API handlers under `dist/server/**` stay verbatim copies.
- Under `--compact` no `.map` file and no `//# sourceMappingURL` comment is written, and a map an earlier readable build left beside a module is removed. Normal builds keep their maps.
- Located failures under `--compact`: an authored `<script>` or `<wizz:style>` block with an unterminated string, comment, template literal, or `url()` fails that component with an uncoded diagnostic carrying its `.wizz` line and column (`Unterminated string literal in the <script> block (line 3, column 9)`), and nothing is written for it. A malformed `index.html` or `App.css` fails the build with `path:line:column`, and neither file of the pair is written. JSON-mode error records now carry `line`/`column` whenever the underlying error is located.
- The `wizz-build-diagnostics@1` envelope gains an additive `compact: true` field, present only for compact builds.
- `writeGeneratedModule` is exported from `build.js`; `copyRuntimeModules`, `writeExtractedStyles`, `copyDocumentShell`, `copyApiHandlers`, `emitRouteManifest`, `emitNodeAdapterHost`, and `writeEligibleServerBuilds` take an optional trailing `compact` argument (default `false`, so existing callers are unchanged).
- `scriptLexer.js` additionally exports `PUNCTUATORS` and `scanRegex` for the compactor.
- Tests: `src/compiler/compact/{js,css,html}Compactor.test.js` (execution equivalence under `node:vm` for ASI hazards, regex/division ambiguity, nested templates, `</script>` in strings, unicode escapes, and non-ASCII identifiers; CSS `content:` strings, `url()`, escapes, and combinators; HTML raw-text elements and state payloads; located failures; idempotence; linear scaling). `test/compactBuild.test.js` builds the scaffold both ways and compares SSR markup, head, and state per route, the client DOM through every interaction, hydration, and the node adapter's page and API responses. `test/benchmarks.test.js` records the size reduction and compaction time (19.2% across 20 generated and runtime modules, about 50 ms). `build.test.js` and `scripts/cli.test.js` pin the flag discipline, envelope, map suppression, and located failures.
- `wizz mcp`'s `dev_workflow` text, the README, STRUCTURE.md, and `src/compiler/README.md` document the flag. The MCP `build_project` tool accepts `compact: boolean` beside `adapter` and echoes `compact: true` in its structured result.
- `scripts/install-cli.test.js` pins the installer's Node 22 floor with a stub `node` on PATH (18 and 20 refused before anything installs; 22 passes).

#### Fixed (review of the first milestone 23 commit)

- `scriptLexer.js` ended line comments only at LF. A comment ended by CR, U+2028, or U+2029 swallowed the code after it, so `compactJs` deleted that code silently (and the self-check, using the same lexer, agreed). Every ECMAScript line terminator now ends a line comment and sets `newlineBefore`; a regex literal cannot span any of them; a CRLF line continuation (a backslash then CRLF) stays inside its string or template instead of reading as an unterminated literal; and a raw CR ends a string as a raw LF does (U+2028/U+2029 remain legal string content).
- `compactCss` read a CRLF line continuation inside a string as an unterminated string.
- Valid JavaScript with a regex at a lexically ambiguous position (after `)`, `}`, or `of`) holding a quote, backtick, or `/*` (`if (c) /don't/.test(s)`) failed with "Unterminated ..." because validation ran on the lexer's division reading. A validation or self-check failure now returns the input unchanged (and `validateJs` accepts it) only when it comes after such a `/` whose regex reading holds a quote, backtick, or slash, the characters that change how the lexer reads the rest of the line. A failure before any such slash, or in a file whose ambiguous slashes are plain chained division (`(8) / 4 / 2`), still fails the build with its location.
- A verbatim span ending in a line comment (`(x) / 2 // half`) could drop the following line break and glue the next line into the comment ("Internal compaction error"). The break after a verbatim span is now always kept.
- Authored-block validation re-scanned the raw `.wizz` text with regexes, so an attribute value containing `<script>` text was mistaken for the script block (failing valid components, or hiding the real block). It now uses the compiler's parse (`payload.scriptSource`/`scriptStart`, `payload.style`).
- A compaction failure inside generated code (a malformed inline handler body) stamped generated-module line/column onto the `.wizz` file. Such errors now say `Compaction failed for generated module App.js: ... (generated line N, column M)` and carry no `line`/`column` fields.
- A malformed `index.html` was reported one line late (or shifted a column) when the build injected or rewrote the stylesheet link first. The authored shell is now compacted before the link rewrite and injection.
- `scriptLexer.js` read a `/` after a closing template literal as the start of a regex, although a template is an operand: `` (`${w}` / h // note `` compacted to code that no longer parsed while passing the self-check, and `` `${x}` / 2 + "a / b" `` failed as an unterminated string. A closing backtick now ends an operand like `)`.
- `scriptLexer.js` read the `/` in `export default /re/` as division, so `compactJs` collapsed whitespace inside the regex or failed on a quote in it. `default` now allows a regex, and the compactor treats `obj.default / 2` as the known property-name case.
- `compactHtml` treated `<title>` as ordinary markup, though it is RCDATA: `<!--` and `<x` inside it are literal text. Its content is now copied verbatim.

### Changed — Supported Node.js versions: 22, 24, and 26

- Node 18 and 20 are end-of-life and no longer supported. `package.json` `engines.node` is `>=22`, the CI matrix runs 22, 24, and 26, the release workflow runs on 24 (Active LTS), and `scripts/install-cli.sh` refuses Node older than 22. The README, the scaffold README template, STRUCTURE.md, and `packaging.test.js` say the same.
- The `dist/package.json` `{"type":"module"}` marker and the dev server's recursive-watch fallback stay: Node 22 before 22.7 has no unflagged module-syntax detection, and the fallback still covers any platform without recursive `fs.watch`. Comments that justified them by Node 18/20 now state the current reason.

### Added — Bare-Bones Project Scaffolding (milestone 24; compiler 1.23.0 → 1.24.0 as a release bump, syntax 1.6.0 and output 1.13.0 unchanged)

#### Versions

- Released as 1.24.0. The change is CLI and templates only and leaves the compiler pipeline untouched, but `package.json` is pinned in lockstep with `VERSIONS.compiler` and the release workflow refuses a tag that does not match it, so shipping the new `wizz init` capability takes a compiler minor (as milestone 19 did for `wizz init` itself). Generated modules differ from 1.23.0 only in the `// Generated by Wizz 1.24.0` banner.

#### Added

- `wizz init` asks `Bootstrap with sample code? [Y/n]` before writing anything. Enter, `y`, or `yes` (any case, surrounding whitespace ignored) chooses the sample project; `n` or `no` chooses the bare template; anything else asks again. The prompt is written to stderr through `node:readline`, so stdout carries only the `Created ...` report. Ctrl+C aborts with exit code 130 and end of input with exit code 1, both printing `Init aborted: no files were written.`
- `--sample` and `--bare` init flags answer the question up front. They are init-only (every other command rejects them), mutually exclusive, and each accepted at most once; lookalikes such as `--bare=yes` count as a directory argument.
- The bare template writes `README.md`, an `index.html` shell with no stylesheet link or `theme-color`, and a placeholder `src/App.wizz` served at `/` — no `App.css`, `src/components/`, `src/pages/`, or `src/server/api/` handler. Its README describes the bare layout and how to add pages, components, a global stylesheet, and API handlers. `wizz build`, `wizz build --adapter node`, `wizz dev`, and the MCP `project_overview` tool all handle it with no warnings, notes, or discovery errors (verified by tests; no toolchain change was needed).
- `scripts/init.js` exports `checkInitTarget()` (the directory checks without writing, run before the prompt so an unusable target is reported before the question), `interpretTemplateAnswer()`, `promptForTemplate(ask)`, `createReadlineAsk()`, and `TEMPLATE_PROMPT`. The default `ask` shares one readline interface across re-asks and queues lines that arrive while no question is open, so typed-ahead or piped answers are not lost.

#### Changed

- `scripts/initTemplates.js` exports `{ TEMPLATE_SETS, DEFAULT_TEMPLATE }` instead of the bare sample map. `TEMPLATE_SETS` is a frozen null-prototype table of frozen file sets (`sample`, `bare`); `initProject(target, { template })` selects a set by name and refuses unknown or inherited names (`__proto__`, `constructor`, ...) before touching the disk. Every existing guard is unchanged: `--force` semantics, all-or-nothing conflict refusal, and target checks. The target directory is now created after the conflict check rather than before it.
- The scaffold README is assembled from shared fragments (intro, build/layout body, editor setup); the sample project's files are byte-identical to before.
- `runCli` resolves the init template from the flag, then from `--json` or a non-TTY stdin (sample, synchronously, so scripted calls are unchanged), and only otherwise prompts — returning a promise of the exit code on that path. `stdinIsTTY` and `ask` are injectable dependencies. `parseCommand` now reports `json` and `template` for init.

#### Assumption

- The roadmap listed `package.json` among the bare files. Milestone 19's canonical shape does not include one, the sample has never written one, and nothing reads one from the project root (`wizz build` writes its own `dist/package.json`), so the bare template omits it and stays a strict subset of the sample's paths. Documented in `scripts/initTemplates.js`.

### Added — Two-Way Bindings and Untracked-Assignment Warnings (issue #73; ships in the same unreleased compiler 1.23.0 and syntax 1.6.0 as issue #69; output 1.12.0 → 1.13.0)

#### Added

- `bind:value={name}` on `<input>`, `<textarea>`, and `<select>`, and `bind:checked={done}` on `<input type="checkbox">`, two-way with a top-level `let` (#73). `type="number"`/`"range"` inputs bind numbers, with an empty field as `null`. Bound `let`s may be persistent; bindings work inside `{#if}` branches, server-render their value, and hydrate.
- `src/compiler/parser/bindings.js`: `desugarBindings()` rewrites each binding into exactly what an author writes by hand, a dynamic `value`/`checked` attribute plus an inline `on:input`/`on:change` handler assigning the bound name, so every later stage handles it with its existing machinery. It runs last in `parseComponent()` because it needs the script declarations.
- Binding diagnostics, located at the element:
  - **WIZZ-P062** — unsupported binding: another property (`bind:group`, `bind:this`), another element, `bind:value` on a checkbox/radio/file input, `bind:checked` off a checkbox, a dynamic `type`, a component tag, or a binding inside an `{#each}` body.
  - **WIZZ-P063** — invalid target: not brace-delimited, not a plain identifier, a prop, a `const`, or undeclared.
  - **WIZZ-P064** — an explicit `value`/`checked` beside the binding, or one property bound twice.
- **WIZZ-G026**, the compiler's first warning: a reactive variable assigned where the update scheduler does not see it — call arguments, conditions, object literals, template interpolations, unbraced `if`/`else`/loop bodies, chained targets, and `on:` values that are not functions (`on:click={count = 1}` runs once, at mount). `compile()` results carry an additive `warnings` array of diagnostic-shaped records with `severity: 'warning'`; warnings never fail a compile.
- `assignmentInterceptor.js`: `findUntrackedMutations()`/`findUntrackedHandlerMutations()` report what the rewriter leaves alone. Parameter defaults, declaration bindings (destructuring defaults included), class fields, `obj.count = 1`, and names shadowed by a parameter (expression-bodied arrows included) or a local declaration are excluded. `src/compiler/generator/untrackedWarnings.js` turns the findings into records located in the component file.
- The parser handoff gains `scriptSource` (the unmodified script text) and `scriptStart` (its component position). Removing `export let` lines shifts `rawScript`'s lines, so warnings scan the original text to report exact file coordinates.

#### Changed

- Inline handlers whose whole body is a parenthesized assignment, `on:input={(e) => (name = e.target.value)}`, are instrumented like the unparenthesized form. Before, the parentheses put the assignment in expression position, so state changed with no update and no error. Object-literal bodies (`() => ({ a: 1 })`) and declaration starts stay as they were.
- `attributePolicy.js`: `attributeWriteSource()` takes a `bind` option; the value half of a numeric binding writes through the module-scope `__wizzSetNumber(node, value)` helper, which leaves a field alone when it already shows the state's value. Without it, a half-typed `1.` (which the browser reports as `''`) would be erased. The helper is emitted only when a numeric binding exists.
- `build.js`: human builds print `Warning WIZZ-G026: …` after a file's "Compiled" line (through `logger.warn` when the logger has one); `--json` adds warning records to `diagnostics` without changing `ok` or the `wizz-build-diagnostics@1` record shape.
- MCP: `component_diagnostics` lists warnings after errors with `ok` still errors-only (summaries read "N diagnostic(s), M warning(s)"; project-wide mode lists files with warnings), and `create_or_update_component` writes a component that only has warnings and returns them. The limits table gains a Bindings row; the Event handlers row now names WIZZ-G026 instead of "Silent"; `language_contract` documents `bind:` and warnings.
- Versions: the compiler (1.23.0) and syntax (1.6.0) bumps from issue #69 are unreleased, so they cover this work too. **Output minor**, 1.12.0 → 1.13.0: numeric bindings add a module helper and parenthesized-assignment handlers gain their update call. Every other module is byte-identical apart from the version header, and the module surface is unchanged.

- Review follow-ups (same unreleased versions):
  - `bind:` on a `<wizz:head>` child is WIZZ-P062. The head block is pruned from the template before desugaring, so it is now desugared on its own; before, `<meta bind:value={x}>` compiled to a literal `bind:value` attribute in the document head.
  - An `async function` arrow body, parenthesized or not (`() => (async function () { count = 1 })`), stays an expression. It was moved into statement position, where an anonymous `async function` is a SyntaxError at module load.
  - A `for (let count = 0; count < n; count++)` header no longer clears its declaration at its own `;`s. The braced loop body is now shadowed for the rewrite as well, so a loop variable named like a reactive `let` is no longer instrumented as component state, and WIZZ-G026 no longer fires on the header's update clause. Over an unbraced body the declaration covers that one statement and cannot leak into the next block.
  - Expression-bodied arrow parameters stop shadowing at a new statement (semicolon-less scripts) and at a ternary `:` the arrow did not open, so WIZZ-G026 is no longer suppressed for the rest of the script or the other branch.
  - Defaults of generator parameters (`function* (count = 1)`), computed methods (`[k](count = 1)`), and methods named by reserved words (`delete(…)`, `get(…)`, `async get(…)`) are recognized as parameters, not WIZZ-G026 sites.

#### Migration

- A handler written `(e) => (x = …)` now updates the DOM. Code that relied on it not updating had a silent bug. If the assigned name is a prop, the handler now fails with WIZZ-G015, like the unparenthesized form always did.
- Projects that compile with warnings keep building; review each WIZZ-G026 site and make the assignment a statement of its own.
- Hand-written `value={x}` + `on:input` pairs keep working unchanged; `bind:value` is optional sugar for them.

#### Known limits

- A server-rendered `<textarea>` or `<select>` shows its bound value only after hydration, because the server writes `value` as an attribute, which those elements do not display. This is the existing behavior of `value={...}` on them.
- `{#each}` item bodies re-render only when their collection changes, which is why bindings are rejected there; any item text or attribute that reads outer state has the same staleness.

#### Tests

- `parser/bindings.test.js`: desugared shapes for text, number, range, textarea, select, and checkbox bindings; nested `{#if}` branches; persistent targets; an author `on:input` beside a binding; every WIZZ-P062/P063/P064 case, including each-body bindings and an item variable shadowing the bound name.
- `generator/assignmentInterceptor.test.js`: parenthesized bodies (nested pairs, async, trailing comments, prop detection) and the forms left alone; untracked reporting across expression position, unbraced bodies, chains, and update operators; every excluded form; expression-arrow shadow scoping; rewriting unchanged by the analysis; handler analysis.
- `generator/untrackedWarnings.test.js`: records located in the component with imports and props in place, first-line column offsets, handler warnings in template order across branches, each-item shadowing, bind handlers and clean components without warnings, and records without a file.
- `generator/attributePolicy.test.js`: the numeric write path, `__wizzSetNumber` against half-typed and equal-but-differently-spelled values, and `needsNumberBindHelper`.
- `index.test.js`: `bind:` on every target beside an author handler, and the `warnings` contract (non-fatal, collect mode, clean components, no server repeat, none on failure).
- `test/endToEnd.test.js` + `test/fixtures/bindings.wizz`: a mounted component edits text, number (including a cleared field), checkbox, select, and a parenthesized textarea handler into state and back. `test/hydration.test.js`: bound controls server-render their values, hydrate without recreation, stay two-way across a reactive branch, and drop the branch's listener.
- `build.test.js` and `mcpTools.test.js`: warnings in human and JSON builds, in `component_diagnostics` (inline and project-wide) and on a successful write; the limits table's new compile-error cases.

### Added — Conditionals, Comparisons, Logical Operators, and Calls in Template Expressions (issue #69; compiler 1.22.1 → 1.23.0, syntax 1.5.1 → 1.6.0; output 1.12.0 for this change alone, 1.13.0 for the release once issue #73 is included)

#### Added

- Template expressions (`{...}`, dynamic attributes, `{#if}` tests) accept the conditional operator `a ? b : c` (right-associative, nestable), `!==`, `<`, `>`, `<=`, `>=`, `&&`, `||`, unary `!` and `-`, `true`/`false`/`null` literals, decimal numbers (`1.5`), and calls of a function or method with any number of arguments (`plural(entries.length)`, `name.trim().length`). Precedence and grouping follow JavaScript. The CalorieCraft values from the issue can now be written inline: `{list.length === 0 ? "No entries yet" : list.length + " " + plural(list.length)}`, `class={list.length === 0 ? "entries is-empty" : "entries"}`.
- New AST nodes from `prattParser.js`: `UnaryExpression`, `LogicalExpression`, `ConditionalExpression`, `CallExpression`; `true`/`false`/`null` are `Literal`. `dependencyAnalyzer.js` walks all of them. Every branch of a conditional and both operands of `&&`/`||` count as dependencies, so a branch not taken at mount still updates when the test flips. A call depends on its arguments and on its callee only when the callee is a reactive `let`.
- Diagnostics (all reachable directly from the expression modules; through `compile()` they surface inside WIZZ-P031/P032/P033):
  - **WIZZ-P056** — `++`/`--`. JavaScript reads these as update operators (`{--count}` would mutate state), never as two signs.
  - **WIZZ-P057** — number and string literals a strict-mode module cannot load: leading zeros (`01`), `1.foo`, octal escapes, malformed `\x`/`\u` escapes.
  - **WIZZ-P058** — a conditional without its `:`.
  - **WIZZ-P059** — calling something other than a name or method (`f()()`, `'a'()`).
  - **WIZZ-P060** — `eval`, `Function`, `constructor`, `__proto__`, `setTimeout`, or `setInterval` anywhere in an expression that contains a call. These are the code-from-string sinks (`x.constructor.constructor(s)` is `Function(s)`). This is defense in depth (templates share the script's trust), and expressions without a call are unaffected, so `{x.constructor.name}` still compiles.
  - **WIZZ-P061** — strict-mode reserved words read as names (`new(x)`, `delete(a.b)`, `import(url)`, `typeof(a)`). Property names (`list.delete(1)`) are fine.
- `==`/`!=` now fail with a pointer to `===`/`!==` (WIZZ-P026, reworded).

#### Changed

- `expressionLexer.js` matches operators longest-first, follows JavaScript string escapes (`'it\'s'` lexes as one string, and its value is the cooked string), and rejects raw line breaks inside strings. Before this, a `\'` ended the string early.
- `integrator.js`: WIZZ-P031/P032 messages append the underlying reason (without its expression-local location, which errorAugmenter would otherwise stamp as the component location). The WIZZ-P055 suggestion parenthesizes operands that bind as loosely as `+` or looser: `class="card {on ? 'a' : 'b'}"` suggests `class={"card " + (on ? 'a' : 'b')}`, and `"n{x - 1}"` suggests `{"n" + (x - 1)}`, which also corrects the arithmetic the old suggestion got wrong.
- The template limits table (`scripts/mcpTools.js`, README "Template Language at a Glance", MCP `language_contract`/`project_overview`) documents the new grammar and the new silent limit: a call re-renders only when a reactive name passed to it changes.
- Versions: **syntax minor** (additive grammar; every expression that compiled before parses to the same AST, except `true`/`false`/`null`, which are now `Literal` rather than `Identifier`, and escaped strings, whose `Literal` value is now the cooked string. Neither changes the emitted code). **Output unchanged**: every generator splices expression source into a parenthesized position (`String(...)`, `if (...)`, `() => (...)`, call arguments, assignment right-hand sides), so the generated structure is the same and only more source reaches it. **Compiler minor**, and `package.json` follows it. `version.js` also drops a duplicated 1.22.1 comment block.

- Review follow-ups (same unreleased versions):
  - The tokenizer tracks `'…'`/`"…"` strings and escapes inside dynamic attribute values (`ATTRIBUTE_EXPRESSION_STRING`/`_ESCAPE`), matching text interpolations. Before, `class={a ? "}" : "ok"}` failed with WIZZ-P001 and `class={a ? "{" : "ok"}` with an unclosed tag. `on:` handler values keep plain brace counting, because a comment or regex in full JavaScript can hold an unpaired quote.
  - `dependencyAnalyzer.js` walks expression ASTs iteratively, and `needsAttributeHelper` (`attributePolicy.js`) no longer descends into `expressionAST`/`testAST`. Before, 20k-long operator or member chains the parser accepted overflowed the stack in `compile()`. The WIZZ-P060 safety pass pushes call arguments one at a time instead of spreading them, which overflowed on ~125k-argument calls.
  - `\x`/`\u` escapes are matched in place with sticky regexes instead of slicing the rest of the input per escape, which was O(n²) on escape-heavy strings. The braced `\u{...}` form now accepts leading zeros (`\u{0000041}`), as JavaScript does.
  - The WIZZ-P055 suggestion no longer doubles parentheses around an already-parenthesized operand. The lexer and its test spell U+2028/U+2029 as escapes instead of raw invisible characters.

#### Migration

- Derived values no longer need their own reactive `let` and `sync()` bookkeeping when they fit in an expression. Pass the state a helper reads as an argument: `{plural(entries.length)}` updates when `entries` changes, `{plural()}` reading `entries` inside the function does not. Derived declarations (the issue's second suggested direction) are not part of this change.
- A quoted attribute whose braces now hold a valid expression (`title="{a ? b : c}"`, `data-x="{!flag}"`) fails with WIZZ-P055 instead of rendering the braces literally. That is the diagnostic's purpose; bind it unquoted.
- A component whose expression used a reserved word as a name, `++`/`--`, a leading-zero number, `1.foo`, or a raw line break inside a string already produced a module that failed to load or mutated state. It now fails at compile time with a located code.

#### Tests

- `expressionParser.test.js`: lexing of every new operator with locations; conditional associativity and precedence against `||`/`&&`; unary binding; literal keywords; calls (zero/many arguments, methods, grouped callees, reserved property names); decimals and rejected number forms; string escape cooking and rejection; update operators, loose equality, malformed conditionals/calls, and operators still outside the grammar; reserved words; unsafe names with and without a call; the depth budget across prefix, conditional, and call recursion (including a 100k unary flood); 20k-long chains through the iterative safety pass; and an oracle that evaluates the AST against the raw source run as strict-mode JavaScript, over 21 hand-picked cases and a 3,000-expression seeded fuzz corpus.
- `dependencyAnalyzer.test.js`: dependencies through every conditional branch, logical/unary operands, literal keywords, call arguments, a reactive callee, a method on state, and a call with no reactive argument; dynamic attributes and `{#if}` tests using the new forms.
- `integrator.test.js`: new forms at every expression site, the reason-bearing P031/P032 messages without a local location, P055 suggestion grouping, and brace groups that stay literal (`[a-z]{2,4}`, `{a:1}`, `{--a}`).
- `diagnostics.test.js`: one corpus entry per new code. `mcpTools.test.js`: the excluded-forms list now covers what is still excluded, plus a silent-limit test showing that `{label()}` is never rewritten while `{label(n)}` is.
- `test/hydration.test.js`: a server-rendered page using the new forms in `<wizz:head>`, dynamic attributes, a reactive `{#if}` with an `&&` test, and a keyed `{#each}` hydrates with no warnings and no created elements, then updates every body site. Head values stay at their server values, per the existing mount-time head contract.
- Review follow-ups: a 200k-argument call through the safety pass (and an unsafe name at its end); 20k-long chains through the analyzer, `needsAttributeHelper`, and `compile()`/`compile({ hydratable })`/`compileServer()`; source-order dependencies across every node type; braces, escaped quotes, and `\u{...}` inside dynamic-attribute strings (tokenizer and integrator), unterminated attribute strings, and `on:` handlers with quotes in comments and regexes; leading-zero `\u{...}` escapes, the code point bound, and a 100k-escape string; and P055 suggestions for already-parenthesized operands.
- `test/endToEnd.test.js` + `test/fixtures/expressions.wizz`: a mounted component re-renders a conditional class, a conditional label with a call, a `&&`/`!` condition with two dependencies, and a unary/decimal expression as state changes, then tears down cleanly.

### Fixed — Expressions in Quoted Attribute Values Are Diagnosed (issue #64; compiler 1.22.0 → 1.22.1, syntax 1.5.0 → 1.5.1, output unchanged at 1.12.0)

#### Fixed

- `class="card {tone}"` and `title="{tone}"` compiled cleanly and rendered the braces literally (#64). Quoted attribute values are static, so an expression inside one is now the compile error **WIZZ-P055**, located at the element and naming the attribute, with the working form as the suggestion: `class={"card " + tone}` (or `title={tone}` when the whole value is one expression). It applies to native elements and component tags; `on:` directives and brace-delimited values are unaffected.
- Only brace groups whose content parses as an expression are rejected. `data-config='{"a":1}'`, `{}`, `{ }`, stray `{`/`}`, and `{a b}` stay literal text, so existing static values that merely contain braces keep compiling. Simple concatenation inside quotes is deliberately not added to the grammar; the diagnostic points at the unquoted form instead.

#### Changed

- `integrator.js` runs the check while integrating element attributes (`rejectQuotedInterpolation`), reusing the expression lexer and parser. `diagnostics.js` adds `quotedAttributeInterpolation: 'WIZZ-P055'`.
- The template limits table (`scripts/mcpTools.js`, the README's "Template Language at a Glance", and the MCP `language_contract`/`project_overview` output) moves "Quoted attribute values" from Silent to compile error WIZZ-P055.
- Versions: **syntax patch** (the catalog grows additively, and the rejected form never did what its author meant), **compiler patch**, output unchanged. `package.json` follows the compiler.

#### Migration

- A component that wrote `attr="… {expr} …"` and shipped the literal braces now fails to compile. Rewrite it as `attr={"… " + expr}`, or, if the braces really are meant literally, make the content not an expression (for example `{ }`-free text) or build the string in a script variable and bind `attr={label}`. The Wizz documentation site had three such attributes (prose with literal `{handler}`, `{closed}`, `{'--accent: ...'}`) and now binds them unquoted.

#### Tests

- `integrator.test.js`: rejection with code and located message for class and single-quoted values, the bare-expression and `+` concatenation suggestions (including a leading-expression value), component tags and nested elements, braces that must stay literal (`{}`, JSON, unbalanced, `{a b}`, `{1 2}`), and dynamic/boolean/`on:` attributes left alone. `mcpTools.test.js` moves the quoted-value row from the silent-limit test to the compile-error test.

### Added — Reactive `{#if}` Blocks and `on:` Inside `{#each}` (issues #71, #70; compiler 1.21.0 → 1.22.0, syntax 1.4.3 → 1.5.0, output 1.11.0 → 1.12.0)

#### Added

- `{#if}` is reactive (#71). A block whose test reads a reactive `let` or prop is re-evaluated when one of those names changes; when the result flips, the old branch is removed and the other one is built from current state. Blocks without `{:else}`, nested blocks, each lists inside branches, and imported components inside branches are all covered. A test with no reactive dependency (for example one reading only `const` values) can never change, so it keeps the inline mount-time emission.
- `on:` directives are accepted inside `{#each}` bodies (#70), at any depth of the item, with the item variable in scope: `<button on:click={() => remove(entry.id)}>`. Listeners attach when an item's record is created and detach when the record is removed. Inline handlers get the same reactive-assignment instrumentation as everywhere else, and a handler that assigns a prop still fails with WIZZ-G015.
- `src/compiler/generator/blockScopes.js`: the ownership model both features share. A branch (or the component itself) is a scope record `{ lists, drop, mounts, nodes }`; `analyzeBlocks()` numbers reactive if blocks and reports which helpers a template needs.
- `test/fixtures/benchmark-blocks.wizz` and a benchmark test pinning the cost of toggling a reactive branch around a 100-row list whose rows carry handlers: one branch built per toggle, 99 listeners added and 99 removed per cycle, and a live listener count that never grows.

#### Changed

- `dependencyAnalyzer.js` tags every `IfBlock` with `dependencies`, extracted from its `testAST` the same way expression nodes are tagged.
- `domGenerator.js`: a reactive if block emits an empty-text anchor, a `__wizzIfBlock(parent, anchor, test, makers, -1, null)` object, an initial `sync()`, a block updater pushed onto `__wizzLists`, and a disposer pushed onto `__wizzDrop`. Each branch becomes a factory-scope maker `__wizzIfMake_<id>_<key>(__wizzParent, __wizzAnchor)`, emitted after `__wizzCreate`. Inside a maker, top-level nodes are inserted before the anchor and tracked, listeners attach through `__wizzOn` into the maker's own `__wizzDrop`, component tags are destroyed by a scope disposer instead of joining `__wizzChildren`, and the update-target variables the branch assigned are nulled on drop.
- Each records whose body has listeners are `{ node, drop, update(__wizzItem) { item = __wizzItem; ... } }`. Rebinding the create function's item parameter is what keeps a handler reading the item's current value after a keyed item is replaced by a new object. Bodies without listeners keep the previous record shape.
- `updateGenerator.js` runs block updaters for reactive if blocks as well as each lists, before the target writes: a branch built in the same pass is already current, and a dropped one has cleared its targets.
- `hydrationGenerator.js` adopts a delivered branch into the same machinery: scope records and branch keys are declared at `__wizzHydrateCreate` scope, top-level nodes, deferred listeners, lists, nested blocks, and update targets register in the branch's record, the block anchor is created after the adopted run, and later swaps call the makers `create()` shares. Component tags in a reactive branch are adopted only when their branch was delivered (an untaken branch previously reached `hydrateRoot(null)`), and their adopted root is tracked by the branch so dropping it removes a root the self-adopted child deliberately leaves in place. Pending listeners carry their owner's `drop` list as a fourth entry.
- `componentGenerator.js` emits the `__wizzOn`, `__wizzDropScope`, and `__wizzIfBlock` helpers at module scope only when the template needs them, declares the factory-level `__wizzDrop` list only when a block or item listener exists, and has `destroy()` run it (without detaching) before destroying the remaining children. Templates using neither feature are byte-identical apart from the version header.
- The server gate (`assertServerRenderable`) validates `on:` directives in each bodies instead of rejecting them; server markup is unchanged, since listeners are client-only. A component that uses per-row handlers therefore stays server-renderable and hydratable.
- WIZZ-G006 (`eventInsideEach`) is retired. It stays in the catalog, is never reused, and is no longer thrown.
- Versions: **syntax minor** (each bodies accept a directive they used to reject; the `{#if}` grammar is unchanged). **Output minor** (block helpers, branch makers, anchors, and scope-owned listeners are additive; the module surface is unchanged). **Compiler minor**, and `package.json` follows it.

#### Migration

- A component that relied on a branch staying put after its condition changed now sees the branch replaced. That was documented as a "not supported yet" limit rather than a contract, and the workaround it forced (render both, toggle a class) keeps working unchanged.
- A replaced branch is rebuilt, not hidden, so DOM state inside it (typed input text, scroll position, a child component's own state) is lost when the test flips. Keep such state in a script `let`, or keep the element mounted and toggle `hidden={flag}`.
- A reactive if block adds one empty text node (its anchor) after its branch. Code that indexes `childNodes` of an element containing such a block shifts by one for the siblings that follow it. Hydration creates this anchor, as it already does for list anchors, so "zero created nodes" pins on pages with a reactive `{#if}` become "one text node per block".
- With persistent state, hydration still adopts the branch the server rendered from the default, then the initial update pass replaces it with the branch the stored value selects. Previously the delivered branch stayed.
- An `on:` handler expression in an each body is evaluated once per item. Inline arrows read the item when they run; `on:click={makeHandler(item)}` keeps the handler built from the item's first value.
- Rebuild client, hydratable, and server modules together, as with any output bump.

#### Docs

- The README's "Template Language at a Glance" table and the MCP `language_contract`/`project_overview` limits rows (kept in sync by `mcpTools.test.js`) describe both features; the README's Lists and Conditional Rendering sections gain examples and the rebuild-not-hide caveat. `src/compiler/generator/README.md` documents the block object, makers, scope records, per-record listeners, and the new `blockScopes.js` section; the parser, analyzer, and compiler READMEs, `STRUCTURE.md`, and `version.js` are updated to match. The ROADMAP's Framework Feedback records both findings as landed.

### Fixed — Dynamic Boolean Attributes Toggle Presence (issue #72; compiler 1.20.0 → 1.21.0, output 1.10.1 → 1.11.0)

#### Fixed

- `<p hidden={isValid}>` stayed hidden when `isValid` was `false`, because every dynamic attribute other than `value`/`checked`/`disabled` was written as `setAttribute(name, String(value))` and the attribute stayed present as `hidden="false"` (#72). HTML boolean attributes (`hidden`, `required`, `readonly`, `open`, `inert`, `multiple`, `selected`, `autofocus`, and the rest of the spec's list) are now present (`""`) when the value is truthy and removed when it is falsy.
- Any dynamic attribute whose value is `null` or `undefined` is now removed instead of rendering the strings `"null"`/`"undefined"`.

#### Changed

- New `src/compiler/generator/attributePolicy.js` holds one policy for every target. It covers client `create()`, `update()`, each-block item create/update, hydratable fresh items and item updates, client head nodes, hydration head verification, and server body and head markup. Boolean names are matched case-insensitively against `BOOLEAN_ATTRIBUTES` at compile time.
- Client modules emit one module-scope `__wizzAttr(node, name, value, boolean)` helper. It is emitted only when a native body or head element has a dynamic attribute it writes, so modules without one stay byte-identical apart from the version header. Calls look like `__wizzAttr(node, "hidden", expr, 1)` and `__wizzAttr(node, "title", expr)`. The helper uses only `setAttribute`/`removeAttribute`.
- The server target serializes through `serverAttributeSource()`. Boolean attributes render bare when truthy, and other attributes are omitted for `null`/`undefined` and escaped otherwise. Each expression is evaluated once.
- Head nodes previously special-cased only `checked`/`disabled`. They now use the full boolean list, and hydration's head check expects a removed attribute to be absent.
- `updateGenerator.js`: `emitWrite()` now takes a statement builder instead of a property-access suffix.
- The `value`/`checked`/`disabled` property path now matches names case-insensitively and always assigns the lowercase property. Before, `DISABLED={x}` fell through to an attribute write and never set `.disabled`.
- Hydration's head-verification loop local is renamed from `__wizzAttr` to `__wizzPair` so it no longer shadows the module-scope helper.
- Versions: **output minor**, because generated attribute writes change and the helper is new, while the module surface is unchanged. **Compiler minor**, and `package.json` follows it. **Syntax holds**: the template grammar accepts exactly what it did, and what a dynamic attribute renders is part of the output contract.

#### Migration

- Outside the boolean list, `false` deliberately still renders `"false"`, so `aria-expanded={open}`, `aria-hidden`, `draggable`, and `spellcheck` keep their enumerated meaning. To drop a non-boolean attribute, use `null`.
- A component that relied on `hidden={false}` keeping the element hidden, or on `"undefined"` appearing in markup, renders differently. Server output from compilers before 1.21.0 that delivered `hidden="false"` or `content="undefined"` in a head node now fails head verification, and the client mounts fresh. Rebuild client and server modules together.

#### Docs

- The README's "Template Language at a Glance" table, the MCP `language_contract` limits row, the README dynamic-attribute section, `src/compiler/generator/README.md` (a new `attributePolicy.js` section, the server emission rules, and the runtime boundaries), and `STRUCTURE.md` describe the policy. The ROADMAP's Framework Feedback #1 records that the generator half has landed.

#### Tests

- `attributePolicy.test.js` covers truthy and falsy values (including `NaN`, `0n`, and `'false'`), null/undefined removal, `false` staying `"false"`, repeated toggling, hostile values and `__proto__` names, single evaluation, helper detection through branches, each bodies, component tags, and cyclic input.
- `componentGenerator.test.js` mounts components that toggle `hidden`, `required`, `readonly`, `title`, and `aria-expanded`, inside `{#if}` branches and keyed each items, and checks that the helper appears only when needed.
- `serverGenerator.test.js` covers omitted and bare attributes, escaping, and head parity. `hydrationGenerator.test.js` covers head verification for omitted attributes and rejection of stringified older output.
- `domGenerator.test.js` runs `create()` against the policy, including mixed-case property names, and checks each-item create and update emission. `updateGenerator.test.js` covers boolean toggling, null/undefined removal, the string 'false' staying truthy, and dependency-scoped writes.
- `test/hydration.test.js` renders on the server, hydrates, and toggles `hidden`/`title`/`aria-expanded` (and `inert` from a truthy start) on the adopted nodes with no creation and no mismatch.
- The tests that pinned the old `setAttribute(..., String(x))` shape (`updateGenerator.test.js`, `mcpTools.test.js`) are updated.

### Fixed — Author Names Cannot Collide With Generated Code (issue #65; compiler 1.19.0 → 1.20.0, syntax 1.4.2 → 1.4.3, output 1.10.0 → 1.10.1)

#### Fixed

- A reactive variable named `state` broke server rendering at runtime while the build reported the component as server-renderable (#65). The same class affected far more names in every target. `let target`, `props`, `update`, `create`, `ctx`, `rootNode`, `queueUpdate`, `isMounted` and others produced a module that failed to parse. `html`, `head`, and `options` did the same in server modules.
- Some names failed silently instead. A persistent `value` was shadowed by the subscriber's parameter, so writes from another tab were lost. `setProps` read a prop named `next` from its own parameter. Expressions reading author variables named `changed`, `ctx`, `nodes`, `problems`, or `node_1` saw the generated value.
- A `let document` in a script no longer fails at runtime: it is now a located diagnostic, as are the other names below.

#### Changed

- Every name the client, hydratable, and server generators declare around author code now carries the reserved `__wizz` prefix, so ordinary names are free. The public exports and the `{ html, head, state }` result are unchanged.
- `props` is now a valid prop name (`propExtractor.js`): the parser refused it only because it was a generated parameter.
- Versions: **compiler minor** for the new diagnostic, **syntax patch** because the rejected names never worked in generated code (see Migration for the one exception), **output patch** because the module surface is unchanged. `package.json` follows the compiler.

#### Added

- `WIZZ-G025` (`reservedNames.js`) rejects names renaming cannot free, at a script's top level or as a prop or import name: the `__wizz` prefix, `onMount`, `onDestroy`, and the globals generated code reads (`document`, `console`, `queueMicrotask`, `Array`, `Error`, `JSON`, `Map`, `Object`, `Set`, `String`). Imports are also checked against `mountComponent`, `hydrateComponent`, and `hydrateRoot`. Names inside a function or block stay allowed.

#### Migration

- A script that read generated names directly, which was never documented, now gets a `ReferenceError`: `target`, `props`, `ctx`, `queueUpdate`, and the rest are gone. Pass what the script needs as a prop instead.
- A top-level `function onMount() {}` used to compile and silently replace the hook. It now fails with `WIZZ-G025`, so rename it.

#### Docs

- `README.md`, the MCP `language_contract`, `STRUCTURE.md`, and `src/compiler/generator/README.md` state the naming rule and the reserved list.

#### Tests

- `test/hydration.test.js` runs every name generated code has declared through reactive state, `const`, functions, props, persistent state, lists, row bodies, head, and child props, on fresh mount and hydration with server output. `reservedNames.test.js` covers each reserved name in every declaration form, destructuring, and the nested scopes that stay allowed. Test pins move to the prefixed names. Two hook tests that read `target` from a script now use a function prop.

### Fixed — Child Components Mount at Their Template Position (issue #66; compiler 1.18.2 → 1.19.0, output 1.9.2 → 1.10.0)

#### Fixed

- A fresh mount placed every child component last in its parent, so `<main><Label /><input /></main>` rendered `INPUT, SPAN` (#66). The hydrated path kept server order, so the same page's DOM depended on whether it hydrated or fell back to a client mount. Fresh mounts now produce the same DOM as hydration.

#### Added

- `mountComponent(target, props, anchor?)` takes an optional third argument: the root is inserted before `anchor`, and appends as before when it is omitted. Existing callers are unaffected.

#### Changed

- `create()` holds each component tag's position with an empty text node, passes it to the child, and removes it once the child mounts, so no placeholder stays in the DOM (`domGenerator.js`, `componentGenerator.js`). Children still mount after the parent is attached, so head order and `onMount` timing are unchanged.
- Hydratable modules pass the anchor through `mountInstance`, whose parameter order changes. It is internal to the generated module.
- Versions: **compiler and output minor**, because `anchor` is an additive surface. Syntax holds, and `package.json` follows the compiler.

#### Migration

- Code or CSS that relied on children rendering last in client-mounted pages now sees template order, which is what hydrated pages already showed.

#### Tests

- `test/hydration.test.js` compares fresh and hydrated DOM for children first, last, between siblings and text, adjacent, in both branches, beside lists, and nested. It also covers placeholder removal, reactive props, fallback order, grandchildren, and the `anchor` argument. `domGenerator.test.js` pins the placeholder lifecycle, and signature pins across the suite move to the new form.

### Fixed — List Name Collisions (compiler 1.18.1 → 1.18.2, output 1.9.1 → 1.9.2)

#### Fixed

- A hydratable `{#each items as item}` threw `Cannot access 'items' before initialization`: the adoption walk emitted `const items = items;`. Any collection named `index`, `parentRef`, `startIndex`, `nextRecords`, or `seenKeys` failed the same way or read a generated value.
- A list item named `key`, `record`, `index`, `parentRef`, `nextRecords`, or `seenKeys` produced a module that failed to parse or threw during list updates, in client and hydratable builds. The emitted locals shared the item's scope.
- A row expression reading an author variable named `index` or `parentRef` no longer sees the adoption walk's parameter, which failed hydration or rendered the wrong value.

#### Changed

- Every local in the emitted list machinery now carries the reserved `__wizz` prefix (`domGenerator.js`, `hydrationGenerator.js`). The module surface is unchanged.
- Versions: **compiler and output patch**. Syntax holds, and `package.json` follows the compiler.

#### Tests

- `test/hydration.test.js` runs every colliding name as a collection and as an item, keyed and keyless, through fresh mount and hydration, plus row bodies reading author variables. `domGenerator.test.js` and `hydrationGenerator.test.js` pin the emitted names.

### Fixed — Direct Update Targets (issue #63; compiler 1.18.0 → 1.18.1, output 1.9.0 → 1.9.1)

#### Fixed

- A parent's `update()` could write to an element inside a child component (#63). Targets were found with `rootNode.querySelector('[data-wizz-id="N"]')`, but ids restart at `1` in every component, so a child earlier in document order won the match. A hydrated parent with `<Label />` before `<input value={draft}>` set `.value` on the child's `<span>` and left the input stale. Fresh mounts hit the same bug when the child sat inside an earlier sibling element.
- Reactive text updated the wrong node when a child's DOM position differed from its template position. `childNodes[templateIndex]` was off beside a fresh-mounted child component (which mounts after its siblings), after an untaken `{#if}` branch, and after `{#each}` items. The write landed on another node or threw.
- A component with reactive content in an untaken `{#if}` branch no longer crashes at mount. The initial update pass queried for an element that was never created and threw `Cannot read properties of null`.
- A reactive expression placed directly in an `{#if}` branch, with no wrapping element, now updates. `update()` previously skipped it.
- An author variable named like `target_1` can no longer be shadowed by a generated local inside `update()`, which sent the write to the variable's value instead of the node.

#### Changed

- `update()` now writes through `__wizzTarget_N` factory-scope variables that `create()` and the hydration walk assign (`collectUpdateTargets()`, `updateGenerator.js`). Only writes inside `{#if}` carry a null guard. `data-wizz-id` is still stamped, and is now used only to verify delivered markup during hydration.
- Updates issue no DOM queries. The batched-update benchmark goes from 1 query to 0, and hydration from 2 to 0 on adoption.
- Versions: **compiler and output patch**. The module surface is unchanged and no accepted syntax changes meaning. `package.json` follows the compiler to 1.18.1.

#### Docs

- `README.md` replaces the warning about id lookups: a node replaced by hand now stops updating. `src/compiler/generator/README.md`, `src/compiler/analyzer/README.md`, and `STRUCTURE.md` describe captured targets.

#### Tests

- `test/hydration.test.js` runs each case through both fresh mount and hydration: the #63 repro, nested id collisions on text and attributes, text beside a child, after an untaken branch, and after a resizing list, untaken and taken branches, generated-name collisions, and writes queued before `destroy()`. It also covers separate instances and hydration fallback. The element shim gains `insertBefore`.
- `updateGenerator.test.js` is rewritten around target variables and covers `collectUpdateTargets`, including guard placement and templates with content outside the root element. `domGenerator.test.js`, `hydrationGenerator.test.js`, and `componentGenerator.test.js` pin the assignments, and benchmark query pins move to 0.

### Fixed — Single Delivery of Extracted Styles (issues #75, #76; compiler 1.17.1 → 1.18.0, output 1.8.3 → 1.9.0)

#### Changed

- `wizz build` writes the extracted stylesheet to `dist/wizz.css` instead of `dist/app.css`, and the injected link is `/wizz.css` (`STYLESHEET_FILENAME`, `build.js`). `app.css` differed from the starter's `App.css` only by case, so case-insensitive filesystems merged the two into one file linked twice while case-sensitive ones kept two: the same project built differently per OS (#75). `App.css` now always copies verbatim, and the inode comparison and merge branch in `copyDocumentShell` are gone.
- A shell that links the old `/app.css` name is rewritten to `/wizz.css` in the built copy, with a build note, so the link cannot 404 on a case-sensitive host. The match is case-sensitive and limited to `<link>` tags, so an author's `/App.css` is untouched.

#### Added

- `extractedStyles` option on `compile()` and `compileServer()`: the module carries no CSS and neither injects nor delivers a scoped `<style>`; `data-wizz-s` markup is unchanged and `payload.style` stays populated for extraction. A style-only component compiles with no head machinery at all.
- `inlineStyles` option on `buildProject()`: keeps per-module delivery. `scripts/dev.js` passes it because the dev server replaces the built shell with the authored one, so nothing links the stylesheet in development.
- `splitImportRules()` (`src/compiler/analyzer/cssScanner.js`). `writeExtractedStyles` hoists top-level `@import` statements above every component and collapses duplicates. Without this, removing the injected `<style>` tags would have silently disabled any `@import` that landed after another component's rules.

#### Fixed

- Plain and SSR production builds delivered every scoped rule twice: once in the extracted stylesheet and again from `<style data-wizz-style>` injection, in client and hydratable modules and in the server head run (#76). `buildProject` now decides delivery before compiling (`shellLinksExtractedStyles()`): when the built shell will link the stylesheet, client, hydratable, and server modules all compile with `extractedStyles`. When nothing links it (no shell, or no `</head>`), modules keep injecting, so a shell-less project stays styled.
- Link detection ignores HTML comments and requires a `<link>` with `rel="stylesheet"`, so a commented-out link, a preload hint, or an `<a href="/wizz.css">` no longer suppresses the injected link. The injection also skips a commented-out `</head>`. Both mattered less while runtime injection hid the mistake.
- Versions: **compiler and output minor**, because `extractedStyles` is an additive capability and `wizz build` output changes for styled components; output without the option is unchanged apart from the version header. Syntax holds. `package.json` follows the compiler to 1.18.0.

#### Migration

- Application-owned documents that serve built modules from a project with a shell must link `/wizz.css`; those modules no longer carry their CSS. Deployment rules that reference `app.css` by name need updating.

#### Tests

- `build.test.js`: no CSS in `App.js`, `.hydrate.js`, or `.server.js` with the scope attribute intact; the stylesheet selector matches the rendered scope; fallback to injection for a missing shell, no `</head>`, and a commented-only `</head>`; `inlineStyles`; JSON mode; unstyled projects; legacy link rewrite; `/App.css` left alone; links that deliver no rules; comment-aware injection; `@import` hoisting; idempotent rebuilds. The filesystem-case branch and its probe helper are removed because results no longer depend on the host.
- `cssScanner.test.js` (`splitImportRules` look-alikes in strings, comments, nested rules, and `@import-foo`; a missing final semicolon; case; semicolons in URLs), `componentGenerator.test.js`, `serverGenerator.test.js`, `index.test.js`, `test/hydration.test.js` (hydration with no style node and no mismatch, head block still adopted), and `test/dev.test.js` (development stays inline).

#### Docs

- `README.md`, `STRUCTURE.md`, `src/compiler/generator/README.md`, `src/compiler/analyzer/README.md`, `src/compiler/README.md`, `version.js`, and the `wizz mcp` workflow text describe `wizz.css`, single delivery, and the new triple.

### Fixed — Reactive Inline Event Handlers (compiler 1.17.0 → 1.17.1, syntax 1.4.1 → 1.4.2, output 1.8.2 → 1.8.3)

#### Fixed

- Assignments written directly in an inline `on:` handler never scheduled an update: `on:input={(e) => name = e.target.value}`, block-bodied arrows, and `function (e) { ... }` expressions were embedded verbatim, so the state changed but the DOM did not. The generator now runs each handler through the same assignment interceptor as script functions. New `interceptHandlerExpression()`, `findHandlerMutations()`, and `normalizeHandlerExpression()` (`src/compiler/generator/assignmentInterceptor.js`) accept only a function literal spanning the whole directive value, rewrite an expression-bodied arrow to a block body (the dropped return value is unobservable because `addEventListener` ignores it), and emit every other form untouched. `componentGenerator.js` collects the results once (`collectHandlerSources()`, a `WeakMap` keyed by attribute, both `{#if}` branches walked) and passes them to `generateCreateFunction()` and, through the options, to `generateHydrationFunction()`, so fresh mounts and hydrated adoptions attach the same listener. Persistent state assigned in a handler writes through `__wizzPersistWrite` as in the script. Arrow parameters and local declarations shadow reactive names.
- An inline handler that assigns a prop now fails with the existing read-only diagnostic `WIZZ-G015` (`Props are read-only: 'name' cannot be assigned in the 'on:click' handler.`) instead of silently assigning the child's local copy, matching the script-level rule.
- Versions: **output patch**, because generated listeners change for handlers that mutate reactive state (every other handler is byte-identical, which the default-output pin confirms); **syntax patch**, because a component with an inline prop mutation that used to compile now fails. Conservative assumption: this enforces the documented "props are read-only" rule rather than adding a restriction, so it is a fix, not a major change. The compiler patch follows.

#### Tests

- `assignmentInterceptor.test.js`: executes instrumented handlers to check notifications, state, persistence writes, and the dropped return value; covers every assignment and update operator, `async` (modifier and parameter name), multi-line heads, block and function bodies with ASI, property chains, parameter, destructured, and local-declaration shadowing, strings and templates containing `}` and `,`, trailing line and block comments, `__proto__`/`constructor` names, and the refused forms (bare assignments, sequences, `function`/`class` bodies, partial-span arrows, unbalanced heads, empty and non-string input), which must come back byte-identical.
- `componentGenerator.test.js` (prop rejection, shadowed parameters, both `{#if}` branches, persistent writes, untouched non-mutating handlers), `domGenerator.test.js` (`handlerSources` wins; raw value without an entry), `hydrationGenerator.test.js` (adoption collects the instrumented listener), and an end-to-end fixture, `test/fixtures/inline-handlers.wizz`, that types into an input and clicks a button through inline arrows, then checks the DOM and listener teardown (`test/endToEnd.test.js`).

#### Docs

- The issue #77 limits table no longer lists inline-arrow assignments as a silent limit. The "Event handlers" row now documents the inline two-way input pattern and the remaining gaps (`bind:`, assignments nested in expressions); the README table was regenerated, and `scripts/mcpTools.test.js` pins the new behavior. `README.md` ("Create a Component"), `src/compiler/generator/README.md`, `src/compiler/README.md`, and `version.js`/`version.test.js` describe the instrumentation and the new triple.

### Docs — Template Language Limits Up Front (issue #77)

#### Added

- `TEMPLATE_LIMITS` in `scripts/mcpTools.js`: one frozen table of the template language's current limits — expressions, `{#if}`, the `{#each}` collection and body, dynamic attributes, quoted attribute values, event handlers, and component tags — each row with what is supported, the limit, how it fails (the `WIZZ-P###`/`WIZZ-G###` code, or **Silent** when the source compiles but the DOM does not update), and the working pattern. It is the single source for three surfaces, so they cannot drift.
- `language_contract` appends the table as text and returns it as `structured.templateLimits`; `project_overview`, the first tool an agent calls, adds a one-line-per-limit summary and the same `structured.templateLimits` (a fresh copy per call, so a caller mutating one response cannot corrupt the next) (`scripts/mcpTools.js`).
- Tests pin the table to the compiler: every cited code is in the diagnostics catalog and is produced by a probe source; every silent row is checked against generated output (`{#if}` tests absent from `update()`, `items.push()` and inline-arrow assignments scheduling no `queueUpdate`, `setAttribute(name, String(value))` with no `removeAttribute`, literal `class="card {kind}"`, `bind:value` as a plain attribute); every working pattern compiles and is reactive. A compiler change that lifts a limit fails the suite until the table is updated (`scripts/mcpTools.test.js`).

#### Docs

- New `## Template Language at a Glance` section near the top of `README.md` (before the CLI reference), generated from `templateLimitsMarkdown()` and required verbatim by a test; the MCP tool table now lists the limits in `project_overview` and `language_contract`.
- Corrected the `language_contract` expression line: the grammar accepts integer (not decimal) literals plus `+ - * /` and parentheses, which the old text omitted.
- Newly documented silent behaviors found while verifying the table: `items.push(x)` does not update an `{#each}` (reassign instead), assignments written directly in an inline `on:` arrow did not schedule an update (fixed in compiler 1.17.1 above), braces inside quoted attribute values are literal text, and `bind:` is not a directive.
- `STRUCTURE.md` and the ROADMAP Framework Feedback entry 1 note where the table lives and that its boolean-attribute docs note has landed.
- The table itself changes no compiler, parser, or generated output (tooling text only, matching the earlier MCP hardening fix); the version bump above comes from the inline-handler fix.

### Docs — Application Entry Module Path (`README.md`)

#### Docs

- Corrected the document-shell example in the `Application Entry` section of `README.md` from `<script type="module" src="/dist/runtime/main.js"></script>` to `<script type="module" src="/runtime/main.js"></script>` and noted that `dist/` is served as the web root by `wizz dev`, the node adapter, and static hosting, matching the `wizz init` starter shell (`README.md`, `packaging.test.js`).

### Fixed — MCP Server Hardening (TM-02, TM-03)

#### Fixed

- Closed the check-then-use gap (CWE-367) in `create_or_update_component`: the containment checks (`resolveInsideRoot`, the final-segment lstat, `realpathInsideRoot`) and the old `mkdirSync` + `writeFileSync` on the lexical path were not atomic, so a local attacker with write access to the project tree could swap an ancestor directory for a symlink after the checks and redirect agent-controlled bytes outside the root (`scripts/mcpTools.js`). The write now lands through `writeComponentFile`: the target is opened with `O_NOFOLLOW|O_CREAT|O_TRUNC|O_WRONLY` (a final segment planted as a symlink fails with ELOOP and is refused, not followed), the parent directory is re-verified against its verified realpath immediately before *and* after the open, an lstat/fstat dev+ino comparison proves the path still names the opened inode, and the bytes travel through the fd — so a swap after verification cannot redirect them. Documented residual window: an attacker who wins the race between the final parent check and the open can cause an *empty* file (O_CREAT) outside the root; no content ever follows. Every step requires `--allow-write` plus a local writer racing the tool in the same tree. Tests drive the happy path, the planted final-segment symlink (ELOOP refusal, target untouched), and the ancestor-swap race deterministically (`scripts/mcpTools.test.js`).
- Bounded the in-process parser work an agent can trigger without `--allow-write` (CWE-400): `component_diagnostics`' inline `source` branch — the one compile path with no size bound below the protocol's 2 MiB message cap — now enforces the same 256 KiB `MAX_SOURCE_BYTES` cap as the write gate before the parser runs, and both `all` and `path` diagnostics modes report an oversized file as an error record (with the remaining files still diagnosed) instead of compiling it (`scripts/mcpTools.js`, `scripts/mcpTools.test.js`).

### Changed — Parse-Stage Resource Budgets (compiler 1.16.0 → 1.17.0)

#### Changed

- The Pratt expression parser carries a recursion-depth budget (`MAX_EXPRESSION_DEPTH`, 128): every nested parenthesized group — or infix right-hand recursion — costs one JS stack frame, and a flood of unbalanced `(` previously exhausted the stack with a parser-internal RangeError. It now answers a located diagnostic (`WIZZ-P053`) with the token the parser refused to descend past (`src/compiler/parser/prattParser.js`, `src/compiler/parser/expressionParser.test.js`).
- The template parser carries a nesting budget (`MAX_TEMPLATE_DEPTH`, 256): the parse loop is iterative, but the AST it produces is walked recursively by every later stage, so tens of thousands of unclosed tags previously pushed the downstream recursion past the stack limit. It now answers a located diagnostic (`WIZZ-P054`) (`src/compiler/parser/templateParser.js`, `src/compiler/parser/templateParser.test.js`).
- Both budgets are additive catalog entries (`src/compiler/diagnostics.js`) and far beyond authoring need — no accepted syntax changes meaning and no generated module changes, so syntax (1.4.1) and output (1.8.2) hold while the compiler moves to 1.17.0 (`src/compiler/version.js`, `src/compiler/version.test.js`, `package.json`). The parse stage compiles untrusted component source (agent tooling, editor integrations, CI), so the guards are resource limits, not just error-message improvements.

### Changed — Loopback Binding for Development Servers

#### Changed

- The development server binds to `127.0.0.1` by default instead of every interface (`scripts/dev.js`). `startDevelopmentServer` calls `server.listen(port, host)`, where the host resolves through three layers: an explicit `options.host` (the CLI's `--host` flag) outranks the `HOST` environment variable, which outranks the loopback default. The rationale is the server's threat surface: no authentication or TLS, compiled source served statically, `/api/**` handlers executed in-process with `.env.server` secrets loaded into `process.env`, and the `/_wizz/reload` SSE channel — a default bind to `0.0.0.0`/`::` would expose all of that to the local network.
- The `listen()` return value and startup banner now name the exact bound address (bracketed for IPv6) instead of unconditionally claiming `localhost`. This is a correctness fix, not just cosmetics: on hosts where `localhost` resolves to `::1` first (Linux CI images do), a strict client such as Node's `fetch` cannot reach an IPv4 loopback bind through the `localhost` name, so the old banner handed out a URL that did not always dial. Browsers try both stacks for `localhost` and keep working.
- `wizz dev` accepts `--host <addr>` (both `--host <addr>` and `--host=<addr>` spellings, at most one, alongside `--port`), validated like every other dev flag: a missing, empty, or flag-like value (a hostname never starts with `-`) fails with usage guidance rather than being consumed as a hostname (`scripts/cli.js`, `scripts/cli.test.js`). The banner rule above keeps a remote opt-in explicit at startup.
- The standalone SSR demo binds to `127.0.0.1` by default for the same reason, with `HOST` as the environment opt-out, and its startup banner shows the actual bind host (`scripts/ssr-demo.js`).
- The generated node adapter host (`wizz build --adapter node`) keeps its unbound `listen(port)` deliberately: a production deploy host (VPS/EC2/Docker) normally must accept external connections, and its exposure model is the deployment platform's responsibility. The dev and demo servers have no such justification, which is why only they change.
- Tests pin the contract: `resolveBindHost` is exported and unit-tested for the loopback default, the empty-string `HOST` non-override, option-over-environment precedence, and the `TypeError` on non-string hosts; real-listen tests assert the server binds `127.0.0.1` with no configuration and binds the `HOST`/option host when given (`test/dev.test.js`); CLI parsing and flag threading are covered in `scripts/cli.test.js`.

### Added — MCP Server (`wizz mcp`)

#### Added

- `wizz mcp [--root <dir>] [--allow-write]` serves Wizz tooling to AI agents over the Model Context Protocol. The wire protocol is hand-rolled to keep the zero-dependency rule intact: newline-delimited JSON-RPC 2.0 on stdio per the 2025-06-18 spec — the `initialize` handshake with version negotiation (a supported `2025-03-26`/`2025-06-18` request is echoed verbatim; anything else gets the latest supported version), `notifications/initialized`, `tools/list`, `tools/call`, `ping`, the `-32002` not-initialized gate, and the standard JSON-RPC error codes. stdout carries protocol messages only — logs go to stderr, `startMcpServer` redirects the global console methods to stderr for the server's lifetime, and a spawned smoke test proves every byte of stdout parses as a JSON-RPC message (`scripts/mcpProtocol.js`, `scripts/mcp.js`, `scripts/mcp.test.js`).
- Six tools with snake_case names and JSON-Schema `inputSchema`s (`scripts/mcpTools.js`, `scripts/mcpTools.test.js`): `project_overview` surveys components, routes, API routes, document shell, build output, adapters, and the version triple; `component_diagnostics` compiles a project file, inline source (with an optional path label), or every component under the input directory into structured `WIZZ-P###`/`WIZZ-G###` records through the collect-mode contract without ever throwing; `build_project` runs the build in-process with the silent logger and returns the `wizz-build-diagnostics@1` envelope (adapter runs included); `language_contract` and `dev_workflow` carry static documentation of the real syntax and the real commands (inline strings that ship in the tarball by construction); `create_or_update_component` is the guarded write tool.
- The write tool's security posture: the project root is fixed at startup (`--root <dir>`, default the working directory) and never agent-controlled; component writes require the explicit `--allow-write` startup opt-in and are refused otherwise; every path is refused if it escapes the root lexically and through the real filesystem, so symlink targets, symlinked ancestor directories, and dangling symlinks cannot smuggle a write out; targets must be `.wizz` files outside the managed trees (`dist/`, `node_modules/`, `.git/`, `release/`, `vscode-extension/`); sources cap at 256 KiB; and a hard compile gate refuses non-compiling source with the diagnostic records echoed and the file byte-identical — there is no bypass or elicitation channel; the gate plus the opt-in is the trust model.
- Agent input is treated as untrusted: parsing strips `__proto__` keys (prototype pollution), handlers read only declared schema keys and never merge argument objects, and message lines cap at 2 MiB. A failed `tools/call` handler surfaces as an `isError: true` result (expected refusals via `ToolExecutionError`) or a `-32603` internal error with detail logged to stderr only; unknown methods answer `-32601` and notifications are never answered.
- The three scripts join the shipped surface in every place that lists CLI scripts: `package.json` `files`, `packaging.test.js` `EXPECTED_FILES`, the managed installer's `--local` copy list, and the installer test's fake tarball.

#### Changed

- Package and compiler version 1.14.0 → 1.15.0 for the release cut carrying the MCP server: additive CLI/tooling surface only, so the syntax (1.4.1) and output (1.8.2) contracts hold (`src/compiler/version.js`, `package.json`). No compiler source, parser, or generated-module changes — the server builds entirely on the existing `compile()`/`compileServer()` collect-mode contract and the build envelope, with the dependency one-directional (tooling → compiler).
- The `language_contract` test pins the literal version triple in its text, a deliberate drift-guard: a future version bump fails that test until the contract text is reviewed against the compiler (`scripts/mcpTools.test.js`).

#### Docs

- README gains an "MCP Server" section (client registration recipe, the tool table, and the security posture) and the CLI enumeration, `wizz --version` example, and CLI Stability list move with the new command; `ROADMAP.md` records the MCP item as completed milestone 22 and retires the bullet from Later Ecosystem Work; `STRUCTURE.md` entries the three new scripts; the wizz-docs site follows with its own MCP section in a separate docs commit.

### Added — Node Adapter Host (`wizz build --adapter node`)

#### Added

- `wizz build --adapter node` (`--adapter <name>`, also `--adapter=<name>`, in any argument position alongside `--json`) generates a standalone SSR + API host at `dist/server.mjs` so a build deploys on an external Node host (VPS/EC2/Docker) without hand-copying the SSR recipe. The host is self-contained — it imports only Node builtins and the build's own artifacts (`dist/runtime/routes.js`, `dist/runtime/apiRoutes.js`, the `.server.js` modules) — preserving the "dist/ is self-contained" deployment contract (`build.js`, `build.test.js`).
- The generated host mirrors the development server's serving protocol: traversal-guarded static file serving, exact-pathname route rendering (mirroring the client router) with the state script delivered as a sibling of the mount point and the head wrapped in `<!--wizz:head-start-->…<!--wizz:head-end-->`, `/api/**` handlers behind the same frozen request context and return shapes, 404 JSON for unmatched API paths (never the SPA shell), a 1 MB body cap (`413`), fixed-body 500s with detail only in the server log, and the document shell as the SPA fallback. `/server/**` is never served as a static file, so handler source and private `_` modules stay unreachable. Known divergences from dev, all deliberate: no module cache-busting (a production host is not rebuilt while running), no live-reload endpoint, and `.env.server` loads from the invocation CWD with real environment values never overridden.
- `parseBuildArguments` validates the adapter name against a known-adapters list (`node` only today; the list is the extension surface for future platform adapters) — unknown, missing, empty, and repeated values fail with usage guidance naming the known adapters. `scripts/cli.js` strips and re-appends the flag for the build layer to re-parse (the established `--json` contract) and rejects a stray `--adapter` on every other command. The `wizz-build-diagnostics@1` envelope gains an additive top-level `adapter` field, present only when an adapter ran, so static-build consumers parse an unchanged envelope.

#### Changed

- Package and compiler version 1.13.1 → 1.14.0 for the release carrying the node adapter host: additive CLI/build surface only, so the syntax (1.4.1) and output (1.8.2) contracts hold (`src/compiler/version.js`, `package.json`).
- No compiler source, parser, or generated-module changes: the adapter is build-layer emission, so the compiler, syntax, and output versions move only via the package lockstep pin (`packaging.test.js` pins `pkg.version` to `VERSIONS.compiler`).

#### Docs

- README gains a "Deploying with the node adapter" section (flag surface, generated-file contract, serving behavior, security posture) and the `wizz --version` example and CLI enumeration move with the version bump and flag; `ROADMAP.md` records the node adapter as a completed amendment to the milestone 21 external-host story with a Development Server Decision clarification; `STRUCTURE.md` extends the build-script prose; the wizz-docs GettingStarted deploy section now leads with the adapter command.

### Fixed — Static Serving Traversal Hardening (Dev Server + Node Adapter)

#### Fixed

- The static-serving guards in the development server (`scripts/dev.js`) and the generated node adapter host (`build.js` `NODE_ADAPTER_HOST_SOURCE`) close the symlink residual a security audit noted on top of their already-verified lexical traversal handling (encoded dots, backslashes, drive letters, double slashes — no bypass). `path.relative`/`startsWith` containment is lexical, so a symlink inside the served tree pointing outside would pass the prefix check and stream the target's bytes; both servers now resolve the candidate with `fs.realpathSync` and re-check the canonical path against the canonical root before any read is served. The root itself is canonicalized once (cached per root path), so a symlinked dist ancestor keeps serving; every `realpathSync` failure — dangling symlink, unreadable ancestor, NUL byte — conservatively answers "not a file", and the request falls through to the existing 404/SPA-fallback paths. A legitimate intra-dist symlink still serves.
- A NUL byte in the decoded pathname is now rejected deterministically with `400 Bad request` ahead of any filesystem access. Previously it fell through `fs.existsSync` (which swallows `ERR_INVALID_ARG_VALUE` and answers false) into the shell fallback, an incidental rather than designed outcome.
- The request target is parsed by concatenation into a fixed origin (`new URL('http://localhost' + request.url)`) instead of against a base. A base re-parses an origin-form target starting with `//` as protocol-relative, silently promoting its first path segment to an authority — `/etc/passwd` segments were dropped from the path the guard resolves (not exploitable: the authority never reached the filesystem join, but the guard was answering a different path than the one requested). This server is not a proxy, so an absolute-form target (`http://…`) now lands in the same `400 Bad request` as any other malformed target instead of being served by its pathname.

#### Changed

- No version bump: both guards live in build/runtime artifacts (the dev server script and the generated adapter host), so the compiler (1.15.0), syntax (1.4.1), and output (1.8.2) contracts hold. Regression tests pin the full audit corpus against both running servers — encoded dots, backslashes, drive letters, double slashes, NUL bytes, the symlink-in-dist residual, and the legit intra-dist symlink that must keep serving — and assert nothing leaks while each server stays alive afterward (`build.test.js`, `test/dev.test.js`).

### Fixed — Release Download Integrity Verification (Update + Installer)

#### Fixed

- Every release-download path now verifies the artifact against the sha256 digest GitHub publishes per asset in the release API response (`digest: "sha256:<hex>"`), before the bytes are allowed near execution — closing the machine-takeover path a security audit flagged: the self-update and installer flows extracted and *executed* the downloaded tarball (the launcher shim runs `node $data_directory/scripts/cli.js` on every command) with no checksum, signature, or redirect control anywhere in the chain. The digest is the integrity anchor: the API is reached over TLS, so it is an independent-enough channel to catch tampering, truncation, and hostile redirects of the asset itself. A fully in-band attacker (one who controls the API response) can rewrite the digest too — closing that needs an out-of-band signature, which stays deferred until the project publishes one. An accepted incompatibility: a release whose tarball asset publishes no digest is refused outright by both flows (fail closed), rather than extracted unverified.
- `scripts/update.js` verifies the digest after the download and before `tar -xzf`, with the same refusal shape as the pre-existing foreign-tarball checks: the update fails loudly and the running installation is untouched. `scripts/installVscodeExtension.js` mirrors the gate for the `.vsix` (`code --install-extension` executes the package inside it), failing before any install attempt.
- The digest arrives from the API response, so it is untrusted input too: `resolveLatestRelease` validates it against the exact GitHub shape (`sha256:<64 hex>`) and a malformed digest refuses the release rather than being compared. `scripts/releaseAssets.js` gains `verifyFileDigest` — the file is streamed through `createHash` (a large tarball never sits whole in memory) and compared with `timingSafeEqual` on fixed-length buffers.
- Redirect control (`scripts/releaseAssets.js` `downloadToFile`): fetch's default redirector was replaced with manual following — every hop is re-validated through the same https-or-first-host rule the initial URL gets (so a hostile chain can never walk the tarball bytes through an `http://` hop), hops cap at 5 (`MAX_REDIRECTS`), a 3xx without a `location` header is an error, relative locations resolve against the current hop, and the whole chain shares one total-time budget (`timeoutMs` seam for tests) instead of restarting the clock per hop. Verified against the real release: `github.com` → `objects.githubusercontent.com` follows, the 227 KiB tarball verifies, and the digest matches the one published at resolution time.
- The shell installer (`scripts/install-cli.sh`) mirrors the Node choke points it previously lacked: the asset URL from the API response is validated before any request (https only, or plain http on the API host itself — the same-host exception that licenses the test seam); the download runs with `--max-redirs 5` plus `--proto '=https'` whenever the asset URL is https (so curl cannot follow a downgrade mid-chain); and the *effective* final URL is re-checked after the transfer (`curl -w '%{url_effective}'`), since curl's transport checks never cover the URL actually served from. The explicit-URL install mode takes the same scheme check — a plain-http URL is now refused before any request, matching the Node path's `validatedDownloadUrl`; pass a local tarball path for offline installs.
- The installer's `--latest` mode requires the digest and verifies the downloaded tarball with `sha256sum` or `shasum -a 256` (whichever exists), refusing the install on mismatch or on a release that publishes no digest. The API base is now overridable via `WIZZ_INSTALL_API_BASE` (the same seam shape as `WIZZ_INSTALL_REPOSITORY`), so the whole digest/redirect/refusal surface is exercised offline against a local server.
- No version bump: the changes live in the update/install tooling scripts, so the compiler (1.15.0), syntax (1.4.1), and output (1.8.2) contracts hold. New coverage: digest parsing/shape-validation, streaming verification (match, tampered bytes, unsupported digests, multi-MB streaming), redirect following (multi-hop with relative locations), redirect downgrade and cap refusals, the no-location error, and the shared time budget (`scripts/releaseAssets.test.js`); update-level fail-closed gates for a wrong digest and a digest-less release, with the old installation proven untouched (`scripts/update.test.js`); vsix-level gates with no install attempt after a failed check (`scripts/installVscodeExtension.test.js`); and offline installer runs for the happy path, digest mismatch, digest-less release, foreign http asset URL, and the http-downgrade redirect (`scripts/install-cli.test.js`).

### Fixed — State Scanner String Awareness

#### Fixed

- The state scanner (`src/compiler/parser/stateScanner.js`) ran its declaration regexes over raw script text with no lexical awareness, so declaration-shaped text inside string literals, template literals, comments, or regex patterns was read as real reactive state. A component carrying a code sample as a string constant (`const sample = "let clicks = 0; ..."`) compiled with a phantom `clicks` state entry, and the generated module died with `ReferenceError: clicks is not defined` on first execution — on the server and in the browser alike. Function-declaration-shaped text was equally hallucinated. The scanner now filters every candidate match through a lexical-context check (`isInsideTextualSpan`) that tracks string, template, line-comment, block-comment, and regex modes; regex literals are now tracked as first-class modes in `lexicalModesBefore` (previously skip-ahead, so a regex containing quote- or comment-like text left phantom modes open and misjudged later persist markers as nested).
- Initializers terminated at the *first* semicolon in the raw text, so a declaration whose value contained a semicolon inside a string (`let greeting = "hello; world"`) or a regex (`const pattern = /a;b/`) was truncated mid-value, and a `persist()` default like `persist('theme', 'a; b')` failed to parse its default. The scanner now walks forward lexically (`findInitializerEnd`) through strings, template literals (including `${ … }` nesting), comments, and bracket nesting to the true statement-terminating semicolon; for-header declarations keep their historical shape (the header's own semicolon ends the initializer). When no top-level terminator exists, the match falls back to the plain-text scan's truncated span so an unclosed `persist()` marker still reports its diagnostic instead of silently vanishing.

#### Changed

- The `/server` namespace is now reserved against page names at build time, mirroring `/api`: handler copies land in `dist/server/` for external Node hosts, and the dev server refuses `/server/**` requests so those copies are never served as static files — which made a page named `src/pages/Server.wizz` compile cleanly yet answer only the SPA-fallback shell in development SSR, with no diagnostic anywhere. The build now fails with a located error naming the claiming page (`build.js`, `build.test.js`; documented in `README.md`).
- Package and compiler version 1.13.0 → 1.13.1: parser-only fix, so the syntax and output contracts hold (`src/compiler/version.js`, `package.json`).

### Milestone 21 — Server API Routes

#### Added

- Server API routes: zero-dependency ESM handlers in `src/server/api/<name>.js` run inside the development server at `/api/*` routes, so third-party API calls and their secrets stay server-side — a `.wizz` form now calls same-origin `/api/...` and the key never appears in the browser's network tab. The default export receives a frozen, platform-plain context (`{ method, path, query, headers, body, json() }` — no Node `req`/`res`, keeping handlers runtime-portable) and returns a plain value (200 JSON), a string (200 text), `undefined` (204), or `{ status, headers, body }` for full control. Route mapping mirrors pages: lowercase, `index.js` names the directory, nested directories nest, `_`-prefixed entries importable but never routable, duplicate routes failing discovery with both claimants named (`scripts/apiRoutes.js`, `scripts/apiRoutes.test.js`).
- Server-side secrets via a gitignored `.env.server` at the project root: `KEY=VALUE` lines with `#` comments, no interpolation, surrounding quotes stripped, loaded into `process.env` once before the first request without overriding variables the real environment already provides. The file is never copied into build output and no served artifact ever contains its values — handlers read keys through `process.env` at request time.
- Dev-server wiring (`scripts/dev.js`): `/api/**` resolves through the discovered route table (a Map lookup, never a filesystem join, so traversal has nothing to resolve against) and executes handlers from their `dist/server/**` copies — the build pins `dist/package.json` to `{"type":"module"}`, so ESM handlers parse on every supported Node (18/20 have no module-syntax detection, which made a direct src import fail on `export` in CI); a per-request mtime sync from `src/server/**` (source mtimes preserved on copies) re-copies edited handlers without a rebuild, and the import is cache-busted by the source mtime — a handler edit applies on the next request. Edits to a private `_` module refresh its copy but only take effect in an importing handler once that handler file itself changes (Node's ESM cache keys on the handler's URL); touch the handler or restart. Unmatched `/api/**` answers 404 JSON instead of the SPA shell; `/server/**` (production handler output) is refused as static files in both dev and prod dists; handler throws, missing default exports, and syntax-error modules answer a fixed `500 {"error":"Internal server error"}` with detail logged server-side only; malformed `request.json()` answers 400; request bodies cap at 1 MB with a `Connection: close` 413; an undecodable pathname answers 400 instead of crashing the handler; and an ambiguous route collision logs and 404s while the server keeps serving. `options.loadEnv` and `options.apiDirectory` keep the wiring injectable for tests.
- Build support (`build.js`): `copyApiHandlers` copies `src/server/**` verbatim — routable api handlers and private `_` modules alike (handlers import the latter), preserving source mtimes — and emits a generated `dist/runtime/apiRoutes.js` manifest (routePath -> modulePath, same JSON-literal idiom as the page manifest) for external Node hosts following the same recipe as SSR delivery. A route collision fails the build (non-zero exit, JSON envelope record) while still writing an empty manifest, so no stale routing table from an earlier build can survive; no handler copies land. `/api` and `/api/**` join `/runtime` as reserved page namespaces in `validateRouteEntries` — a page named `src/pages/Api.wizz` fails the build with a located error rather than silently shadowing the API surface.
- `wizz init` scaffolds `src/server/api/health.js` — a working `/api/health` handler documenting the request context and the secrets rule (keys in `.env.server`, read through `process.env`, never in a `.wizz` file) — and its README gains a Server API routes section and layout entry (`scripts/initTemplates.js`, `scripts/initTemplates.test.js`, `scripts/init.test.js`).

#### Changed

- Package and compiler version 1.11.0 → 1.12.0 for the release cut carrying server API routes: additive only, so the syntax and output contracts hold (`src/compiler/version.js`, `package.json`).
- Release cut v1.13.0: package and compiler version 1.12.0 → 1.13.0 for the release cut carrying milestone 20 (development server workflow): CLI/dev-layer additions and the case-insensitive App.css merge only, so the syntax and output contracts hold (`src/compiler/version.js`, `package.json`).
- The milestone reverses one clause of the Development Server Decision, deliberately and narrowly: the dev server gains an API layer for author-authored handlers, but no sessions, persistence, ORM, or middleware — handlers are plain functions, production application hosting stays external to the framework, and page-delivery eligibility remains a compilation artifact (`ROADMAP.md`, amended paragraph).
- `scripts/apiRoutes.js` joins the shipped surface in all four places that list CLI scripts: `package.json` `files`, `packaging.test.js` `EXPECTED_FILES`, the installer's `--local` copy list, and the installer test's fake tarball.
- No compiler/syntax/output version bump: no compiler source, parser, or generated-module contract changes — same reasoning as milestones 13 and 20.

#### Docs

- README gains a "Server API Routes" section (authoring contract, `.env.server`, routing rules, request context, return shapes, error behavior, freshness, and the deployment recipe); `ROADMAP.md` records milestone 21 as completed with the Development Server Decision amendment; `STRUCTURE.md` lists `scripts/apiRoutes.js` and extends the dev-server prose; this file records the milestone.

### Milestone 20 — Improve the Development Server Workflow

#### Added

- Port override flag `--port <n>` (or `--port=<n>`) for `wizz dev`: accepted in any position, validated as an integer between 0 and 65535 (0 requests an ephemeral port), defaulting to 3000; at most one `--port` flag may appear — a repeated flag is rejected rather than silently letting the last one win (`scripts/cli.js`).
- `wizz dev` argument strictness preserved: every non-`--port` argument is rejected, including the build-only `--json` flag (the flag is now stripped only for `build` and `init`, so `wizz dev --json` errors instead of silently starting the server) (`scripts/cli.js`).
- Clear `EADDRINUSE` handling in `wizz dev`: attempting to bind an occupied port rejects `listen()` with an actionable error message (`Port <port> is already in use. Specify a different port with --port <n>.`); both the CLI and the direct `node scripts/dev.js` entry release the watcher handles (`close()`) before reporting, so the process exits with code 1 instead of hanging or throwing an unhandled exception (`scripts/dev.js`, `scripts/cli.js`).
- Dev-only Server-Sent Events (SSE) live reload channel at `GET /_wizz/reload`: broadcasts `data: reload\n\n` to all connected clients whenever a `.wizz` source file edit triggers a rebuild (`scripts/dev.js`).
- Injected client-side reload script: development HTML responses (static shell, fallback, and server-rendered routes) inject the reload script before the closing body tag to auto-reload open browser tabs when rebuilds finish; the injection anchors on the last, case-insensitive `</body>` occurrence so a literal `</body>` inside an inline script string (or a `</BODY>` spelling) cannot corrupt the page or push the script outside the document (`scripts/dev.js`).

#### Changed

- Production builds (`wizz build`) change in one place only, and only where the filesystem demands it: when a shell-side `App.css` and the extracted `app.css` resolve to the same output file (case-insensitive filesystems such as Windows and macOS defaults), `copyDocumentShell` now merges the shell stylesheet into the extracted file instead of overwriting the extracted component styles; on case-sensitive filesystems the shell stylesheet is copied verbatim, exactly as before. No dev-only reload script or endpoint is present in built output.
- No compiler, syntax, or output contract version bump required (all changes are dev server, CLI ergonomics, and build-time shell-copy behavior only).

#### Docs

- README, `ROADMAP.md`, and `STRUCTURE.md` updated with `--port <n>` usage, `EADDRINUSE` error guidance, and dev-only SSE live reload mechanism.

### Post-M19 — CLI Self-Update and Extension Install

#### Added

- `wizz update` fetches the latest GitHub release and swaps it into the managed installation (`${XDG_DATA_HOME:-~/.local/share}/wizz`) in place (`scripts/update.js`). The installed version is read from `src/compiler/version.js` by regex — never `require()`, so `--local` installs without a `package.json` and repeated test sandboxes behave alike — and compared numerically per segment (`1.10` sorts above `1.9`); an up-to-date install short-circuits before downloading and a locally newer install (e.g. a `--local` working-tree snapshot) is never downgraded. The swap improves on the installer's delete-then-rename: the old installation is renamed aside and restored if the second rename fails, and when the restore itself fails the staging directory holding the only copy is preserved and named in the error. An advisory lock (`.wizz-update.lock`, mkdir-EEXIST) serializes concurrent updates with the apt/dpkg remove-and-retry posture. Extraction shells out to `tar` with an argument array — GNU tar's extract mode refuses absolute and traversal members, which hand-rolling a parser would have to re-earn. `scripts/update.test.js` drives a fake managed installation against a real `tar`-built tarball served by a fake GitHub API server, covering the swap, the up-to-date and downgrade refusals, corrupt and foreign tarballs, missing `tar`, rollback, the preserved-copy failure, the lock, and the repository override.
- `wizz install-vscode-extension` downloads the release's `wizz-vscode-<version>.vsix` (independently versioned from the framework; its own regex, never assumed to match) and installs it through the `code` command (`scripts/installVscodeExtension.js`). The probe precedes any network work — a machine without VS Code fails fast with the manual releases URL and `code --install-extension` command instead of after a wasted download — and a nonzero install exit surfaces `code`'s stderr. On Windows the probe and install spawn through `cmd.exe /d /s /c` with an argument array, because Node ≥ 18.20 refuses to spawn `.cmd` shims without a shell (CVE-2024-27980) and `shell: true` stays off the table. `scripts/installVscodeExtension.test.js` adds the repo's first PATH-stubbed fake binary (a `#!/bin/sh` `code` script logging its invocations) alongside injected-spawn tests for probe failure, the happy path, stderr surfacing, the missing-asset refusal, and temp-directory cleanup.
- A shared release-asset layer, `scripts/releaseAssets.js`: one API call resolves the latest release for both commands (framework version taken from the tarball asset name's capture group, never the `v`-prefixed tag), with installer-matching error wording, a repository-shape validation before any URL composition, request timeouts via `AbortSignal.timeout`, streaming downloads into caller-owned staging paths, and a single download-URL choke point requiring `https:` or the operator's API host. `scripts/releaseAssets.test.js` exercises it against a local fake GitHub API server: happy resolution, missing-tarball and missing-vsix shapes, API-error passthrough, non-JSON and non-OK responses, foreign-host http refusal, api-base-host acceptance, repository validation with zero network calls, and streaming interruption.

#### Changed

- `runCli` now returns a promise of an exit code for the release-backed commands (`wizz update`, `wizz install-vscode-extension`); the entry block settles it into `process.exitCode`, and synchronous commands keep their exact number contract (`scripts/cli.js`). Both commands reject every argument, including `--json`. The three new modules join the shipped surface in all four places that list CLI scripts: `package.json` `files`, `packaging.test.js` `EXPECTED_FILES`, the installer's `--local` copy list, and the installer test's fake tarball — the latter so the installed-launcher test exercises the CLI's new top-level requires for free.
- Package and compiler version 1.10.1 → 1.11.0 for the release cut carrying the CLI self-update and extension-install commands and the scaffolded project README: additive only, so the syntax and output contracts hold (`src/compiler/version.js`, `package.json`). The README's `wizz --version` example moves with the bump and its inline CLI enumeration — which had silently trailed the CLI Stability list — now names `update` and `install-vscode-extension`.

#### Docs

- The root README routes extension installation through `wizz install-vscode-extension` first and documents `wizz update` beside the re-run-installer upgrade path; the CLI Stability list gains both commands. `STRUCTURE.md` gains the three modules and their tests and extends the CLI prose. `vscode-extension/README.md` leads its release section with the CLI command. The scaffolded project README offers `wizz install-vscode-extension` before the manual `.vsix` download (`scripts/initTemplates.js`, `scripts/initTemplates.test.js`).

### Post-M19 — Scaffolded Project README

#### Added

- `wizz init` scaffolds a `README.md` as the project's front door: what a Wizz application is, the CLI one-liner prerequisite, the `wizz dev` (http://localhost:3000, SSR + watch) and `wizz build` (disposable `dist/`) commands, the project layout, and how to install the VS Code extension — routing through the release assets (`wizz-vscode-<version>.vsix` from the GitHub releases page) rather than repository paths, because a scaffolded project has no clone of wizz.js. The template rides the existing scaffold semantics unchanged: it joins the all-or-nothing pre-check and is never overwritten, so initializing into a directory that already carries a README leaves it untouched (`scripts/initTemplates.js`). `initTemplates.test.js` pins the template set order and the README's release-asset/CLI/extension references; `init.test.js` and `cli.test.js` expect the new file and its place in the refusal message.

### Post-M19 — VS Code Extension Packaging

#### Added

- The VS Code extension is packaged as `wizz-vscode-<version>.vsix` by a zero-dependency packer, `vscode-extension/scripts/pack.js`: a hand-rolled OPC/zip writer (CRC-32 over a cached 256-entry table, `zlib.deflateRawSync` with a store fallback, deterministic 1980-01-01 DOS timestamps, unix-mode external attributes) producing `[Content_Types].xml`, an escaped `extension.vsixmanifest` (PackageManifest 2.0.0: identity, engine `^1.85.0`, workspace ExtensionKind, the `Microsoft.VisualStudio.Code.Manifest` asset), and the `extension/` surface — `package.json`, `extension.js`, `services.js`, `language-configuration.json`, `syntaxes/wizz.tmLanguage.json`, `README.md`, and the repository MIT `LICENSE` — with `test/`, `.vscode/`, and the packer itself excluded. Every manifest value derived from `package.json` passes XML escaping. `vscode-extension/scripts/pack.test.js` pins the CRC vectors, a full central-directory round-trip with independent local/central header cross-checks, byte-equality with the source files, member order and exclusions, manifest identity/engine/asset fields, XML escaping, byte determinism, and refusal of malformed metadata, missing whitelisted files, and pre-existing targets, plus `unzip -t` validation where `unzip` exists (skipped locally).

#### Changed

- The `Release` workflow packs the extension into the same `release/` staging directory and attaches `release/wizz-vscode-*.vsix` to the same `v*` tag GitHub Release as the framework tarball — after the `wizz-*.tgz` token the workflow contract pins — so installing the extension needs no marketplace and no separate repository (`.github/workflows/release.yml`, `packaging.test.js`). No compiler, runtime, or generator code is touched, so the syntax and output contracts hold at 1.4.1 / 1.8.2, and the extension keeps its first-distribution version 0.1.0. The `.vsix` asset name cannot match the CLI installer's `^wizz-\d+\.\d+\.\d+\.tgz$` asset regex, so `scripts/install-cli.sh` is untouched.
- Package and compiler version 1.10.0 → 1.10.1 for the release cut carrying the extension packaging: additive only, so the syntax and output contracts hold (`src/compiler/version.js`, `package.json`). The version-history note in `version.test.js` also regains its proper ending — the previous bump had spliced the 1.10.0 note into the middle of the 1.9.0 diagnostics paragraph, leaving a duplicated tail.

#### Docs

- `vscode-extension/README.md` documents installing the release `.vsix` beside the F5 development flow; the root README's install section notes the `.vsix` asset on the same release pages; `STRUCTURE.md` gains the packer tree lines; ROADMAP section 11 gains its completion notes.

### Post-M19 — Showcase Starter Scaffold

#### Added

- `wizz init` now scaffolds the showcase landing page instead of a minimal four-file starter: the global `App.css` design-token stylesheet linked from the document shell, the reactive `<wizz:head>` greeting page (query-parameter customization behind `onMount`), the persistent Counter (`persist`, props, the reset branch), the animated terminal Card, and a token-themed `/home` page demonstrating the `src/pages` route convention (`scripts/initTemplates.js`).

#### Changed

- `wizz build` copies a global `App.css` sitting beside the located document shell into the output, mirroring the dev server's copy: shells link it as `./App.css`, so production builds previously shipped a link that 404'd. The lookup is shell-relative (input directory or its parent), covering both build layouts, and a shell-less project copies neither file, keeping today's behavior. The relative `./App.css` link does not suppress the extracted `app.css` injection — the href pattern stays slash-anchored and case-sensitive — so a built shell links both stylesheets. No compiler contract is touched: syntax holds at 1.4.1 and output at 1.8.2 (`build.js`).
- Package and compiler version 1.9.0 → 1.10.0 for the next release cut: the version bump covers the showcase scaffold, the App.css build copy, and the installer failure-handling fix — all additive, so only the compiler's own version string moves while the syntax and output contracts hold (`src/compiler/version.js`, `package.json`).

#### Fixed

- The `Release` GitHub Actions workflow now creates its `release/` staging directory before running `npm pack --pack-destination=release`; `npm pack` does not create the destination itself, so tagged releases previously failed after the test suite with `ENOENT` while opening `release/wizz-<version>.tgz`. `packaging.test.js` now pins that guard in the workflow contract (`.github/workflows/release.yml`, `packaging.test.js`).

#### Docs

- The Get Started guide now states the project/framework separation up front: a Wizz project contains only source files (`index.html`, `App.css`, `src/**/*.wizz`), the compiler, runtime, and CLI live in the managed install rather than being vendored into the project, and everything under `dist/` is disposable generated output — compiled component modules, the copied runtime, and the extracted `app.css` — that ships self-contained for deployment (README.md).

### Milestone 19 — Scaffold Projects and Expose Structured Diagnostics

#### Added

- Stable diagnostic codes: every author-facing compiler `SyntaxError` carries a stable code from the frozen catalog `src/compiler/diagnostics.js` — `WIZZ-P###` for parser-stage failures (tokenizer, template parser, expression lexer, pratt parser, integrator, prop extractor, state scanner), `WIZZ-G###` for generator-stage failures (dom, component, server, hydration, persist initializer), and a deliberately empty, reserved `WIZZ-A###` analyzer namespace. All 104 throw sites across 13 compiler modules stamp their code through `compilerDiagnostic(code, message, ErrorConstructor)` with messages byte-for-byte untouched; identical failure conditions share one code, and programmatic `TypeError` guards (entry-point argument validation) stay uncoded by design. A 44-test corpus pins one verified author-facing failure per load-bearing code — P025–P030 are pinned through direct `lexExpression`/`parseExpression` calls, because the integrator wraps those failures in its own `WIZZ-P033` (`src/compiler/diagnostics.js` and the swept parser/generator modules).
- Structured error locations: thrown compiler errors carry numeric `error.line`/`error.column` beside the prose `at L:C` location, stamped by the error augmenter from the message's locator even when no `filePath` was supplied (`src/compiler/errorAugmenter.js`).
- The `diagnostics: 'collect'` compile option on both entry points: a failed compile returns `{ diagnostics: [record] }` instead of throwing and a successful one adds `diagnostics: []`; a record is `{ code, severity: 'error', message, file, line, column }` with a single-line file-qualified message (code frames stay exclusive to thrown errors). Collect mode never throws — uncoded failures such as entry-point misuse produce `code: null` records — and any other `diagnostics` value is rejected with a `TypeError` before compiling (`src/compiler/index.js`, `src/compiler/errorAugmenter.js`).
- `wizz build --json` (the flag is accepted in any argument position by both the CLI and `build.js`): prints the versioned envelope `wizz-build-diagnostics@1` — `{ format, ok, diagnostics, files }` — to stdout instead of the per-file prose. Per-file records reuse the compiler's collect-mode records with input-relative posix paths, build-level failures (bad directories, route collisions, unexpected filesystem errors) become null-code records so the envelope stays parsable on every failure path, and `files` lists every discovered component with its server-rendering eligibility in stable discovery order. stdout carries only the envelope in JSON mode; human output and exit codes are unchanged when the flag is absent (`build.js`, `scripts/cli.js`).
- `wizz init [directory] [--force]`: scaffolds the canonical starter project from `scripts/initTemplates.js` — a document shell carrying the runtime mount contract, `src/App.wizz` at `/` (document head block, scoped styles, link to `/home`), `src/pages/Home.wizz` at `/home` (server-renders and hydrates), and `src/components/Counter.wizz` demonstrating `persist('count', 0)`, props, `on:click`, and `<wizz:style>` — with no stylesheet or asset dependencies, so a scaffolded project runs with nothing but `wizz dev`. Refusals are conservative: a missing target directory is created at any depth, an existing non-empty directory is refused without `--force`, and an existing template file refuses the whole scaffold even with `--force` (all-or-nothing pre-check before any write); the command prints exactly what it created (`scripts/init.js`, `scripts/initTemplates.js`).
- `wizz --version` (also `wizz version`): prints the compiler and contract version triple from the frozen `VERSIONS` table, e.g. `wizz 1.9.0 (compiler 1.9.0, syntax 1.4.1, output 1.8.2)` (`scripts/cli.js`).

#### Changed

- Compiler version 1.8.3 → 1.9.0: the stable codes, structured locations, collect option, and JSON envelope are an additive diagnostics contract — accepted component syntax and generated output are unchanged, so syntax holds at 1.4.1 and output holds at 1.8.2. `package.json` stays in lockstep and the generator-banner fixture test is synced to the new banner string (`src/compiler/version.js`, `src/compiler/generator/componentGenerator.test.js`).
- The managed installer's copy list and the release tarball whitelist now ship `scripts/init.js` and `scripts/initTemplates.js`, so an installed `wizz` launcher supports init (`scripts/install-cli.sh`, `package.json`, `packaging.test.js`).

#### Fixed

- The installer's default `--latest` mode crashed with a raw `JSON.parse` stack trace when the GitHub API returned an error (e.g. the repository is private or has no published releases): `curl -f` delivers no body on a 4xx, and the script piped it into `JSON.parse` without checking curl's exit status. The lookup failure and the tarball download now fail with explicit guidance — the repository may be private or have no releases yet, and `--local` or an explicit tarball path are the alternatives. The release repository can be overridden via `WIZZ_INSTALL_REPOSITORY` for testing the failure paths (`scripts/install-cli.sh`).
- The installer is pipe-safe for the first-time `curl … | bash` bootstrap: a script read from stdin has no `BASH_SOURCE`, which under `set -u` could abort the install depending on the bash version; the source-directory lookup falls back to `$0` (it only matters for `--local` installs). A piped invocation is pinned by test, and the README documents the one-command first-time install.

#### Docs

- ROADMAP §19 is marked complete with implementation notes and the version-impact assessment; `STRUCTURE.md` gains `diagnostics.js`, `init.js`, and `initTemplates.js` plus the new CLI surfaces; the README documents `wizz init`, `wizz --version`, and the `wizz build --json` envelope; `src/compiler/README.md` documents the codes catalog, structured locations, and collect mode (its stale 1.7.0 version examples synced to 1.9.0); this changelog gains the milestone section.

### Post-M17 Maintenance

#### Fixed

- The Card terminal header now reserves space for all three macOS-style control dots, preventing the green dot from overlapping the terminal icon (`src/components/Card.wizz`).
- Scoped-style keyframe rewriting corrupted every animation name after the first in a comma-separated `animation` value (compiler patch 1.8.2): `scopeAnimationValue` computed each ident's absolute position as `cursor + match.index`, but `match.index` stays relative to the value start while `cursor` had already advanced past the first rewritten name — so `animation: cursor 0.5s step-end infinite alternate, blinking 0.5s infinite` scoped to `…, blinkinblinking-s1nfinite` (an unmatched name, silently dropping the second animation). The read cursor and the match base are now tracked separately, so every occurrence — including the same name repeated in one value — rewrites at its true position. Idents that merely contain a keyframe name (`spinning` with `@keyframes spin`) were already and remain untouched (`src/compiler/analyzer/cssScanner.js`).
- Empty non-void elements shipped without an end tag (server output patch 1.8.2): the server serializer closed only elements that had children, so the showcase Card's `<path></path>` inside an svg and `<code></code>` inside a pre delivered as unterminated start tags. The browser's recovery keeps such an element open and swallows the following markup into it — svg's trailing text became the path's child, pre's became the code's child — so the delivered childNodes stopped aligning one-to-one with the template positions the hydration walk verifies and the page fell back to a full client render behind a `[wizz] hydration mismatch` warning. Every non-void element now closes in delivered markup; void elements still ship without an end tag (`src/compiler/generator/serverGenerator.js`).
- A single newline immediately after a `pre`, `textarea`, or `listing` start or end tag is now dropped at parse time (compiler patch 1.8.3, syntax patch 1.4.1): the HTML tree builder drops it from the delivered markup (the authoring newline that keeps source indentation out of a preformatted box), so the AST carrying it meant the hydration walk verified text the browser never stored and the client's fresh mounts rendered a newline the delivered markup never showed. The parser strips that one newline (a `\r\n` pair counts; a lone `\r` is conservatively left alone) when a Text token immediately follows the tag — runtime output in between blocks the drop, since the compiler cannot see what expressions emit — and pushes no text node when the newline was the whole token, exactly matching what the browser builds (`src/compiler/parser/templateParser.js`).

#### Changed

- Showcase landing page restyled (purely styling, no markup or behavior changes): `App.css` gains dark graphite design tokens (solid colors, no gradients) with an amber accent, a balanced display headline, the subtitle re-ordered above the headline as a pill badge, and refined focus/selection states; the Counter's scoped style becomes a modern pill CTA with hover lift and tabular numerals; the Card terminal adopts the theme, adds macOS traffic-light dots via a CSS `::before`, and drops the dead `.copy_toggle` rules and `clipboard-check` keyframes that had no matching element in the markup. Responsive layout: `index.html` gains the missing viewport meta (the cause of everything rendering zoomed-out tiny on phones) plus a `theme-color`; below 960px the page is a single centered column with a horizontal white divider between the copy/counter block and the card, above 960px it becomes a two-column hero (terminal card left, badge/headline/counter right) with a vertical white divider in its own 1px grid track that stretches to exactly the copy column's height — both dividers are a `main::after` pseudo-element so no extra markup is needed.

#### Removed

- Showcase scratch files pruned ahead of milestone 18 packaging: the root `test.js` manual compile-demo script, `src/components/TestProps.wizz`, and the retired `src/pages/About.wizz` / `src/pages/Contact.wizz` showcase routes nothing routes to. The shipped boilerplate is now exactly the live landing page surface — `src/App.wizz` with `Card.wizz` and `Counter.wizz`, plus `index.html` and `App.css` — while `src/pages/Home.wizz` (and the `Panel.wizz` it imports) remain as the SSR reference demo's input.

- The development server degrades to its snapshot poller instead of refusing to start on platforms where recursive `fs.watch` is unavailable (Linux before Node 20 raises `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` at call time): a synchronous watch failure or a native watcher dying mid-session routes through a one-line notice and the existing 250 ms poller carries rebuild detection, so `wizz dev` keeps working all the way down to the supported Node floor (`scripts/dev.js`).

- `wizz build` writes `{"type":"module"}` into the output directory (when the output carries no package.json of its own): dist holds only ES modules, and Node 18 — which has no module-syntax detection — could not import the emitted server modules from a CommonJS application, breaking the dev server's SSR imports and the SSR recipe for application-owned servers. A package.json already present in the output directory is respected as the embedding project's deliberate choice (`build.js`).

#### Added

- The repository is now an npm-installable package: `package.json` (name `wizz`, zero dependencies, `engines.node >=18`, `type: commonjs`, `bin` wiring `wizz` to `scripts/cli.js`) with a strict `files` whitelist shipping the compiler (tests stripped), the browser runtime, the build and dev-server scripts, the SSR reference, the installer, the docs, and the landing-page boilerplate (`src/App.wizz`, `Card.wizz`, `Counter.wizz`, `index.html`, `App.css`) — plus an MIT `LICENSE`. The package version is pinned in lockstep to the compiler contract version by `packaging.test.js`, which also pins the zero-dependency mandate, the exact tarball surface (nothing from `test/`, `dist/`, `vscode-extension/`, or any `*.test.js` leaks), and runs a packed install end to end: `npm pack` → extract → `wizz build` a fresh two-file project with the shipped CLI.

#### Changed

- The installer installs from release tarballs by default: `scripts/install-cli.sh` with no arguments resolves the latest GitHub release asset (`wizz-<version>.tgz`), and a specific tarball path or URL is accepted; `--local` keeps the working-tree install for development. Both paths land the same managed layout and print the installed version, and a truncated or foreign tarball is rejected loudly instead of installed (`scripts/install-cli.sh`, covered by `scripts/install-cli.test.js`).

#### Docs

- ROADMAP §18 is marked complete with implementation notes; STRUCTURE.md gains the packaging artifacts (`package.json`, `packaging.test.js`, `LICENSE`, `.github/workflows/`, `scripts/install-cli.test.js`); the README's install section documents the release-tarball default with `--local` for development installs, and its build section documents the output directory's module-type marker.

### Milestone 17 — Persistent Cross-Tab State

#### Added

- `persist(key, default)` initializer marker: a reactive `let` declaration can initialize with `persist('storageKey', defaultValue)` to make the variable survive page refreshes and stay reactive across browser tabs while keeping every existing reactive behavior — templates read the bare identifier, mutations rerender, no wrapper object or accessor API. The parser records the marker with its cooked string-literal storage key, the default value's source text, and the exact `persist(…)` source span; everything malformed fails compilation with a located diagnostic (persist on a `const`, missing/non-string key, wrong argument count, trailing statements, unclosed or mismatched brackets, template-literal interpolation in the default, unsupported `\x`-style escapes). `persist()` on a prop is rejected by the prop extractor — props are parent-owned (`src/compiler/parser/stateScanner.js`, `src/compiler/parser/propExtractor.js`).
- Client persistence machinery, emitted only for components with at least one persistent declaration (persist-free components compile byte-identically apart from the version stamp): the initializer becomes `__wizzPersistRead("key", (default))`, every intercepted statement mutation of the variable additionally writes `__wizzPersistWrite("key", name)` after its `queueUpdate`, and each mount subscribes per key through `__wizzPersistSubscribe` with an `Object.is` guard so its own writes never echo back; a destroy hook unregisters every subscription. Four helpers are emitted per module while the bus itself is a `globalThis.__wizzStateBus` singleton shared by every module on the page (`src/compiler/generator/componentGenerator.js`, `src/compiler/generator/persistInitializer.js`, `src/compiler/generator/assignmentInterceptor.js`).
- Cross-tab delivery: the bus opens one `BroadcastChannel('wizz-state')` per page (unref'd in Node-style runtimes so tests and SSR never hang on it) and falls back to `storage` events where BroadcastChannel is unavailable — a tab's own write never fires its own storage event, and a removed key leaves mounted state alone until the next mount reads storage. Instances sharing a key converge: same-tab delivery reaches every mounted subscriber, and the `Object.is` guard deduplicates tabs that receive a write through both the channel and the storage event.
- Untrusted-storage hardening: reads `JSON.parse` defensively with the declared default as the fallback for absent, corrupted, or unreadable entries; stored values replace state wholesale (never merged, removing the merge vector for hostile stored objects); writes are guarded so quota failures or private-mode storage leave the in-memory state and peer delivery intact, and a later mutation persists again once storage recovers.
- Server-side rendering of persistent variables: the server target rewrites the marker to the plain default (`let theme = ('light');`) and emits no persistence machinery — the server has no storage, so the default is what renders — while the variable still ships in the state snapshot for hydration. Hydration verifies the delivered markup against the delivered state: persistent variables are seeded from the serialized snapshot for the adoption walk's expression checks, and the captured storage-read values are restored once the walk returns, so client storage stays the mounted truth and the emitted initial `update(ctx, { … })` writes the persisted value over the delivered server default (`src/compiler/generator/serverGenerator.js`).

#### Fixed

- Hydration of persistent variables (output patch 1.8.1): the adoption walk verified delivered markup by re-evaluating the template's expressions against the client's current values — for a persistent var, the storage read — while the server had rendered the declared default, so every stored value that differed from the default failed the walk and fell back to a full client mount behind a `[wizz] hydration mismatch` warning (first seen on the showcase Counter). Hydratable modules now seed persistent vars from the serialized state for the walk and restore the storage-read values right after it returns; the integration suite proves adoption by node identity and a clean warning log, including an `{#if}` branch whose test reads a persistent var.
- Placement diagnostics for the marker (compiler patch 1.8.1): `persist()` inside a function body or block used to compile into machinery that referenced a variable existing only in the callback's scope — the first template evaluation died with `rawClicks is not defined` — and a `persist()` nested inside another `persist()` default survived the splice verbatim and died with `persist is not defined`. Both are now located compile errors, and an author who binds the name `persist` themselves (function or let/const) opts out of marker recognition entirely, so scripts that compiled before the marker syntax existed keep compiling.

#### Changed

- Version contract: compiler 1.8.1, component syntax 1.4.0 (the `persist(key, default)` marker), generated output 1.8.1 (the additive `__wizzPersistRead`/`__wizzPersistWrite`/`__wizzPersistSubscribe` surface on persistent components, with delivered-state verification during hydration).

#### Docs

- ROADMAP §17 records the implementation notes; the parser README documents the marker's node shape and diagnostics, the generator README documents the helpers' runtime contract and the `persistInitializer` splicer, STRUCTURE.md and the README gain a "Persistent Cross-Tab State" section, and the CHANGELOG is synced.

### Milestone 16 — Scoped Component Stylesheets

#### Added

- `<wizz:style>` blocks: a component may declare one top-level `<wizz:style>` block holding raw CSS text (a `StyleBlock` node, tokenized as a raw-text element parallel to `<script>` — CSS braces, colons, and quotes never reach the template expression lexer). The block is root-only, attribute-free, and mutually exclusive with elements/expression children per the parser guards; a second block, a nested block, a self-closing block with content, and any plain `<style>` element all fail compilation with a located, file-aware diagnostic pointing at `<wizz:style>`. The extractor prunes the block from the template AST before generation so it never renders into body markup, and the payload carries `style: { css, scope, loc }` (`src/compiler/parser/tokenizer.js`, `src/compiler/parser/templateParser.js`, `src/compiler/parser/extractor.js`, `src/compiler/parser/index.js`).
- Deterministic scope hashing: a component's scope is an FNV-1a + djb2 mix over its full source (`Math.imul(fnv ^ djb2, 0x27d4eb2d) >>> 0`, base36 with an `s` prefix), computed by `computeStyleScope(source)` with no compile options — server and client always agree on a component's scope regardless of build flags (`src/compiler/parser/index.js`).
- Minimal zero-dependency CSS scanner: `scopeCss(css, scope)` rewrites each selector's terminal compound — type selectors, `*`, and `&` gain the scope attribute appended (`h2 { … }` → `h2[data-wizz-s="<scope>"] { … }`), while `.class`, `#id`, `[attr]`, and pseudo-* terminals have it prepended — descending into `@media`/`@supports`/`@container` prelude blocks only (every other at-rule passes through verbatim). Brace matching, strings, and comments are literal-aware (a same-length mask keeps structure analysis honest while insertions preserve formatting), and `@keyframes` names are scope-suffixed with all `animation`/`animation-name` references rewritten to match. It is deliberately not a full CSS parser: unknown at-rules and malformed input are passed through rather than rejected (`src/compiler/analyzer/cssScanner.js`).
- Scope attribute stamping: when a component has a style block, the analyzer stamps `data-wizz-s="<scope>"` on every element that component renders (imported component tags excluded — they carry their own component's scope), riding the same attribute-stamping path as `data-wizz-id`; an author-written `data-wizz-s` wins over the generated value, and style-free components keep byte-identical markup (`src/compiler/analyzer/idAssigner.js`).
- Server style delivery: styled components inject one deduped `<style data-wizz-style="<scope>" data-wizz-loc="…">` per document — the server target threads a `__wizzStyleScopes` accumulator through component emission (page-created, shared with children via the options argument), so a component imported by several pages or rendered twice injects exactly once per document. Style tags ride the head run **without** a `data-wizz-head-id` delivery tag: runtime scope dedup makes compile-time slice expectations impossible, and the positional slice verification from milestone 15 is untouched. CSS text is escaped for raw-text delivery (`<` → `\3c `, entities do not work inside `<style>`) so a rule can never terminate the tag early. Styled-only components activate the head run gate (`src/compiler/generator/serverGenerator.js`).
- Client style dedup and refcounting: `__wizzApplyHead` dedups `<style>` nodes by their `data-wizz-style` scope attribute — a fresh insert sets `data-wizz-refs="1"`, finding an existing copy (delivered by the server, or applied by an earlier mount) increments the refcount and reuses it instead of duplicating — and `__wizzReleaseHead` decrements on destroy, removing the stylesheet at zero. Hydration adoption reuses the same apply path, so server-delivered styles are adopted (refcounted, never recreated) and a hydration fallback's fresh apply adopts the delivered copy too. Orphaned delivered styles (the component never mounts client-side) are harmless dead weight; remounts adopt rather than duplicate because dedup is scope-based, not owner-based (`src/compiler/generator/componentGenerator.js`, `src/compiler/generator/hydrationGenerator.js`).
- Production extraction: `wizz build` writes one `dist/app.css` carrying every compiled component's scoped rules in discovery order under per-file header comments (computed through the same `scopeCss` the generators use), and copies the project's document shell (probing the input directory, then its parent for the conventional `wizz build src dist` layout) with `<link rel="stylesheet" href="/app.css">` injected before `</head>` — leaving shells that already link `/app.css` untouched and shell-less projects on the old behavior with a logged note. Style-free projects write no stylesheet and copy the shell verbatim (`build.js`).

#### Changed

- The hydration generator's leftover-run check reads delivery tags loosely (`!= null`), so absent `data-wizz-head-id` attributes read as claimed identically in real DOMs (`null`) and test shims (`undefined`).
- The document shell is now copied into the output directory by `wizz build` (previously hand-placed); `wizz dev` continues to require it at serve time.

#### Fixed

- Editing a child component no longer requires restarting `wizz dev`: each rebuild stamps child `.server.js` import specifiers with a fresh `?v=<timestamp>-<sequence>` query (a new `moduleQuery` compile option threaded from the dev server through `buildProject`/`compileServer` into the server generator), because Node's module cache keys on the full URL and queries never propagate through static imports — without the stamp, a rebuild re-evaluated only the page module while its cached children kept serving the first build's stale markup, scope hashes, and styles. Production builds omit the option and emit clean specifiers, byte-identical to before.

#### Docs

- ROADMAP §16 records the implementation notes; the compiler READMEs document the `StyleBlock` node, the raw-text style mode, the CSS scanner, scope stamping, and the style delivery/refcounting contract; STRUCTURE.md and the CHANGELOG are synced.

### Milestone 15 — Own the Document Head from Components

#### Added

- `<wizz:head>` blocks: a component may declare one top-level `<wizz:head>` block containing only `<title>`, `<meta>`, and `<link>` elements (the parser produces a `HeadBlock` node that never renders into body markup, and extracts it from the template AST before generation). Anything else — nested elements, elements inside `<title>`, bare text or expressions outside `<title>`, attributes on `<wizz:head>` itself, a second head block, a closing tag on a void element — fails compilation with a located, file-aware diagnostic (`src/compiler/parser/templateParser.js`, `src/compiler/parser/extractor.js`).
- Server-rendered head output: `renderComponent()` returns an additive `head` field — the component's own head markup followed by each rendered child's head in tree order, every node tagged `data-wizz-head-id="<ownerPath>"` (page owner `'r'`, child `'r/<componentId>'`) and `data-wizz-loc="<filePath>:<line>:<col>"` when the compile carries a `filePath`. Title text and dynamic attribute values evaluate at render time through the existing escape helpers; a head-free component-free page returns exactly the old `{ html, state }` shape with byte-identical output (`src/compiler/generator/serverGenerator.js`).
- Development-server head injection: `renderServerRoute` now destructures `head` from `renderComponent()` and injects `<!--wizz:head-start-->` + head + `<!--wizz:head-end-->` before `</head>` (function-form `String.replace`; skipped when the head is empty). The markers delimit the delivered run so the client can locate, verify, and consume it. No title de-duplication happens server-side — per-owner slice verification on the client requires every component's nodes delivered verbatim; precedence is resolved at mount time instead (`scripts/dev.js`).
- Client head management, emitted only when a component has its own head or renders head-declaring children (`headActive` — otherwise the module is byte-identical apart from the header stamp): six flush-left helpers drive the lifecycle. Fresh mounts build head nodes (`createHeadNodes()`: title text via one `textContent` assignment, attributes via `setAttribute`, `on:` directives skipped), tag them `data-wizz-head="h<n>"`, prepend them to `document.head`, and release them on destroy — so the router's existing destroy cascade swaps heads on navigation for free. Because the freshly applied title is the document's first title element (the one `document.title` reads), the deepest mounted component's title wins, matching the conflict policy without any de-duplication (`src/compiler/generator/componentGenerator.js`).
- Hydration head adoption: `hydrateCreate` accepts the server owner path (`'r'`, `'r/1'`, …), reads the marker-delimited run (pages) or scans `document.head` (nested children), and verifies each claimed node against a compile-time expectation structure (tag, coalesced title text, attribute name/value pairs, boolean presence flags) **without creating DOM**. Success claims the slice — ownership re-tagged, delivery tags consumed, titles moved to the head front, markers removed; any mismatch (wrong text, wrong tag, wrong attribute, wrong count, or unclaimed leftover delivery tags) warns once and falls back: claimed nodes released, the delivered run (or the component's own slice) stripped, and the component remounts fresh inside its existing root exactly like a body-tree mismatch. `hydrateRoot` threads the child's owner path (`'r/<componentId>'`) down to child adoptions (`src/compiler/generator/hydrationGenerator.js`).
- Title conflict policy: multiple `<title>` declarations resolve last-in-tree-wins with one development warning naming both locations (`Existing: <loc> Latest: <loc>`), fired from both mount (`__wizzApplyHead`) and claim (`__wizzClaimHead`). `<meta>`/`<link>` concatenate (legal HTML). Because claimed titles move to the head front on both mount and adoption paths, the last-declared title in tree order is the first title element — deterministic precedence with no silent first-wins.

#### Docs

- ROADMAP §15 records the implementation notes; compiler READMEs document the `HeadBlock` node, the additive `head` field, and the head helpers' runtime contract; STRUCTURE.md gains the head ownership summary.

### Milestone 14 — Render the Full Template Surface Server-Side

#### Added

- Recursive server rendering of component tags: the server target now renders an imported component by calling the child's own server module (`import * as __wizzServer_<Name> from "./<Name>.server.js"`, evaluated props at the tag position), so a page's delivered markup embeds its components' rendered HTML exactly where the tags appear. Child state snapshots serialize under the framework-reserved `__wizz` key as `state.__wizz.components["<componentId>"]` (nested trees nest the same way); the key is emitted only when the template contains component tags (a static presence check, so a tag in an untaken branch still emits it), keeping component-free state output byte-identical to milestone 12. Reactive names cannot start with `__wizz`, so the namespace stays framework-owned (`src/compiler/generator/serverGenerator.js`).
- `{#if}` and `{#each}` render server-side: the initially-taken branch is selected by re-evaluating the test against render-time state, and each lists render the initial collection with the item variable in scope. Each bodies keep the browser target's restrictions (exactly one root element, no components, no `on:` directives). Adjacency markers are now also emitted at branch boundaries so the browser cannot merge text across a branch boundary (`src/compiler/generator/serverGenerator.js`).
- Bottom-up eligibility over the import graph: `build.js` computes server-rendering eligibility bottom-up with a memoized DAG walk over each payload's component imports — a file is eligible when its own `compileServer` and `compile({ hydratable: true })` compile with every rendered import vouched for by the child's own eligibility. Eligible **component files** now also ship `<Name>.server.js` and `<Name>.hydrate.js` beside their client module (the milestone 13 "components never ship server builds" rule flips deliberately: a page's server module imports its components' server modules). Ineligible files log one note chaining the deepest underlying reason (`Underlying reason: <child's own gate failure>`), and cyclic component imports are reported as ineligibility (`its import graph contains a cycle.`) instead of recursing forever (`build.js`, exported as `computeServerEligibility`).
- Nested hydration through a new additive public export: hydratable modules now export **`hydrateRoot(rootNode, props, state)`** alongside `hydrateComponent` (`mountInstance(target, props, hydrate, state, adoptSelf)` internally). `hydrateRoot` adopts the *given* node as the component root; the parent's adoption walk verifies only that the component-tag position holds an element, then adopts the child through the child's own hydratable module seeded with the state slice under `__wizz.components`. Reactive prop bindings re-apply through `setProps`, and a mismatch at any depth remounts **inside the child's root** — nothing is detached from the parent and the parent never fails. The adoption walk flattens if/each sequences (branch tests re-evaluated against seeded state), adopts each items positionally while rebuilding the records map with key-aware update closures so client list updates mutate adopted nodes, and creates only the list anchor (an empty text node cannot survive HTML serialization) (`src/compiler/generator/hydrationGenerator.js`).

#### Fixed

- A component tag inside an `{#if}` branch had its hydration walk ref declared inline inside the generated branch block while the adoption block after the walk references it at function scope — hydrating such a page threw `ReferenceError`. Component-tag refs are now pre-allocated at `hydrateCreate` scope (`src/compiler/generator/hydrationGenerator.js`).
- The template parser's `IfBlock.children` alias repoints to the alternate at `{:else}`, so the dependency analyzer, ID assigner, and the component-ref collector all walked consequent content only in blocks *without* an else branch: expressions in a taken-branch-with-else got no dependency metadata, reactive elements got no `data-wizz-id`, and component tags got no `componentId` (surfacing as `Component <Counter> is missing its componentId` on any page with an imported component inside an `{#if}`-with-else). All three traversals now walk `consequent` and `alternate` explicitly (`src/compiler/analyzer/dependencyAnalyzer.js`, `src/compiler/analyzer/idAssigner.js`, `src/compiler/generator/domGenerator.js`).

#### Changed

- Showcase route `/` now server-renders: `App.wizz` moved its top-level `document.location.search` read (which failed `renderComponent()` at runtime in Node and streamed the plain shell) behind `onMount`. The server target's `onMount` is a no-op, so the page delivers the `"friend"` default server-side; mount hooks run after state seeding on both client paths, so the reactivity engine applies the query-param name after hydration.
- Compiler and generated-output contracts bumped to 1.5.0 (component syntax stays 1.1.0): previously-rejected templates (blocks, component tags with eligible import graphs) now compile; default non-hydratable `compile()` output stays byte-identical apart from the version header stamp. `compileServer(source, options)` and `compile(source, { hydratable: true })` gain the gate options `componentServerRenderable` (import names vouched for by their child's eligibility; a missing entry conservatively rejects that tag) and `componentIneligibilityReasons` (child gate failures chained into the diagnostic). The 1.4.0 → 1.5.0 step fixes the if-with-else traversal bug above, which changes generated output (corrected IDs, dependency flags, and component refs) for if-with-else templates.

#### Docs

- README's server-rendering section documents the recursive surface, bottom-up eligibility, the chained ineligibility note, and the `hydrateRoot` nested-adoption contract; ROADMAP §14 records the implementation notes including the author-script limitation (browser globals in author scripts fail `renderComponent()` at runtime and stream the plain shell).

### Milestone 13 — Serve Server-Rendered Routes from the Development Server

#### Added

- Build emission for server rendering: `build.js` compiles every route page (`App.wizz` and `src/pages/*`, resolved by `getRoutePath`) through both milestone 12 server targets and emits `dist/pages/Home.server.js` (compileServer output, no source map) and `dist/pages/Home.hydrate.js` (hydratable compile, with source map when the page has reactive markers) beside the byte-unchanged client module. Non-route files (`src/components/*.wizz`) never attempt server emission. Eligibility is decided by compiling both server targets before writing either: a client-compile failure remains a build failure, while a server-target failure after a successful client compile is treated as the server-renderability gate — the page stays client-only and the build logs one `Note: server rendering skipped for <file> — <reason> Serving the client build only.` note (never an error). This preserves the invariant that a delivered state script always implies a hydratable build exists.
- Route manifest fields: `dist/runtime/routes.js` page entries gain `serverModulePath` and `hydratableModulePath` (dist-relative POSIX paths) for eligible pages, `null` otherwise. Builds never clean `dist/`, so the manifest — not file existence — is authoritative for eligibility; a page whose server build becomes ineligible leaves its old artifacts orphaned and ignored.
- Dev-server delivery: `scripts/dev.js` resolves document requests against the generated manifest per request (the `JSON.stringify` array literal in `routes.js` is parsed synchronously — no cached route table, so a render can never be stale after a watch rebuild). For a matching route with a server module it imports the module cache-busted by file mtime, calls `renderComponent()`, and streams the document shell with the rendered HTML inside `#app` and `serializeInitialState()` output as its sibling script. Injection uses function-form `String.replace` so `$&`/`$'`/`$$` sequences in rendered HTML cannot corrupt the document. Route matching mirrors the client router exactly (exact pathname, routes lowercased at build time), so unmatched paths, ineligible routes, unknown assets (HTTP 404), and the SPA fallback behave byte-for-byte as before; any render failure logs `Server rendering failed for <route>: …` and falls back to the plain shell.
- Runtime hydration on first load: `src/runtime/main.js` builds a `hydratableRoutes` map from non-null manifest fields and passes it to the router. `src/runtime/router.js` hydrates only on the first render: it finds `script[type="application/wizz-state"]` beside the mount point, removes it after reading, imports the route's `hydrateComponent`, and adopts the delivered markup — the standard client module is never loaded on this path. Unreadable state, a missing hydratable build, or failed adoption drops the server markup and mounts fresh, never a duplicate DOM; server markup is likewise dropped before a first-render not-found render. A monotonic `renderSequence` token checked after every `await` abandons a render superseded by a newer navigation, which also fixes a pre-existing double-mount race when `popstate` fires while a route import is in flight.

#### Changed

- No version bump: compiler sources and both generated module contracts are untouched — the manifest and runtime entry are unversioned build/runtime artifacts, and eligibility is a build-time decision, not a compiler behavior change.

#### Docs

- README's server-rendering section documents the native `wizz dev` delivery recipe; `scripts/ssr-demo.js` remains the manual application-owned reference. Browser support adds the runtime hydration requirements (`Document.querySelector()`, `Element.remove()`) and removes a stale duplicate `Browser Support` section that still claimed no SSR or hydration.

- Reactive DOM updates are now scoped to each mounted component root rather than the whole document. Imported components can therefore reuse local `data-wizz-id` values without their event-driven updates overwriting reactive nodes in a parent or sibling component.

### Milestone 12 — Add Server-Side Rendering

#### Added

- Server compilation target: `compileServer(source, { filePath })` in `src/compiler/index.js` runs the standard pipeline (`parseComponent` → `analyzeDependencies` → `assignNodeIds`) and emits a self-contained ES module with no DOM dependency. It exports `renderComponent(props = {})` returning `{ html, state }` — the HTML string plus a snapshot of the component's reactive non-prop state — and `serializeInitialState(state)`, which renders the delivery script `<script type="application/wizz-state">…</script>` with every `<` escaped so hostile state content cannot close the tag early. Server output carries no source map: server output is an HTML string evaluated at request time, not a positional DOM artifact.
- The server target accepts a deliberately narrow v1 surface: the root element, static markup, text interpolations, dynamic attributes, and top-level props. Templates using `{#if}`, `{#each}`, component tags, void elements with children, reactive names matching `__proto__` or the reserved `__wizz` prefix, or malformed `on:` directives fail the compile with located, file-aware diagnostics (`src/compiler/generator/serverGenerator.js`). The author's top-level script executes verbatim and trusted on both targets; event handlers and lifecycle hooks are client-only (on the server target `onMount`/`onDestroy` are collected but never invoked, and `on:` attributes are skipped).
- HTML string escaping: text output escapes `&`, `<`, `>`; attribute values additionally escape `"`. Dynamic `value`/`checked`/`disabled` render as `checked`/`disabled` bare attributes only when truthy and always render `value`; void elements (`br`, `input`, …) never emit self-closing syntax so browser parsing preserves the exact node layout. Adjacent text-like children are separated by `<!-- -->` markers — Wizz templates cannot contain comments, so the marker is unambiguous — because browsers would otherwise merge adjacent text nodes and break the positional `childNodes[<index>]` targeting `update()` relies on.
- Hydration: `compile(source, { hydratable: true })` gates the component against the same server-renderable surface and emits an additional `hydrateComponent(target, props, state)` named export alongside the unchanged default `mountComponent` (`src/compiler/generator/hydrationGenerator.js` + `src/compiler/generator/componentGenerator.js`). Hydration adopts the mount point's first element and verifies it positionally against the template AST — lowercased tag names, stripped comment markers, exact child-node counts, `data-wizz-id` values read from the AST attribute, and text contents re-evaluated against the seeded state. Event listeners are collected during the walk and attached only after it passes. Any mismatch produces exactly one `console.warn('[wizz] hydration mismatch: … Falling back to client rendering.')`, clears the mount point, and falls back to a full client mount; a hostile `__proto__` key in the state object cannot pollute prototypes (seeding uses `Object.prototype.hasOwnProperty.call` + bracket access, and props are never seeded).
- End-to-end coverage: `test/hydration.test.js` renders the `test/fixtures/hydration.wizz` component on the server, delivers its markup and state script into a DOM shim with a browser-faithful HTML parser, hydrates with zero `createElement`/`createTextNode` calls, verifies byte-identical markup round-tripping and entity decoding, drives event-driven reactive updates on the adopted nodes, and covers the mismatch fallbacks (tampered text, empty or mistagged mount point, injected whitespace) plus prototype-pollution and escaping-boundary cases. The benchmark suite pins hydration operation counts: zero DOM creation, one initial reactive text write, and one targeted lookup per reactive variable (`test/benchmarks.test.js`).
- `{#if}` and `{#each}` block nodes now record their source location (`loc`) so server-target rejections point at the directive (`src/compiler/parser/templateParser.js`).

#### Changed

- Compiler and generated-output contracts bumped to 1.3.0 (component syntax stays 1.1.0): the compiler gains an explicit server target and an opt-in `hydratable` flag, and the output contract additively gains the optional `hydrateComponent(target, props, state)` export on hydratable modules. Default `compile()` output is unchanged — byte-for-byte — and is now pinned by an exact-string regression test.
- `generateComponent(astPayload, options)` accepts an options object; the existing single-argument call shape is unaffected.



### Milestone 11 — Build a VS Code Extension (in progress)

#### Added

- Initial first-party VS Code extension in `vscode-extension/`: `.wizz` language registration, TextMate syntax highlighting, language configuration, file-watch and save-triggered compiler diagnostics, Go to Definition for default component imports, route-aware page navigation, and command-palette integration for the stable `wizz build` and `wizz dev` commands.
- Focused Node tests for compiler-diagnostic location parsing, component-import target resolution, and CLI command routing. The extension host uses only VS Code's supplied `vscode` module and Node built-ins, keeping the core compiler and runtime dependency-free.

#### Fixed

- Added the `Run Wizz Extension` Extension Development Host launch configuration at both the repository root and extension folder, which opens the Wizz project automatically, and clarified that editor features are available in the separate development-host window, not in the extension source window.
- Removed redundant activation-event declarations now generated by VS Code from the extension's language and command contributions.

### Docs

- Clarified that the managed `wizz` CLI is a copied installation: rerun `./scripts/install-cli.sh` after pulling compiler, runtime, build, or CLI changes, while ordinary `.wizz` source edits do not require reinstalling.

### Milestone 10 — Add Component Props

#### Added

- Component props: a child declares inputs with `export let name = <default>;` (or a bare `export let count;` for `undefined`) and a parent passes them as attributes on an imported component tag. Static attributes pass their string, bare attributes pass `true`, and dynamic attributes pass the evaluated expression; the child factory receives an explicit props object — `mountComponent(target, props = {})` — so instances never read ambient parent state.
- Reactive prop updates: the parent's generated `update()` delivers changes through guarded `component_<id>.setProps({ prop: value })` calls on factory-scope instance references, so children rerender in place through their own batched scheduler without remounting, and child identity is stable across parent rerenders. `setProps()` skips destroyed children, ignores undeclared keys, compares with `Object.is` so identical updates are free, and re-applies the declared default when the parent explicitly passes `undefined`.
- Read-only props: any statement-level mutation of a prop name (`name = x`, `name++`, `name += x`, `name.prop = x`) is a compile-time error with a source location, enforced by a new `findReactiveMutations()` export from the assignment interceptor that shares the syntax-aware scanner. Function parameters and block-scoped `let`/`const`/`var` declarations now shadow reactive names for their scope, so locally shadowed names can be mutated without triggering the check or a spurious update notification.
- Prop extraction: a new `src/compiler/parser/propExtractor.js` finds `export let` statements on the scriptLexer token stream, records `{ name, defaultValue }` in declaration order, and removes the statements from the raw script. Extents are syntax-aware, so strings, template literals, comments, and regex literals cannot hide a semicolon or a nested `export`; non-`let` exports, multi-declarator statements, missing semicolons, statement-swallowing extents, reserved names (`props`, `__proto__`, strict-mode reserved words, and the framework-reserved `__wizz` prefix) are all compile-time errors with locations.
- Analyzer component identity: `assignNodeIds()` now assigns a sequential `componentId` to imported component tags (never `data-wizz-id`, since component tags create no DOM), giving the generated `create()` and `update()` a shared factory-scope instance reference.
- Conditional-branch updates: the update generator now walks `{#if}` branches, so reactive text, dynamic attributes, and component props inside conditional branches participate in updates. Previously the analyzer assigned them `data-wizz-id` targets but no update code was ever emitted for them.
- Tests: prop extraction and invalid-syntax coverage, prop dependency and componentId analyzer coverage, props-object emission and setProps routing in both generators, executed-module tests for the props contract (defaults, missing props, read-only enforcement, `Object.is` deduplication, undefined-default reapplication, teardown no-ops, a regression for a prop named `value` that once collided with a generated local), and mounted end-to-end tests in `test/componentProps.test.js` covering static/dynamic/boolean props, defaults, nested prop chains, identity preservation, teardown cascades, and build-time rejection of invalid prop syntax.

#### Changed

- Versions bumped under the documented policy: component syntax 1.0.0 → 1.1.0 (prop declarations and attributes on component tags are additive syntax), generated output 1.1.0 → 1.2.0 (`mountComponent(target, props)` signature, optional `setProps()` handle member, prop bindings, and component instance references are additive), compiler 1.1.0 → 1.2.0.
- `scriptLexer.js` moved from `src/compiler/generator/` to `src/compiler/` as a shared compiler-root utility alongside `errorAugmenter.js` and `sourceMapGenerator.js`, because both the parser (prop extraction) and the generator (assignment interception) now consume it. Import paths updated; no behavior change.
- Component tags previously rejected all attributes ("does not support attributes or children"); they now accept attributes as props and still reject children, `on:*` directives, and `__proto__` prop names.

### Milestone 7 — Production Hardening (in progress)

#### Added

- Compatibility and versioning policy: `src/compiler/version.js` exports a frozen `VERSIONS` table with `compiler`, `syntax`, and `output` semver entries. `compile()` returns the versions a component was compiled with, every generated module is stamped with a first-line header (`// Generated by Wizz 1.1.0 (component syntax 1.0.0, generated output 1.1.0). Edits will be overwritten.`), and the generated-output contract surface (`mountComponent(target)`, the returned `{ destroy() }` handle, and the `__wizz*` root-node properties) is pinned by a test so any breaking codegen change fails the suite until the version is bumped deliberately. Documented in the READMEs under "Compatibility and Versioning".
- Syntax-aware JavaScript handling: a new `scriptLexer.js` tokenizes component script (strings, template literals with nested `${}` interpolations, comments, regex literals with a regex-vs-division heuristic matching real engines, multi-character operators, radix and BigInt numbers) while preserving source offsets, and `assignmentInterceptor.js` was rewritten to decide rewrites on the token stream with a context stack instead of character scanning.
- Reactive mutations are now rewritten inside function and arrow callback bodies: `onMount(() => { status = "ready"; })`, `setTimeout(() => { count = 1 }, 100)`, event handlers, object methods, getters/setters, class methods, async and generator functions, IIFEs, `switch` cases, and `try`/`catch`/`finally` blocks all notify the scheduler. Previously these passed through unrewritten because parentheses hid their bodies.
- Parameter shadowing: function, arrow, and `catch` parameters shadow component state, so mutations of parameter names inside their own bodies (`items.map(count => { count = 1; })`) are left alone; suppression ends when the body closes.
- Automatic semicolon insertion: semicolon-less statements are intercepted correctly, including statements that end at a newline and prefix/postfix `++`/`--` across line breaks.
- 67 interceptor tests and 25 lexer tests covering the capability and safety matrix, including executed generated scripts verifying `queueUpdate({ count: true })` dispatch.
- Benchmark fixtures and deterministic regression tests: 1,000 repeated event updates must schedule one update and make one reactive DOM lookup/write; 25 listener-heavy mount/destroy cycles must remove every tracked listener; and a 121-element static tree must mount without reactive lookups. The tests report local durations without using unstable timing thresholds.
- Browser support and deployment contract: Wizz documents its evergreen ES-module browser baseline, required browser APIs, no-polyfill/SSR boundary, and HTTP(S) serving requirement. Security guidance now makes the trusted-component-code boundary, dynamic-attribute validation responsibility, development-server limits, production hosting/CSP responsibility, and source-map source exposure explicit. Generated-code assumptions document DOM ownership, single-use destruction, cleanup responsibility, and the current document-wide reactive-ID limitation.

#### Changed

- Compiler version bumped to 1.1.0 and generated-output contract to 1.1.0 (component syntax stays 1.0.0) under the new bump rules: the interceptor change is an additive capability, not a breaking one.
- The interceptor's non-interception boundary is now deliberate and documented: assignments in expression position (call arguments, conditions, object literals, class field initializers, template `${}` interpolations), unbraced `if`/`else`/`while`/`do` bodies, chained assignments beyond the first target, and destructuring pass through untransformed, and any statement whose extent cannot be established confidently is never rewritten — a missed interception is acceptable, corrupted output is not.

#### Fixed

- Division followed by a regular expression no longer corrupts output. The old character scanner treated `average = total / count;` followed by `const re = /x = 5/;` as one unterminated regex region and merged the statements, placing the update notification after the wrong statement.

### Milestone 8 — Promote a Public CLI (in progress)

#### Added

- Managed local `wizz` installation without npm or a package registry: `scripts/install-cli.sh` copies the required runtime to an XDG data directory and installs a launcher in an XDG bin directory. `wizz build` delegates to the existing project compiler with `src` and `dist` defaults, `wizz build <input-directory> <output-directory>` accepts explicit paths, and `wizz dev` delegates to the existing development server for the directory where it is invoked. Command parsing rejects unknown commands, incomplete build paths, and unsupported dev arguments with actionable usage guidance.
- CLI stability contract: the installed `wizz` interface is the supported automation surface, while direct Node entry points remain implementation details. Build failures, invalid commands, invalid argument combinations, and missing development document shells exit non-zero with actionable errors; `wizz dev` validates `index.html` before it opens a server.
- Command-level tests cover command parsing, the conventional default build, explicit build paths, development-server delegation, propagated build failures, missing document shells, and a managed local installation in an isolated home directory.

### Milestone 9 — Generate File-Based Routes

#### Added

- File-based browser routing: every build generates `dist/runtime/routes.js` from `src/App.wizz` and `.wizz` files below `src/pages`. The browser runtime builds lazy dynamic imports from that manifest rather than using a repository-owned route table.
- Route conventions: `App.wizz` or `pages/index.wizz` maps to `/`; nested page paths map to lowercase URL segments; nested `index.wizz` maps to its containing directory.
- Build validation rejects duplicate normalized routes and `/runtime`-prefixed routes, reporting the component paths involved. Rebuilds regenerate the manifest, so deleted pages no longer claim a route.
- Build and runtime tests cover manifest generation, root and nested paths, direct page loads, lazy imports, collisions, reserved paths, and page removal.

#### Fixed

- Development watching now includes a 250 ms source-file polling fallback alongside native events. This keeps `wizz dev` rebuilds reliable on mounted filesystems such as WSL's `/mnt/c` when native file notifications are missed.

### Milestone 6 — Expand Core Component Features Deliberately

#### Added

- Event directives: `on:<event>={handler}` compiles to native `addEventListener()` bindings. A handler may be a component-local function or any non-empty listener expression, such as `(event) => increment(event.detail)`.
- Dynamic attributes and properties: brace-valued attribute expressions update on reactive changes; `value`, `checked`, and `disabled` use property assignment while other dynamic attributes use HTML attributes.
- Conditional rendering: `{#if condition}` / `{:else}` blocks with generated update code.
- List rendering with keyed reconciliation: `{#each items as item (item.key)}` for object collections, plus a keyless positional form `{#each list as item}` for primitive arrays using index-based keys. Each blocks must be nested inside a native element and contain exactly one native root element; event directives and nested `{#if}`/`{#each}` blocks inside a body are compile-time errors rather than silently dropped or stale-closing code.
- Component imports: a `.wizz` component can import another `.wizz` component and use it as a tag. The build rewrites the import to the compiled module, imported tags mount as child components, and destroying a parent destroys all mounted children.
- Lifecycle hooks: `onMount(hook)` and `onDestroy(hook)` are provided by the generated closure with no import needed. Mount hooks run after the DOM is attached, child components are mounted, and the initial render completes; destroy hooks run at the start of `destroy()` while the DOM is still attached.
- Scheduler batching: `queueUpdate()` merges change flags into a pending set and flushes exactly one `update()` pass per microtask, so one handler mutating several reactive variables produces one DOM update. Calls before mounting completes are ignored, and a pending batch is cancelled by `destroy()`.
- Tracked listener cleanup: listeners Wizz attaches through `on:` directives are registered in a factory-scope registry and removed during `destroy()`.

### Milestone 5 — Add a Wizz Development Command

#### Added

- `node scripts/dev.js`: one command that runs the project build, serves the output directory over HTTP using Node's built-in modules (zero dependencies), and reports the local URL and compilation errors cleanly.
- Watch mode: source files are watched and changed `.wizz` files are rebuilt. (The dev server caches compiler modules in memory, so restart it after changing compiler code under `src/compiler`.)
- SPA fallback: unknown non-file requests return `index.html` so direct navigation to a client-side route works.

### Milestone 4 — Add Minimal Client-Side Routing

#### Added

- Explicit route table (not file-based routing) mapping paths to dynamic component imports.
- Route resolution from `window.location.pathname` to a component module, with a not-found component for unmatched paths.
- `navigate()` helper using `history.pushState()` with rerender, plus `popstate` handling so browser Back and Forward mount the expected component without a page reload.
- Teardown contract: the currently mounted component is destroyed before the next one mounts.
- Tests for route resolution, teardown, not-found behavior, and history navigation.

### Milestone 3 — Define the Application Entry Contract

#### Added

- `index.html` is a document shell only: it supplies `<div id="app"></div>` and loads one module entry instead of importing an example component inline.
- Browser entry module `src/runtime/main.js` that locates the mount target and reports a missing target.
- The build emits runtime modules into the output directory alongside compiled components.

### Milestone 2 — Make the Build Script a Project Compiler

#### Added

- `node build.js src dist`: compiles every `.wizz` file below the input directory, recursively, preserving relative paths (`src/pages/Home.wizz` → `dist/pages/Home.js`) and creating missing output directories.
- Independent compilation: every file is compiled and every failure is reported with its file path; the process exits non-zero when one or more files fail.
- Source protection: source files are never overwritten and the source directory is never used as build output.
- Tests using a temporary fixture tree covering nested inputs, successful output, and invalid components.

### Milestone 1 — Stabilize the Compiler Contract

#### Added

- Single public compiler API: `compile(source, { filePath })` runs parsing, dependency analysis, node ID assignment, and generation, returning the generated module source, the analyzed payload, and version information.
- Compiler errors include the input file path as well as source location when compilation is initiated from a file.
- End-to-end fixtures that compile representative `.wizz` components and execute the generated module against a minimal DOM.

#### Changed

- The script transformation boundary is documented as deliberately scoped: the assignment interceptor is not a JavaScript parser, and the docs must not represent it as one. (Superseded in Milestone 7 by the syntax-aware rewrite, which keeps the same never-corrupt-valid-JavaScript guarantee.)

#### Docs

- Parser, analyzer, generator, and their README files are kept synchronized whenever behavior changes.

### Project foundation (pre-roadmap)

#### Added

- The compiler pipeline itself: component parser, state scanner and dependency analyzer, node ID assigner (`data-wizz-id` attributes for update targeting), DOM/update generators, code builder, and the original assignment interceptor.

## Test status

The suite stands at 304 passing tests (compiler, generator, build, dev server, and runtime) as of 2026-09-06, with one pre-existing failure: `build.test.js`'s "rejects colliding page routes" writes `Home.wizz` and `home.wizz` into the same directory, which cannot coexist on a case-insensitive filesystem such as default macOS, so the collision never materializes there. Run it with:

```bash
node --test "src/**/*.test.js" build.test.js "test/**/*.test.js"
```

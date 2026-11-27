# Wizz

Wizz is a zero-dependency component compiler. It turns `.wizz` component source into a browser ES module that mounts and updates DOM using platform-native APIs.

## Requirements

- Node.js 22 or newer
- A modern browser for running generated modules

Wizz has no runtime dependencies.

## Get Started

Clone the repository, enter it, and run the test suite:

```bash
git clone <repository-url> wizz
cd wizz
node --test
```

To start a new application project, install the CLI (see the next section) and scaffold the canonical starter:

```bash
wizz init my-app
cd my-app
wizz dev
```

Before writing anything, `wizz init` asks `Bootstrap with sample code? [Y/n]` on stderr. Enter, `y`, or `yes` (any case) chooses the full sample project described below; `n` or `no` chooses the bare template; anything else asks again, and Ctrl+C (exit 130) or end of input (exit 1) aborts with no files written. The bare template writes only the canonical shape — `index.html` with no stylesheet link, a placeholder `src/App.wizz` served at `/`, and a `README.md` describing that layout — with no `App.css`, components, pages, or API handler; it builds and serves with no warnings. `--sample` and `--bare` answer the question up front for scripting (mutually exclusive, each at most once). The question is never asked when stdin is not a TTY (CI, pipes) or `--json` is passed: init then uses the sample, so scripted `wizz init` calls behave exactly as before.

The sample project is the showcase starter: the global design-token stylesheet (`App.css`) linked from the document shell, a landing page at `/` with the reactive document head, a counter whose count persists across reloads and tabs, and the animated terminal card — plus a `/home` page that server-renders and hydrates. The scaffold also carries a `README.md` documenting the project layout, the dev/build commands, and how to install the VS Code extension from a release. It is a project that runs correctly with no manual editing. `wizz init` refuses to write into a non-empty directory unless you pass `--force`, and it never overwrites an existing file.

### Your project and the framework

A Wizz project contains only source files. The framework is not vendored into the project: the compiler, runtime, and CLI live in the managed install (`${XDG_DATA_HOME:-~/.local/share}/wizz`), and the `wizz` command loads them from there.

You edit only `index.html`, `App.css`, and `src/**/*.wizz`. Everything else is generated: `wizz dev` and `wizz build` write `dist/` containing the compiled component modules, a copy of the runtime (`dist/runtime/`), and the extracted `wizz.css`. Treat `dist/` as disposable build output — browsers never see the compiler, and the generated `dist/` is self-contained for deployment.

To upgrade the installed framework after a new release, run `wizz update` (or re-run the installer; the install is a snapshot, not a link to any repository).

## Template Language at a Glance

The `.wizz` template language is deliberately small. Read this table before designing a component: rows that fail as **Silent** compile cleanly but do not update the DOM the way JavaScript habits suggest, so they surface late. Each row names the pattern that works today. The same table is served to agents by the MCP server's `language_contract` and `project_overview` tools (see [MCP Server](#mcp-server)); the parser's full grammar is in [`src/compiler/parser/README.md`](src/compiler/parser/README.md#supported-language-surface).

| Area | Supported | Current limit | How it fails | Working pattern |
| --- | --- | --- | --- | --- |
| Expressions `{...}` | Identifiers, member access (`a.b`), number (`1`, `1.5`), string, `true`/`false`/`null` literals, `+ - * /`, `=== !== < > <= >=`, `&&`/`\|\|`, unary `!`/`-`, the conditional `a ? b : c`, calls of a function or method (`plural(n)`, `name.trim()`), and parentheses. | No indexing (`a[0]`), `==`/`!=`, `??`, `?.`, `++`/`--`, template literals, array/object literals, arrow functions, or calling a call result (`f()()`). A call updates only when a reactive name it is given changes: a function reading state internally is not tracked. `eval`, `Function`, `constructor`, `__proto__`, and the timers cannot appear in an expression that calls. | Excluded forms: compile error (WIZZ-P033); state read inside a called function: silent | Pass the state a function needs as arguments: `{plural(entries.length)}`, not `{plural()}`. For anything outside the grammar, compute the value in a script handler into a reactive `let` and render `{label}`. |
| `{#if}` | `{#if cond}...{:else}...{/if}`, nesting, events, lists, and components inside branches. The test is re-evaluated whenever a reactive `let` or prop it reads changes, and the branch is replaced: the old one leaves the DOM with its listeners and child components, and the new one is built from current state. | No `{:else if}`. A test that reads only `const` values is evaluated once, at mount. A replaced branch is rebuilt, so DOM state inside it (typed input text, scroll position, a child component's own state) is not kept. | `{:else if}`: compile error (WIZZ-P033); `const` test and lost branch state: silent | Chain conditions by nesting `{#if}` inside `{:else}`. Keep state that must survive a hidden branch in a script `let`, or keep the element mounted and toggle it with `hidden={flag}`. |
| `{#each}` collection | A bare identifier naming a top-level `let` array, keyed `(item.id)` or keyless. | No member collections (`state.items`) or index alias (`item, i`). A `const` collection renders once. An in-place method (`items.push(x)`) changes the array without an update until the name is assigned. | Syntax: WIZZ-P002; `const`: silent; an in-place call with no later assignment in its function: warning WIZZ-G027 | Assign after mutating, `items.push(x); items = items;` (the assignment is the trigger, not a new reference; in-place-changed items re-render too), or assign a copy: `items = [...items, x]`. Store any index or flag you need on the items themselves. |
| `{#each}` body | Exactly one root per item: a native element or a component tag (`<TodoItem todo={todo} />`), and components anywhere inside the item element. Text, dynamic attributes, and component props update when the collection is assigned. Each row gets its own component instance: it mounts with the item, is destroyed with it, and keeps its own state when a keyed item moves (keyless rows reuse instances by position). `on:` handlers anywhere in the item run with the item variable in scope (`on:click={() => remove(item.id)}`); they attach per item and detach when the item is removed. | No nested `{#if}`/`{#each}` (WIZZ-G005); one root only (WIZZ-G003); the block must sit inside a native element. A row re-renders only when the collection is assigned, so a row prop or text that reads other state (`selected={current}`) keeps its old value until then. A handler expression is evaluated once per item, so `on:click={makeHandler(item)}` keeps the handler built from the item's first value. | Compile error; a stale `makeHandler(item)` or outer-state read: silent | Write per-row handlers as inline arrows, which read the item when they run: `on:click={() => pick(item.id)}`. Pass row components the item and a stable callback (`<TodoItem todo={todo} onRemove={remove} />`, the child calls `onRemove(todo.id)`): a prop arrow built per item (`onRemove={() => remove(todo.id)}`) is a new value on every list update and re-renders its row. Put per-row flags and variants (`selected`, a class suffix) on the items themselves. |
| Dynamic attributes | `name={expr}` updates reactively; `value`, `checked`, and `disabled` are set as DOM properties. HTML boolean attributes (`hidden`, `required`, `readonly`, `open`, `inert`, `multiple`, ...) are present when the value is truthy and removed when it is falsy, so `hidden={false}` shows the element. Any other attribute is removed when the value is `null` or `undefined`. | Outside the boolean list, `false` renders the string `"false"` rather than removing the attribute, because `aria-*`, `draggable`, and `spellcheck` give `"false"` its own meaning. | Silent | Hold `null` in state to drop a non-boolean attribute (`let tip = null;` with `title={tip}`). |
| Quoted attribute values | Static text: `class="card"`. | Braces inside quotes are not interpolated, so `class="card {kind}"` is rejected instead of rendering literal text. Braces that hold no expression (`data-x='{"a":1}'`) stay literal. | Compile error (WIZZ-P055) | Use one expression for the whole value: `class={'card ' + kind}`. |
| Event handlers | `on:<event>={handler}` with a named script function or an inline arrow; assignments inside inline arrows update the DOM, parenthesized or not (`on:input={(e) => (name = e.target.value)}`). | An assignment nested inside an expression (`ok ? a = 1 : 0`, `g(a = 1)`, an unbraced `if (x) a = 1`), in a handler or in the script, does not schedule an update. | Compiles with warning WIZZ-G026 (build output, MCP diagnostics, `compile().warnings`) | Write each mutation as its own statement (`a = 1; g(a);`, `if (x) { a = 1; }`), or move the logic into a named function. |
| Bindings | `bind:value={name}` on `<input>`, `<textarea>`, and `<select>`, and `bind:checked={done}` on `<input type="checkbox">`, two-way with a top-level `let` (persistent state included). `type="number"`/`"range"` inputs bind numbers, with an empty field as `null`. | No `bind:group`, `bind:this`, or other properties; no member targets (`user.name`), props, or `const`s; not on component tags or inside `{#each}` bodies; a bound `<input>` needs a static `type`; no explicit `value`/`checked` beside the binding. | Compile error (WIZZ-P062, WIZZ-P063, WIZZ-P064) | Pair `value={...}` with an `on:input` handler for anything a binding does not cover, such as a per-row field: `on:input={(e) => rename(item.id, e.target.value)}`. |
| Component tags | Default `.wizz` imports rendered self-closing inside a native element or as an `{#each}` item (`<Card title={t} />`); attributes, including functions, pass as props. | No children (WIZZ-G008), no `on:` directives (WIZZ-G011), not at the template root (WIZZ-G010). | Compile error | Pass callbacks as props (`onSelect={select}`) instead of `on:`. Wrap content in a native element inside the child instead of passing it as children. |

## CLI

Wizz installs without npm or a package registry. A first-time install needs only Node.js 22+, curl, and tar — one command fetches the installer from the repository and runs it:

```bash
curl -fsSL https://raw.githubusercontent.com/duncantidd/wizz.js/main/scripts/install-cli.sh | bash
```

The installer resolves the latest GitHub release, downloads its `wizz-<version>.tgz` asset — the release tarball carries the whole CLI: the compiler, runtime, `wizz init` templates, and build tooling — and installs it. To install the latest release from a cloned repository instead, run the same installer from the checkout:

```bash
./scripts/install-cli.sh
```

A specific tarball can be passed as a path or URL. To install from the working tree — the usual path when developing Wizz itself — pass `--local`:

```bash
./scripts/install-cli.sh --local
```

Every release page also carries the first-party VS Code extension as `wizz-vscode-<version>.vsix`. With the CLI installed, one command downloads the latest release's extension package and installs it through the `code` command:

```bash
wizz install-vscode-extension
```

Without the `wizz` CLI (or without `code` on PATH), download the `.vsix` from the release page and run `code --install-extension wizz-vscode-<version>.vsix`, or use VS Code's **Install from VSIX...**; see [`vscode-extension/README.md`](vscode-extension/README.md) for what it provides.

The installer requires Node.js 22 or newer. It installs the compiler and CLI runtime to `${XDG_DATA_HOME:-~/.local/share}/wizz` and places the `wizz` launcher in `${XDG_BIN_HOME:-~/.local/bin}`. It does not require administrator privileges or modify shell configuration files.

Ensure the launcher directory is on your `PATH`. For Bash or Zsh using the default location, add this to your shell profile, then open a new shell:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

The installed `wizz` command is a copy, not a live link to the source. Run `wizz update` to fetch the latest release and swap it into the managed directory in place — the old installation is kept aside until the new one is in place, and the launcher keeps working without changes. Re-running the installer does the same from a terminal without the CLI. When developing Wizz itself, install the working tree with `--local` after pulling updates that change the compiler, runtime, build script, or CLI scripts; otherwise `wizz build` and `wizz dev` continue using the previously installed copy. Source-only `.wizz` component changes do not require reinstalling. To remove the managed installation, delete the launcher and installed runtime:

```bash
rm -f "${XDG_BIN_HOME:-$HOME/.local/bin}/wizz"
rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/wizz"
```

Build a project with its conventional source and output directories:

```bash
wizz build
```

This compiles `src` into `dist`. To choose both directories explicitly, pass both arguments:

```bash
wizz build components public
```

Add `--json` (in any argument position) to print a machine-parsable diagnostics envelope to stdout instead of the per-file prose — for editor and CI integrations:

```json
{
  "format": "wizz-build-diagnostics@1",
  "ok": false,
  "diagnostics": [
    {
      "code": "WIZZ-P018",
      "severity": "error",
      "message": "Mismatched closing tag. Expected </p>, found </main> at Broken.wizz:1:16.",
      "file": "Broken.wizz",
      "line": 1,
      "column": 16
    }
  ],
  "files": [{ "file": "App.wizz", "serverRenderable": true }]
}
```

Every compiler diagnostic carries a stable code (`WIZZ-P###` for parse-stage failures, `WIZZ-G###` for generate-stage failures) that tooling can switch on without parsing prose; the envelope's `format` field is versioned, so fields may be added within format version 1 but existing fields keep their meaning until it changes. When an adapter runs, the envelope additionally carries `adapter: "node"` — the field is absent for static builds, so existing consumers parse an unchanged envelope.

### Compact production builds

`wizz build --compact` (in any argument position, at most once) shrinks everything the build emits for production deployment: the generated client, `.server.js`, and `.hydrate.js` modules, the copied `dist/runtime/**` and both manifests, `wizz.css` and the copied `App.css`, `dist/index.html`, and — with `--adapter node` — `dist/server.mjs`. The compactor is hand-rolled and conservative: it removes comments and insignificant whitespace and nothing else, with no identifier mangling or other rewrites, so the compacted `dist/` behaves exactly like a normal build. Strings, template literals, regex literals, and line breaks that automatic semicolon insertion depends on survive unchanged; in CSS, strings, `url(...)`, escapes, and whitespace that is a descendant combinator are kept; in HTML, tags and the contents of `<pre>`, `<textarea>`, `<script>` (including the `application/wizz-state` payload), and `<style>` are copied byte for byte. Authored API handlers under `dist/server/**` stay verbatim copies.

A compact build writes no source maps and no `//# sourceMappingURL` comments (and removes maps an earlier readable build left in `dist/`): compaction moves every position a map describes, and a public production map hands out the original source. A normal `wizz build` keeps its maps, so debugging stays a rebuild away. A source the compactor cannot read safely — an unterminated string or comment in a `<script>` or `<wizz:style>` block, `App.css`, or `index.html` — fails the build with its file, line, and column instead of emitting corrupted output. With `--json` the envelope additionally carries `compact: true`.

```bash
wizz build --compact
wizz build --adapter node --compact --json
```

### Deploying with the node adapter

`wizz build --adapter node` (in any argument position, `--adapter node` or `--adapter=node`) generates a standalone SSR + API host at `dist/server.mjs` — build-only, opt-in; a plain `wizz build` emits nothing extra, and `wizz dev` gains nothing (it implements the same protocol itself). The host is self-contained: it imports only Node builtins and the build's own artifacts, so the deployment contract stays "dist/ is self-contained". Deploy the `dist/` directory and run:

```bash
node dist/server.mjs             # from the project root; serves http://localhost:8080
PORT=3000 node dist/server.mjs   # or any port via PORT (0-65535, validated)
```

The host resolves `dist` from its own file location, so `node server.mjs` also works when run from inside the `dist/` directory.

The host serves traversal-guarded static files from `dist/` (encoded dots, backslashes, drive letters, double slashes, and NUL bytes resolve inside the containment check, and a symlink inside `dist/` pointing outside cannot be streamed — every served file's canonical path is re-checked against the canonical `dist/` before any bytes leave), server-renders the routes listed in `dist/runtime/routes.js` (exact pathname match, mirroring the client router, with the state script delivered as a sibling of the mount point and the head wrapped in `<!--wizz:head-start-->…<!--wizz:head-end-->`), runs the API handlers listed in `dist/runtime/apiRoutes.js` at `/api/**` behind the same frozen request context and return shapes as `wizz dev`, answers unmatched API paths with 404 JSON (never the SPA shell), falls back to the document shell for every other extensionless path, and never serves `/server/**` as static files — handler source and private `_` modules are unreachable. Secrets load from a `.env.server` in the directory the host is started in (real environment values are never overridden); deployment platforms normally provide environment variables directly. This is still not an application server: no sessions, persistence, or middleware — production application hosting remains external to the framework. Platform-specific adapters (Vercel, Cloudflare Workers, Lambda) are not part of the framework; each would reshape the same platform-neutral `dist/` artifact for one host, and none ship today.

Start the development server with:

```bash
wizz dev [--port <n>] [--host <addr>]
```

`wizz dev` uses the directory where you run the command as the application project: it builds that directory's `src` into `dist`, serves the result at `http://127.0.0.1:3000` (or the specified `--port`), and watches `.wizz` source files. It uses native file events with a 250 ms polling fallback, so changes on mounted filesystems such as WSL's `/mnt/c` still rebuild when an event is missed. Rebuilds update `dist` and automatically trigger live reloading in connected browser tabs via a dev-only Server-Sent Events (SSE) channel (`/_wizz/reload`). If the requested port is already in use, `wizz dev` fails cleanly with an error message naming the port and the `--port` flag.

The server binds to `127.0.0.1` (loopback) by default: it has no authentication or TLS, serves compiled source, executes `/api/**` handlers in-process with `.env.server` secrets loaded, and exposes the reload channel — so binding every interface would expose all of that to the local network. `HOST=<addr>` in the environment, or `--host <addr>` on the command line (which outranks the environment), opts a bind out of loopback for the rare remote-development case; loopback remains the default otherwise.

Print what you have installed with:

```bash
wizz --version
```

which prints the compiler and contract version triple, for example `wizz 1.27.0 (compiler 1.27.0, syntax 1.7.0, output 1.14.0)`. The public CLI accepts `init`, `build`, `dev`, `mcp`, `update`, `install-vscode-extension`, and `--version`; `init` accepts an optional directory plus `--force` and one of `--sample`/`--bare`, `build` accepts either no directory arguments or both an input and an output directory, plus the optional `--json`, `--adapter <name>`, and `--compact` flags, `dev` accepts optional `--port <n>` and `--host <addr>`, and `mcp` accepts optional `--root <dir>` and `--allow-write`.

`wizz dev` requires an `index.html` document shell in the project directory. It validates that requirement before opening the server, so a missing shell reports an error and exits instead of failing later while handling a request. Build failures and invalid command usage also exit non-zero.

### MCP Server

`wizz mcp` exposes Wizz tooling to AI agents over the Model Context Protocol — a zero-dependency, hand-rolled JSON-RPC 2.0 session on stdio (newline-delimited messages per the 2025-06-18 spec). Register it with any MCP client as a stdio server:

```json
{
  "command": "wizz",
  "args": ["mcp", "--root", "/path/to/project", "--allow-write"]
}
```

The server exposes six tools:

| Tool | What it does |
| --- | --- |
| `project_overview` | Surveys the application: components and routes, server API routes, document shell, build output, adapters, the version triple, and the [template language limits](#template-language-at-a-glance) (text and structured `templateLimits`). |
| `component_diagnostics` | Compiles a component — a project file, inline source, or every component — into structured `WIZZ-P###`/`WIZZ-G###` diagnostic records without writing anything. |
| `build_project` | Runs the build in-process and returns the machine-readable `wizz-build-diagnostics@1` envelope. |
| `language_contract` | The `.wizz` component language contract: file structure, reactive state and props, directives, imports, the version triple, the diagnostic-code catalog, and the template-limits table with working patterns (also structured as `templateLimits`). |
| `dev_workflow` | The development and deployment workflow: `wizz dev`, `wizz build`, the node adapter deploy recipe, API routes, and `.env.server`. |
| `create_or_update_component` | Creates or updates a `.wizz` component inside the project, compile-gated. |

The security posture is deliberate. The project root is fixed at startup — `--root <dir>`, default the directory where the server was started — and an agent can never change it over the wire: every path a tool touches is refused if it escapes the root, lexically and through the real filesystem, so symlinks cannot smuggle a read or write out. Component writes require the explicit `--allow-write` startup opt-in; without it, the write tool refuses with guidance. With it, writes still pass a hard gate before anything touches the disk: targets must be `.wizz` files outside the managed trees (`dist/`, `node_modules/`, `.git/`, `release/`, `vscode-extension/`), sources cap at 256 KiB, and the proposed source is compiled first — a source that does not compile is refused with the diagnostic records echoed and the target left byte-identical. The write itself is race-hardened: because the containment checks and the write are not atomic, the target is opened with `O_NOFOLLOW` and its parent directory is re-verified against its realpath immediately before and after the open, so a local attacker racing the tool cannot redirect the write through an ancestor symlink planted after the checks. Every compile of agent- or project-supplied source — the write gate, inline `component_diagnostics` input, and each file in `all`/`path` diagnostics — enforces the same 256 KiB cap, and the parser stages carry depth budgets (WIZZ-P053/WIZZ-P054) that turn pathological nesting into located diagnostics instead of stack overflows. Agent input is treated as untrusted end to end: `__proto__` keys are stripped at parse time, message lines cap at 2 MiB, and stdout carries protocol messages only (logs go to stderr), so nothing an agent does can corrupt its own stream or reach outside the project.

### CLI Stability

The installed `wizz` command is Wizz's public command-line interface. Its supported commands are `wizz init [directory] [--force] [--sample | --bare]`, `wizz build`, `wizz build <input-directory> <output-directory>`, `wizz build --json`, `wizz build --adapter node`, `wizz build --compact`, `wizz dev`, `wizz mcp [--root <dir>] [--allow-write]`, `wizz update`, `wizz install-vscode-extension`, and `wizz --version`; their documented defaults, generated output paths, and non-zero failure behavior are stable within a CLI major version.

`build.js`, `scripts/cli.js`, and `scripts/dev.js` are implementation entry points used by the repository and may change as the CLI evolves. Use `wizz` for application automation and development workflows.

## Create a Component

A component has a template and an optional `<script>` block. `let` declarations are reactive; expressions in the template update when an event handler changes their reactive state.

```wizz
<script>
  let count = 0;

  function increment() {
    count += 1;
  }
</script>

<main>
  <button on:click={increment}>Clicks: {count}</button>
</main>
```

Save it as `Counter.wizz`.

Event directives use native browser event names and accept either a component-local handler or an expression that receives the event:

```wizz
<button on:click={(event) => increment(event.detail)}>Add</button>
```

The directive expression is emitted as the listener passed to `addEventListener()`. Assignments inside an inline handler are reactive exactly like those in script functions, with or without parentheses around the body:

```wizz
<input value={name} on:input={(event) => (name = event.target.value)} />
```

An inline handler cannot assign a prop (props are read-only; this is the same `WIZZ-G015` error as in the script). An assignment nested inside an expression — `ok ? count = 1 : 0`, `log(count = 1)` — does not schedule an update, and the compiler reports it as warning `WIZZ-G026` (see [Compiler Warnings](#compiler-warnings)); write it as its own statement.

### Two-Way Bindings

`bind:value` and `bind:checked` keep a form control and a top-level `let` in sync in both directions:

```wizz
<script>
  let food = '';
  let calories = 0;
  let logged = false;
  let meal = 'lunch';
</script>

<form>
  <input bind:value={food} />
  <input type="number" bind:value={calories} />
  <input type="checkbox" bind:checked={logged} />
  <select bind:value={meal}>
    <option value="lunch">Lunch</option>
    <option value="dinner">Dinner</option>
  </select>
  <p>{food}: {calories} kcal{logged ? ' (logged)' : ''}</p>
</form>
```

A binding is shorthand for the pair you would write by hand: `bind:value={food}` compiles to `value={food}` plus an `on:input` handler that assigns `food` (`on:change` for `<select>` and checkboxes), so it updates the DOM, works inside `{#if}` branches, server-renders the current value, hydrates, and writes persistent (`persist()`) state through to storage like any other assignment.

- `bind:value` works on `<input>` (any type but `checkbox`, `radio`, and `file`), `<textarea>`, and `<select>`; `bind:checked` works on `<input type="checkbox">`.
- `type="number"` and `type="range"` inputs bind numbers, and an empty field binds `null`. While someone is half-way through typing a number (`1.`, `-`), the field is left alone rather than overwritten. A bound `<input>` needs a static `type`.
- The target must be a top-level `let` named directly. Props are read-only, so binding one is an error; copy it into a local `let` instead.
- Bindings are not supported on imported component tags, inside `{#each}` bodies (an item re-renders only when its collection changes, so the control would not follow the state), or for `bind:group`, `bind:this`, and other properties. Each is a compile error (`WIZZ-P062`–`WIZZ-P064`), never a silent no-op; use `value={...}` with an `on:input` handler there.
- A server-rendered `<textarea>` or `<select>` shows its bound value once the client has hydrated: the server writes `value` as an attribute, which those two elements do not display.

Reactive updates are batched. When a handler runs, each changed variable is marked, and one DOM update runs on the next microtask with all marks combined — a handler that changes several variables triggers a single update, and the DOM settles before the browser paints. Updates therefore happen asynchronously: read the DOM after an `await`, not synchronously after dispatching an event.

### Arrays and objects

Assignment is the trigger. Every statement-level assignment to a reactive `let` schedules an update, with no check of whether the value or reference changed, so there are two equally supported ways to change an array:

```wizz
<script>
  let items = [];

  function addCopy(x) {
    items = [...items, x];      // assign a new array
  }

  function addInPlace(x) {
    items.push(x);
    items = items;              // mutate, then assign the same array
  }
</script>

<p>{items.length} items</p>
```

The self-assignment `items = items` is not a no-op: the assignment, not the new reference, is what tells Wizz to re-render. A bare `items.push(x)` with no assignment changes the array but schedules nothing, so the DOM keeps showing the old list. The compiler reports that case as warning [`WIZZ-G027`](#compiler-warnings).

Writes through a member also count, and schedule the update for the root name: `user.name = "Ada";`, `items[0] = "first";`, and `items.length = 0;` each re-render whatever reads `user` or `items`. When a list re-renders, both keyed and keyless `{#each}` blocks run every item's update, so an item object changed in place (`rows[1].name = "Cy"; rows = rows;`) shows its new values without being recreated.

Deliberately, Wizz has no deep reactivity (no proxies) and does not instrument array methods: assignment stays the single trigger, which keeps generated code small and predictable. Props are a separate boundary: a parent passing the same reference again is skipped by an `Object.is` check in the child's `setProps`, and props are read-only in the child.

Dynamic attributes use brace-delimited expressions. Wizz updates `value`, `checked`, and `disabled` as DOM properties; all other dynamic names are updated as HTML attributes:

```wizz
<input value={name} checked={isSelected} aria-label={name} />
```

HTML boolean attributes such as `hidden`, `required`, `readonly`, `open`, `inert`, and `multiple` follow presence semantics: a truthy value adds the attribute, a falsy value (`false`, `0`, `''`, `null`, `undefined`) removes it, so `<p hidden={isValid}>` shows the paragraph when `isValid` is `false`. Any other dynamic attribute is removed when its value is `null` or `undefined` and otherwise set to `String(value)`; `false` deliberately renders `"false"` so `aria-expanded={open}` keeps working. Server rendering and hydration follow the same rules.

## Lists

Render a collection with an `each` block. Give each item a unique key when node identity should follow the item — for example when rows reorder:

```wizz
<script>
  let items = [{ id: 1, name: 'Ada' }];
</script>

<ul>
  {#each items as item (item.id)}
    <li>{item.name}</li>
  {/each}
</ul>
```

When `items` is assigned (a new array, or `items = items` after changing it in place; see [Arrays and objects](#arrays-and-objects)), Wizz retains nodes with matching keys, moves retained nodes into the new order, updates their text and dynamic attributes, creates new keys, and removes missing keys. Duplicate keys throw at runtime.

For arrays of primitives, or any collection where positional identity is enough, omit the key:

```wizz
<script>
  let list = ['item1', 'item2'];
</script>

<ul>
  {#each list as item}
    <li>{item}</li>
  {/each}
</ul>
```

A keyless block reconciles by array index: on reassignment each rendered row updates in place with the item now at its position, rows are appended as the collection grows, and rows beyond the new length are removed. Rows are reused by position, not by item identity.

In both forms the collection must be a reactive `let` for updates to run (a `const` collection renders once at mount), the block must be nested inside a native element, and the body must contain exactly one root: a native element or an imported component tag. Each blocks do not support nested `if`/`each` blocks inside the repeated content yet; that is a compile-time error rather than silently ignored. A row re-renders only when the collection is assigned, so text or a prop in the row that reads other state keeps its old value until the next assignment — put per-row values on the items.

Event directives work anywhere inside the repeated content, and their handlers see the item variable:

```wizz
<script>
  let entries = [{ id: 1, name: 'Egg' }];

  function remove(id) {
    entries = entries.filter((entry) => entry.id !== id);
  }
</script>

<ul>
  {#each entries as entry (entry.id)}
    <li>{entry.name} <button on:click={() => remove(entry.id)}>Delete</button></li>
  {/each}
</ul>
```

Each rendered item gets its own listeners; they are attached when the item is created and removed when the item leaves the list (or the component is destroyed). An inline arrow reads the item when it runs, so it always sees the item's current value — including after a keyed item is replaced by a new object. The handler expression itself is evaluated once per item, so prefer `on:click={() => pick(item.id)}` over `on:click={makeHandler(item)}`, which would keep the handler built from the item's first value.

### Row components

An imported component can render each row, either as the item's root or anywhere inside the item element:

```wizz
<script>
  import TodoItem from './TodoItem.wizz';

  let todos = [{ id: 1, text: 'Write docs', done: false }];

  function remove(id) {
    todos = todos.filter((todo) => todo.id !== id);
  }
</script>

<ul>
  {#each todos as todo (todo.id)}
    <TodoItem todo={todo} onRemove={remove} />
  {/each}
</ul>
```

Every row owns its own instance. It mounts when its item is created, receives new props through `setProps()` whenever the list updates, and is destroyed (hooks, listeners, and its own children included) when its item leaves the list, when a branch holding the list is replaced, or when the parent is destroyed. In a keyed block the instance moves with its item and keeps its internal state; a keyless block reuses instances by position, so position 0 keeps its instance (and that instance's state) while showing whichever item is now first. Props are compared with `Object.is`, so a row whose props did not change does not re-render. That makes stable callbacks matter: pass the item and a named function (`onRemove={remove}`, with the child calling `onRemove(todo.id)`) rather than an arrow built per row (`onRemove={() => remove(todo.id)}`), which is a new value on every list update and re-renders every row. Server rendering renders each row through the child's server module, and hydration adopts every row's child in place; a mismatch inside one row remounts only inside that row.

## Conditional Rendering

Render content conditionally with an `if` block and optional `else` branch:

```wizz
{#if section === 'About'}
  <p>The counter is available.</p>
{:else}
  <p>Unknown section.</p>
{/if}
```

Conditions use the same expression grammar as interpolations: comparisons (`=== !== < > <= >=`), `&&`/`||`, `!`, the conditional operator, and calls such as `{#if items.length > 0 && !busy}`.

An `if` block is reactive: when a reactive `let` or prop its condition reads changes, the condition is re-evaluated and, if the result flips, the rendered branch is replaced in place.

```wizz
<script>
  let error = '';

  function validate(event) {
    error = event.target.value === '' ? 'Please enter a food name.' : '';
  }
</script>

<form>
  <input on:input={validate} />
  {#if error}
    <p class="error">{error}</p>
  {/if}
</form>
```

Replacing a branch removes its nodes from the DOM, detaches the event listeners inside it, and destroys any imported components it rendered; the new branch is built from the current state. Because the branch is rebuilt rather than hidden, DOM state inside it (text typed into an input, scroll position, a child component's own state) does not survive being hidden — keep such state in a script `let`, or keep the element mounted and toggle it with `hidden={flag}`. A condition that reads only `const` values never changes, so it is evaluated once at mount.

## Lifecycle Hooks

`onMount` and `onDestroy` are available inside the component script — no import is needed; the compiled component provides them. Register them at the top level of the script:

```wizz
<script>
  let status = "connecting";

  function initialize() {
    status = "ready";
  }

  onMount(initialize);
</script>

<main><p>{status}</p></main>
```

`onMount` runs once, after the component is attached to its target, child components are mounted, and the initial update has completed. State assigned in a mount hook flows through the batched scheduler, so the example above renders `ready` on the next microtask. `onDestroy` runs when the component's `destroy()` is called, before child components are destroyed and the root node is removed — the right place to remove global event listeners or clear timers.

For reactive state changes from a hook, both styles notify the scheduler: `onMount(() => { status = "ready"; })` and `onMount(initialize)` (where `initialize` assigns at statement level) are intercepted by the syntax-aware script rewriter, which follows mutations into function and arrow callback bodies. Assignments in expression position — call arguments, conditions, object literals, template interpolations — and unbraced control-flow bodies are deliberately left unrewritten, and the compiler reports each one as warning `WIZZ-G026`.

Calling `destroy()` tears the component down completely: destroy hooks run first, child components are destroyed, every event listener Wizz attached through an `on:` directive is removed from its node, and the root is removed from the target. Listeners you attach yourself — for example to `window` or `document` inside `onMount` — are not tracked, so remove them in `onDestroy`.

## Compile Components

Place components below an input directory, then compile the whole directory into a separate output directory:

```text
src/
  App.wizz
  pages/
    Home.wizz
```

```bash
wizz build
```

The same build can be run directly without the package command:

```bash
node build.js src dist
```

Wizz recursively compiles every `.wizz` file and preserves its path below the output directory:

```text
src/App.wizz         -> dist/App.js
src/pages/Home.wizz  -> dist/pages/Home.js
```

The output directory is created when needed. It must be different from the input directory. Wizz continues compiling independent components after an error, reports each failed file and its source location, and exits with a non-zero status if any component fails. The build also writes `package.json` (`{"type":"module"}`) into the output directory unless one is already present, so Node-side imports of the emitted modules — the dev server's SSR imports, and application servers following the SSR recipe — work on every supported runtime.

## Application Entry

The input directory must contain `App.wizz`. The build emits `dist/App.js` and copies Wizz's browser entry module to `dist/runtime/main.js`. That entry imports `App.js`, finds the `#app` mount target, and mounts the component.

`dist/` is served as the web root by `wizz dev`, the node adapter, and static hosting of the build, so keep the document shell responsible only for the mount element and loading `/runtime/main.js`:

```html
<div id="app"></div>
<script type="module" src="/runtime/main.js"></script>
```

If the document does not contain `<div id="app"></div>`, the entry module reports `Wizz could not find mount target "#app".`

## Routing

Routes are generated during every build from `src/App.wizz` and `.wizz` files below `src/pages`; do not edit `src/runtime/main.js` to add a route. The build writes `dist/runtime/routes.js`, and the runtime creates lazy route loaders from that manifest.

```text
src/App.wizz                 -> /
src/pages/index.wizz         -> /
src/pages/Home.wizz          -> /home
src/pages/Admin/Users.wizz   -> /admin/users
src/pages/Docs/index.wizz    -> /docs
```

Route paths are lowercased. `App.wizz` and `pages/index.wizz` both claim `/`, so a project may contain only one of them. A build also rejects duplicate normalized paths and any page path beginning with `/runtime` or `/server` — reserved for Wizz runtime files and for server handler output (a page routed there would be silently unreachable in development SSR). Errors identify the conflicting component paths.

The router loads only the component matching `window.location.pathname`, destroys the previously mounted component before each replacement, and renders `Not found` for unmatched paths. Adding, renaming, nesting, or removing a page takes effect after the next `wizz build` or rebuild from `wizz dev`; a removed page is no longer present in the generated route manifest even if an older compiled module remains in `dist`.

The router also exposes `navigate(pathname)`, which updates browser history with `pushState()` and rerenders. Browser Back and Forward navigation rerenders through the `popstate` listener.

## Nested Components

Import another Wizz component with a default `.wizz` import and render it with a self-closing tag:

```wizz
<script>
  import Counter from './components/Counter.wizz';
</script>

<main>
  <Counter />
</main>
```

The build rewrites the import to `./components/Counter.js`, which follows the output-path mapping. Imported component tags must be nested inside a native element and cannot receive children or event directives. Destroying the parent component also destroys all imported child components.

### Props

The child declares its inputs with `export let` declarations; a bare declaration defaults to `undefined`:

```wizz
<script>
  export let name = 'Guest';
  export let count;
</script>

<p>Hello {name}, clicked {count} times</p>
```

The parent passes props as attributes on the component tag. Static attributes pass their string, bare attributes pass `true`, and dynamic attributes pass the expression — evaluated at mount and again whenever its reactive dependencies change:

```wizz
<script>
  import Greeting from './components/Greeting.wizz';
  let clicks = 0;
</script>

<main>
  <Greeting name="Ada" count={clicks} emphasized />
</main>
```

When `clicks` changes, the parent delivers the new value through the child instance's `setProps()` and the child rerenders in place — it is never remounted, so its DOM identity and internal state are preserved. Props are reactive inside the child exactly like `let` state. They are read-only: assigning to a prop in the child script is a compile-time error. A prop the parent does not pass keeps its declared default, and passing `undefined` explicitly restores that default. Attributes the child never declared are ignored.

Serve the directory over HTTP when loading browser ES modules, for example:

```bash
wizz dev --port 4321
```

The development command builds `src` into `dist`, copies `index.html` and `App.css` into the output directory, serves it at `http://localhost:3000` (or the specified `--port`), and watches `.wizz` files for changes. It reports compiler errors while keeping the server available for subsequent fixes, and automatically reloads open browser tabs when a rebuild completes.

Requests for browser routes such as `http://localhost:3000/Home` receive the document shell, allowing the client router to select the matching component. Server-renderable routes (see below) instead receive the shell with the rendered markup already inside the mount point plus the serialized state script, and the router hydrates it on first load. Existing output files such as `/runtime/main.js` and `/pages/Home.js` are served directly; missing asset paths return HTTP 404.

## Scoped Component Styles

A component may declare one `<wizz:style>` block holding plain CSS. Every element that component renders carries a generated `data-wizz-s` scope attribute, and each selector's terminal element gains that attribute — so two components can both style an `h2` and keep their own sizes:

```html
<script>
  import Card from './Card.wizz';
</script>

<main>
  <Card />
  <h2>Page heading</h2>
</main>

<wizz:style>
  h2 {
    font-size: 24px;
  }
</wizz:style>
```

The block's contents are raw text: CSS braces, colons, and quotes never reach the template expression lexer, and expressions are not interpolated into CSS — styles are trusted author input like scripts, which sidesteps the injection class entirely. The block is root-level (one per component, no attributes, no nesting), and a plain `<style>` element is rejected with a diagnostic pointing at `<wizz:style>` so the scoping contract stays explicit. An `h2` in the page itself — like the one above — carries no scope attribute and matches no component rule. Document-wide styles (resets, shared tokens) keep living in the document stylesheet as they always have.

Delivery is automatic and never duplicates: `wizz dev` server-renders one `<style>` tag per styled component into the document head (a component imported by several pages injects exactly once per document), hydration adopts the delivered stylesheet instead of recreating it, and client mounts share one refcounted stylesheet per component scope. `wizz build` extracts every component's scoped rules into `dist/wizz.css` — computed with the same scoping pass the generators use, including `@media` descent and scope-suffixed `@keyframes` names, with any `@import` hoisted to the top of the file — and injects `<link rel="stylesheet" href="/wizz.css">` into the copied document shell, so production pages arrive styled from the first paint with zero runtime work. The stylesheet is then the only delivery: client, hydratable, and server modules are compiled without their CSS, so every rule is downloaded once. When nothing links it (no `index.html` was found, or the shell has no `</head>`), modules keep delivering their own styles instead. If you serve built modules from your own document in a project that has a shell, link `/wizz.css` from that document yourself. A shell that still links the old `/app.css` name keeps working: the build rewrites the link and prints a note.

## Persistent Cross-Tab State

A reactive `let` declaration can survive page refreshes and stay reactive across browser tabs by initializing it with `persist(key, default)`:

```html
<script>
  let theme = persist('theme', 'light');

  function toggle() {
    theme = theme === 'light' ? 'dark' : 'light';
  }
</script>

<button on:click={toggle}>Theme: {theme}</button>
```

The variable keeps every reactive behavior it already had — templates read it, mutations rerender, the debugger sees a plain identifier. What `persist()` adds is a storage key: the compiled client reads the key from `localStorage` at mount (the stored value wins over the default), writes every statement mutation back through it, and subscribes the mount to that key on a shared per-page bus. A second component — in the same tab or another — that mounts the same key reads the same value and receives every write, so all instances converge. Delivery between tabs rides `BroadcastChannel` where the browser provides it and falls back to `storage` events where it does not; a tab's own writes never echo back into it. On destroy the subscription is removed, so a destroyed component never updates again. The marker must initialize a top-level `let` declaration — `persist()` inside a function body, block, or another `persist()` default is a compile-time error, because the compiled machinery reads and writes the component's mount-scope variable; binding your own function or variable named `persist` opts out of the marker entirely.

Storage is untrusted input: reads parse defensively (`JSON.parse` failure falls back to the declared default, and stored values replace state wholesale — never merged, so hostile stored objects have no merge vector), and writes are guarded so quota failures or private-mode storage leave the in-memory state intact while the channel keeps peers converged. Keys are author-supplied and used verbatim — components of one origin share one namespace, so two components persisting the same key intentionally share that state.

Two documented behaviors: the server has no storage, so server rendering (and the first paint of hydrated pages) shows the declared default until hydration reads the real value — a theme stored as `dark` flashes `light` on first paint. And keys are never namespaced or validated beyond being string literals, so choosing `'settings'` for two unrelated variables is a collision you can create.

## Server API Routes

Everything in a `.wizz` script compiles to a **browser** ES module — any API key a form `fetch`es with is visible in the network tab, by construction. Code that must stay server-side lives in `src/server/api/*.js`: each file's default export runs inside `wizz dev` when a request hits its route, so third-party API calls and their secrets never reach the browser.

```js
// src/server/api/submit-form.js  →  served at /api/submit-form
export default async function handler(request) {
  const payload = await request.json(); // 400 on malformed input
  const response = await fetch('https://third-party.example/v1/submit', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.THIRD_PARTY_KEY}` },
    body: JSON.stringify(payload)
  });
  return { status: response.status, body: await response.json() };
}
```

The browser (or any client) calls the same-origin `/api/submit-form`; the key lives in a **gitignored `.env.server`** file at the project root (`KEY=VALUE` lines, `#` comments allowed — add it to your `.gitignore`), which the development server loads into `process.env` before the first request. Real environment variables win over file entries. The file is never copied into build output and never appears in any served artifact — the handler reads keys at request time, server-side.

**Routes** mirror pages: `src/server/api/health.js` serves `/api/health`, `index.js` names the directory itself, nested directories nest the path, and everything lowercases. Files and directories starting with `_` are importable helpers, never routable. Duplicate routes fail the build naming both claimants, and the `/api` and `/server` namespaces are reserved — a page named `src/pages/Api.wizz` or `src/pages/Server.wizz` fails the build.

**The request context** is a frozen plain object, so handler code stays runtime-portable (no Node `req`/`res`):

- `method` — `'GET'`, `'POST'`, …
- `path` — the decoded pathname (`'/api/submit-form'`)
- `query` — `URLSearchParams`
- `headers` — lowercased plain object
- `body` — raw body text, or `null` when empty; `await request.json()` parses it (a malformed body answers `400`)

**The return value**: a plain value answers `200` as JSON, a string answers as plain text, `undefined` answers `204`, and `{ status, headers, body }` gives full control. Errors are deliberately one-way: a handler throw (or a module without a default function, or a syntax error) answers a fixed `500 {"error":"Internal server error"}` — the detail goes to the server log only, so an error message quoting a secret never reaches the client. Request bodies are capped at 1 MB (`413` above it).

**Freshness and deployment**: handler edits apply on the next request — no rebuild. Dev runs handlers from their `dist/server/**` copies (the build pins `dist/package.json` to `{"type":"module"}`, so ESM parses on every supported Node — Node 22 before 22.7 has no unflagged module-syntax detection), re-copying any source module newer than its copy before the import, which is cache-busted by the source mtime. A relative import must stay within `src/server/` (only that tree is copied); editing a private `_` module refreshes its copy, but the importing handler re-imports it once the handler file itself changes — touch the handler or restart. `wizz build` copies the whole `src/server/` tree verbatim (private modules included) with a generated manifest (`dist/runtime/apiRoutes.js`) so an external Node host can import and run them following the same recipe as the SSR delivery; the dev server never serves `/server/**` as static files, so handler source is unreachable in both workflows. Production application hosting itself stays outside the framework — Wizz ships no application server, and handlers get no sessions, persistence, or middleware.

## Compatibility and Versioning

Wizz's compatibility contract has three semver versions, defined in `src/compiler/version.js`: the compiler itself, the component syntax contract, and the generated output contract.

As a component author, within one `syntax` major version any component that compiled before keeps compiling with the same meaning. New syntax may be added in a minor version, but existing syntax never changes meaning without a major bump.

As a consumer of generated modules, within one `output` major version every generated module keeps its surface: the `mountComponent(target, props, anchor?)` default export, the returned `{ setProps?, destroy() }` handle (`setProps(next)` exists on components that declare props), and the teardown behavior behind them.

A breaking change to either contract bumps its major version and the compiler's major version. Every compiled module is stamped with all three versions on its first line, so build artifacts stay traceable to the compiler that produced them:

```js
// Generated by Wizz 1.27.0 (component syntax 1.7.0, generated output 1.14.0). Edits will be overwritten.
```

`compile()` also returns the frozen version table as its `version` field.

## Server Rendering and Hydration

Server rendering is an explicit compile target. `compileServer(source, { filePath })` emits an ES module with no DOM dependency (server modules may import other server modules for component rendering, mirroring the client's import structure):

```js
import { renderComponent, serializeInitialState } from './dist/pages/Home.server.js';

const { html, state } = renderComponent(props);
// html: '<section class="panel">…</section>' — escaped, no DOM nodes created
// state: the component's reactive state snapshot

const stateScript = serializeInitialState(state);
// '<script type="application/wizz-state">{"count":0}</script>'
```

Deliver `html` inside the mount point and `stateScript` as a **sibling** of the mount point (never inside it — the hydration traversal counts the mount point's children exactly). Compile the same component for the browser with the `hydratable` option:

```js
const { source } = compile(homeSource, { filePath: 'src/pages/Home.wizz', hydratable: true });
```

The generated module keeps its default `mountComponent(target, props)` export and additionally exports `hydrateComponent(target, props, state)`. Hydration adopts the server-rendered DOM in place — verifying tags, `data-wizz-id` attributes, and text contents against the template AST — attaches event listeners after the walk passes, and drives the usual reactive updates. On any mismatch it emits one `console.warn('[wizz] hydration mismatch: …')`, clears the mount point, and falls back to a full client render, so a failed hydration is always safe.

The server-renderable surface covers everything with a deterministic initial rendering: static markup, text interpolations, dynamic attributes, top-level props, the `{#if}` branch selected at render time (the client replaces it when its condition changes), `{#each}` lists (browser target's body restrictions apply: one root element per item, no components; `on:` directives are client-only and never rendered), and **imported component tags**. A component tag renders by calling the child's own server module, so the surface is defined recursively — a page is server-renderable when its entire component tree is. Child state snapshots serialize under the framework-reserved `__wizz` key (`state.__wizz.components["<componentId>"]`); reactive variable names cannot start with `__wizz`, so the namespace stays framework-owned. Event handlers and lifecycle hooks remain client-only, and author scripts that read browser globals (e.g. `document.location`) are the author's responsibility — the compile gate passes but `renderComponent()` fails at runtime, exactly like any nondeterministic module state in other frameworks. Server output produces no source map.

### Component trees, eligibility, and nested hydration

Because a component tag's renderability depends on the child's own template, the build computes eligibility bottom-up over the import graph: a file ships server and hydratable builds when its own server and hydratable targets compile with every rendered import vouched for by that child's own eligibility. Eligible **component files** emit `<Name>.server.js` and `<Name>.hydrate.js` beside their client module — a page's server module imports its components' server modules, mirroring the client import structure. A page whose child fails the gate stays client-only, and its build note chains the deepest underlying reason:

```
Note: server rendering skipped for src/App.wizz — Server rendering does not support component tags; <Counter> cannot be rendered server-side at src/App.wizz:3:16. Underlying reason: Server rendering does not support component tags; <Ghost> cannot be rendered server-side at src/components/Counter.wizz:3:15. No server-renderable build was provided for this import. Serving the client build only.
```

Hydratable modules export a second entry alongside `hydrateComponent`: **`hydrateRoot(rootNode, props, state)`** adopts the *given* node as the component root (instead of the mount point's first element child). Nested hydration uses it: the parent's adoption walk verifies that the component-tag position holds an element, then adopts the child through the child's own hydratable module, seeding it with the state slice under `__wizz.components`. Reactive prop bindings re-apply to the adopted child through `setProps`, and a structural mismatch at any depth remounts **inside the child's root** — the parent tree is never detached and never fails. The adoption walk re-evaluates the same branch tests the server evaluated against seeded state (a nondeterministic author script can diverge here; the walk then falls back cleanly) and adopts `{#each}` items positionally, rebuilding the records map so client-side list updates mutate the adopted nodes.

### Delivery from the development server

`wizz dev` performs this delivery natively, per route:

- At build time, every server-renderable file additionally emits `<name>.server.js` and `<name>.hydrate.js` beside its client module — pages *and* their imported components, so the recursive rendering can resolve. The generated route manifest advertises both paths for **pages** (`serverModulePath`, `hydratableModulePath`). Eligibility is a build-time artifact: a file that fails the gate gets no server builds, its page keeps `null` manifest fields, and it is served exactly as before. Files that flip eligibility on rebuild are governed by the fresh manifest, never by leftover files from earlier builds.
- When a document request matches a manifest route with a server module, the dev server renders it per request: `renderComponent()` HTML goes inside `#app` and the state script is emitted as its sibling, in the same document shell the SPA fallback uses. Route matching mirrors the client router exactly (exact pathname lookup, routes lowercased at build time), so unmatched paths, ineligible routes, and unknown assets behave byte-for-byte as they did before server rendering. Watch rebuilds rewrite both builds, and the server module is imported cache-busted by its file mtime, so a render can never be stale after an edit.
- The delivered document boots through the standard runtime entry. On the first render the router looks for `script[type="application/wizz-state"]` beside the mount point; when present and the route has a hydratable build, it imports `hydrateComponent` and adopts the markup (the regular client module is not loaded at all). If the state payload is unreadable, the route has no hydratable build, or adoption fails, the server markup is dropped and the route mounts fresh — never a duplicate DOM. Client-side navigation and browser history always mount fresh.

`scripts/ssr-demo.js` remains a standalone reference for application-owned delivery of the same recipe (for example from your own Node backend).

## Browser Support

Wizz targets current evergreen browsers that support native ES modules and dynamic `import()`. Generated components also require `queueMicrotask()`, standard DOM construction and mutation APIs (`createElement`, `createTextNode`, `appendChild`, `insertBefore`, and `removeChild`), DOM event listeners, and `Element.prototype.querySelector()`. Hydrating modules additionally require `firstElementChild`, `nodeType`, `tagName`, and comment-node access for the adoption walk, and the runtime router's first-render hydration requires `Document.querySelector()` and `Element.remove()`. Applications using the included router additionally require the History API (`history.pushState`) and `popstate` events.

The framework does not ship browser polyfills or transpiled legacy output. Internet Explorer and browsers without native ES modules are unsupported. Serve built files over HTTP(S), with JavaScript served as `text/javascript`; opening modules from the filesystem is not a supported deployment mode.

## Compiler Warnings

Some code compiles but will not behave as written. The compiler reports it as a warning, which never fails a build. There are two. The first is `WIZZ-G026`, a reactive variable assigned where the update scheduler does not see the change, so the DOM keeps showing the old value:

```text
Warning WIZZ-G026: 'count' is assigned where the update scheduler does not see it, so the DOM will not update at src/App.wizz:6:21. Make the assignment a statement of its own, in braces under an if/else or loop (`count += 1; g(count);`, `if (ready) { count = 2; }`), so the update is scheduled.
```

The rewriter that schedules updates only instruments assignments that are statements of their own, because rewriting inside an expression could change what it means. Assignments in call arguments, conditions, object literals, template interpolations, unbraced `if`/`else`/loop bodies, and chained targets (`a = b = 1` updates `a` only) are reported; parameter defaults, declarations, class fields, and names shadowed by a parameter or local declaration are not.

The second is `WIZZ-G027`, an array changed in place with no assignment after it:

```text
Warning WIZZ-G027: 'items' is changed in place by .push() and never reassigned afterwards, so the DOM will not update at src/App.wizz:7:3. Reassign it after the call (`items.push(x); items = items;`) or assign a new array instead (`items = [...items, x]`); assignment is what schedules the update.
```

It fires for a call of `push`, `pop`, `shift`, `unshift`, `splice`, `sort`, `reverse`, `fill`, or `copyWithin` on a reactive `let` when the call is a statement of its own inside a function (or an inline `on:` handler), and nothing assigns or member-writes that name later in the outermost enclosing function. A later assignment inside a nested callback counts. The check is syntactic and conservative, so some cases are not reported: aliases (`const a = items; a.push(x)`), computed names (`items['push'](x)`), calls in expression position or an unbraced `if` body on the same line, `Map`/`Set` methods, and props (read-only, so reassignment is not the fix). Calls at the top level of the script run before the first render and are never reported.

`wizz build` prints warnings after the file's "Compiled" line, `--json` includes them in `diagnostics` with `"severity": "warning"` (they never set `ok` to false), `compile()` returns them as `result.warnings`, and the MCP `component_diagnostics` and `create_or_update_component` tools return them beside any errors.

## Compiler Errors

Always provide `filePath` when compiling a source file. Wizz then includes both the component path and source location in compiler errors:

```text
Unclosed tag <main> starting at src/App.wizz:4:1.
```

## Security Boundaries

Treat every `.wizz` component as trusted application code. Wizz parses and rewrites component scripts during compilation but does not execute them at build time. Once its generated module loads in a browser, the component's `<script>` content, template expressions, and event-handler expressions execute with the same origin, DOM, storage, network, and browser permissions as the hosting application. Wizz is not a sandbox and must not compile user-submitted or otherwise untrusted component source.

Template text is emitted with `document.createTextNode()`, and static text and attribute values are serialized into generated JavaScript rather than concatenated as source. This avoids HTML-string parsing for those values. It is not an application-level sanitization system: dynamic attributes and expressions are ordinary JavaScript, and URL-bearing attributes such as `href` or `src` need application-owned validation when their values originate from untrusted data.

Server-rendered output is different: it is an HTML string, so every text and attribute value passes through an escaping boundary (`&`, `<`, `>` in text; `&`, `"`, `<`, `>` in attributes, with `&` escaped first) and expression output is interpolated through the same escaping. The serialized state script escapes every `<` so state content cannot close the tag early or inject markup. Because the state script is an inline `<script type="application/wizz-state">` element, a strict Content Security Policy must either allow it (for example through a per-response nonce) or you must deliver the state by another trusted channel and pass it to `hydrateComponent()` yourself. Hydration never uses `innerHTML` or `eval`: adoption is a read-only DOM walk, and mismatches always fall back to client rendering.

The development server is for local development only. It provides no authentication, TLS, access control, cache policy, security headers, or production error handling. Deploy the generated `dist` directory behind production hosting that supplies the required transport, headers, access controls, and Content Security Policy. Generated application modules are external ES modules, but their component code still needs a CSP compatible with application JavaScript and dynamic module imports.

File-backed components with author scripts produce source maps containing the full original `.wizz` content in `sourcesContent`. Keep `.map` files private or disable their publication when component source should not be exposed to browser users.

## Generated-Code Assumptions

Generated modules require a browser-like global `document` when `mountComponent(target, props)` runs. The supplied `target` must be a live DOM node, and callers must call the returned `destroy()` handle exactly once. Destruction removes Wizz-tracked listeners and the root node; application-managed listeners, timers, subscriptions, and global resources remain the component author's responsibility and should be released from `onDestroy`.

Wizz owns the DOM subtree it creates. Do not manually reorder, remove, or replace its nodes while a component is mounted: generated updates write directly to the nodes captured at mount or hydration, so a node you replace stops updating, and hydration verifies delivered markup by position.

Generated output preserves author script text inside the component factory and adds scheduler calls only for the documented mutation forms. Generated locals carry the reserved `__wizz` prefix, so ordinary names such as `target`, `state`, `update`, and `value` are free. A top-level declaration or import may not use that prefix, `onMount`, `onDestroy`, or a global generated code reads: `document`, `console`, `queueMicrotask`, `Array`, `Error`, `JSON`, `Map`, `Object`, `Set`, or `String` (`WIZZ-G025`). Inside a function or block any name is allowed. It assumes the preserved script is valid JavaScript in that lexical context; it is not a JavaScript sandbox or a complete JavaScript transformation pipeline. The supported component syntax and intentional rewrite boundaries are documented in the [compiler documentation](src/compiler/README.md) and [generator documentation](src/compiler/generator/README.md).

## Further Reading

- [Compiler API and error contract](src/compiler/README.md)
- [Project structure and compilation pipeline](STRUCTURE.md)
- [Roadmap](ROADMAP.md)

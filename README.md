# Wizz

Wizz is a zero-dependency component compiler. It turns `.wizz` component source into a browser ES module that mounts and updates DOM using platform-native APIs.

## Requirements

- Node.js 18 or newer
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

`wizz init` scaffolds the showcase starter: the global design-token stylesheet (`App.css`) linked from the document shell, a landing page at `/` with the reactive document head, a counter whose count persists across reloads and tabs, and the animated terminal card — plus a `/home` page that server-renders and hydrates. It is a project that runs correctly with no manual editing. `wizz init` refuses to write into a non-empty directory unless you pass `--force`, and it never overwrites an existing file.

## CLI

Wizz installs without npm or a package registry. To install the latest release, run the repository's installer:

```bash
./scripts/install-cli.sh
```

This downloads the latest GitHub release tarball (curl and tar are required) and installs it. A specific tarball can be passed as a path or URL. To install from a cloned working tree instead — the usual path when developing Wizz itself — pass `--local`:

```bash
./scripts/install-cli.sh --local
```

The installer requires Node.js 18 or newer. It installs the compiler and CLI runtime to `${XDG_DATA_HOME:-~/.local/share}/wizz` and places the `wizz` launcher in `${XDG_BIN_HOME:-~/.local/bin}`. It does not require administrator privileges or modify shell configuration files.

Ensure the launcher directory is on your `PATH`. For Bash or Zsh using the default location, add this to your shell profile, then open a new shell:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

The installed `wizz` command is a copy, not a live link to the source. Run the installer again to upgrade to a newer release, or with `--local` after pulling updates that change the compiler, runtime, build script, or CLI scripts; otherwise `wizz build` and `wizz dev` continue using the previously installed copy. Source-only `.wizz` component changes do not require reinstalling. To remove the managed installation, delete the launcher and installed runtime:

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

Every compiler diagnostic carries a stable code (`WIZZ-P###` for parse-stage failures, `WIZZ-G###` for generate-stage failures) that tooling can switch on without parsing prose; the envelope's `format` field is versioned, so fields may be added within format version 1 but existing fields keep their meaning until it changes.

Start the development server with:

```bash
wizz dev
```

`wizz dev` uses the directory where you run the command as the application project: it builds that directory's `src` into `dist`, serves the result, and watches `.wizz` source files. It uses native file events with a 250 ms polling fallback, so changes on mounted filesystems such as WSL's `/mnt/c` still rebuild when an event is missed. Rebuilds update `dist`; refresh the browser to load the new module because live reload is not implemented yet.

Print what you have installed with:

```bash
wizz --version
```

which prints the compiler and contract version triple, for example `wizz 1.9.0 (compiler 1.9.0, syntax 1.4.1, output 1.8.2)`. The public CLI accepts `init`, `build`, `dev`, and `--version`; `build` accepts either no directory arguments or both an input and an output directory.

`wizz dev` requires an `index.html` document shell in the project directory. It validates that requirement before opening the server, so a missing shell reports an error and exits instead of failing later while handling a request. Build failures and invalid command usage also exit non-zero.

### CLI Stability

The installed `wizz` command is Wizz's public command-line interface. Its supported commands are `wizz init [directory] [--force]`, `wizz build`, `wizz build <input-directory> <output-directory>`, `wizz build --json`, `wizz dev`, and `wizz --version`; their documented defaults, generated output paths, and non-zero failure behavior are stable within a CLI major version.

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

The directive expression is emitted as the listener passed to `addEventListener()`.

Reactive updates are batched. When a handler runs, each changed variable is marked, and one DOM update runs on the next microtask with all marks combined — a handler that changes several variables triggers a single update, and the DOM settles before the browser paints. Updates therefore happen asynchronously: read the DOM after an `await`, not synchronously after dispatching an event.

Dynamic attributes use brace-delimited expressions. Wizz updates `value`, `checked`, and `disabled` as DOM properties; all other dynamic names are updated as HTML attributes:

```wizz
<input value={name} checked={isSelected} aria-label={name} />
```

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

When `items` is reassigned, Wizz retains nodes with matching keys, moves retained nodes into the new order, updates their text and dynamic attributes, creates new keys, and removes missing keys. Duplicate keys throw at runtime.

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

In both forms the collection must be a reactive `let` for updates to run (a `const` collection renders once at mount), the block must be nested inside a native element, and the body must contain exactly one native root element. Each blocks do not support imported components, event directives, or nested `if`/`each` blocks inside the repeated content yet; these are compile-time errors rather than silently ignored.

## Conditional Rendering

Select a branch during mounting with an `if` block and optional `else` branch:

```wizz
{#if section === 'About'}
  <p>The counter is available.</p>
{:else}
  <p>Unknown section.</p>
{/if}
```

Conditions currently support the Wizz expression grammar, including identifiers, member access, string literals, and strict equality. A conditional branch is selected at mount time; changing a reactive condition does not yet replace an already-rendered branch.

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

For reactive state changes from a hook, both styles notify the scheduler: `onMount(() => { status = "ready"; })` and `onMount(initialize)` (where `initialize` assigns at statement level) are intercepted by the syntax-aware script rewriter, which follows mutations into function and arrow callback bodies. Assignments in expression position — call arguments, conditions, object literals, template interpolations — and unbraced control-flow bodies are deliberately left unrewritten.

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

Keep the document shell responsible only for the mount element and entry-module load:

```html
<div id="app"></div>
<script type="module" src="/dist/runtime/main.js"></script>
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

Route paths are lowercased. `App.wizz` and `pages/index.wizz` both claim `/`, so a project may contain only one of them. A build also rejects duplicate normalized paths and any page path beginning with `/runtime`, which is reserved for Wizz runtime files. Errors identify the conflicting component paths.

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
node scripts/dev.js
```

The development command builds `src` into `dist`, copies `index.html` and `App.css` into the output directory, serves it at `http://localhost:3000`, and watches `.wizz` files for changes. It reports compiler errors while keeping the server available for subsequent fixes.

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

Delivery is automatic and never duplicates: `wizz dev` server-renders one `<style>` tag per styled component into the document head (a component imported by several pages injects exactly once per document), hydration adopts the delivered stylesheet instead of recreating it, and client mounts share one refcounted stylesheet per component scope. `wizz build` extracts every component's scoped rules into `dist/app.css` — computed with the same scoping pass the generators use, including `@media` descent and scope-suffixed `@keyframes` names — and injects `<link rel="stylesheet" href="/app.css">` into the copied document shell, so production pages arrive styled from the first paint with zero runtime work.

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

## Compatibility and Versioning

Wizz's compatibility contract has three semver versions, defined in `src/compiler/version.js`: the compiler itself, the component syntax contract, and the generated output contract.

As a component author, within one `syntax` major version any component that compiled before keeps compiling with the same meaning. New syntax may be added in a minor version, but existing syntax never changes meaning without a major bump.

As a consumer of generated modules, within one `output` major version every generated module keeps its surface: the `mountComponent(target, props)` default export, the returned `{ setProps?, destroy() }` handle (`setProps(next)` exists on components that declare props), and the teardown behavior behind them.

A breaking change to either contract bumps its major version and the compiler's major version. Every compiled module is stamped with all three versions on its first line, so build artifacts stay traceable to the compiler that produced them:

```js
// Generated by Wizz 1.8.3 (component syntax 1.4.1, generated output 1.8.2). Edits will be overwritten.
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

The server-renderable surface covers everything with a deterministic initial rendering: static markup, text interpolations, dynamic attributes, top-level props, the initially-taken `{#if}` branch, `{#each}` lists (browser target's body restrictions apply: one root element per item, no components, no `on:` directives), and **imported component tags**. A component tag renders by calling the child's own server module, so the surface is defined recursively — a page is server-renderable when its entire component tree is. Child state snapshots serialize under the framework-reserved `__wizz` key (`state.__wizz.components["<componentId>"]`); reactive variable names cannot start with `__wizz`, so the namespace stays framework-owned. Event handlers and lifecycle hooks remain client-only, and author scripts that read browser globals (e.g. `document.location`) are the author's responsibility — the compile gate passes but `renderComponent()` fails at runtime, exactly like any nondeterministic module state in other frameworks. Server output produces no source map.

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

Wizz owns the DOM subtree it creates. Do not manually reorder, remove, or replace its nodes while a component is mounted: generated updates use `data-wizz-id` lookups scoped to the component root and child-node indexes.

Generated output preserves author script text inside the component factory and adds scheduler calls only for the documented mutation forms. It assumes the preserved script is valid JavaScript in that lexical context; it is not a JavaScript sandbox or a complete JavaScript transformation pipeline. The supported component syntax and intentional rewrite boundaries are documented in the [compiler documentation](src/compiler/README.md) and [generator documentation](src/compiler/generator/README.md).

## Further Reading

- [Compiler API and error contract](src/compiler/README.md)
- [Project structure and compilation pipeline](STRUCTURE.md)
- [Roadmap](ROADMAP.md)

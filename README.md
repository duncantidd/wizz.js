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

To see the compiler output for the included example component:

```bash
node test.js
```

## CLI

Wizz installs without npm or a package registry. From the cloned repository, run:

```bash
./scripts/install-cli.sh
```

The installer requires Node.js 18 or newer. It copies the compiler and CLI runtime to `${XDG_DATA_HOME:-~/.local/share}/wizz` and places the `wizz` launcher in `${XDG_BIN_HOME:-~/.local/bin}`. It does not require administrator privileges or modify shell configuration files.

Ensure the launcher directory is on your `PATH`. For Bash or Zsh using the default location, add this to your shell profile, then open a new shell:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Run `./scripts/install-cli.sh` again from an updated checkout to replace the managed local installation. To remove it, delete the launcher and installed runtime:

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

Start the development server with:

```bash
wizz dev
```

`wizz dev` uses the directory where you run the command as the application project: it builds that directory's `src` into `dist`, serves the result, and watches `.wizz` source files. The public CLI currently accepts only `build` and `dev`; `build` accepts either no directory arguments or both an input and an output directory.

`wizz dev` requires an `index.html` document shell in the project directory. It validates that requirement before opening the server, so a missing shell reports an error and exits instead of failing later while handling a request. Build failures and invalid command usage also exit non-zero.

### CLI Stability

The installed `wizz` command is Wizz's public command-line interface. Its supported commands are `wizz build`, `wizz build <input-directory> <output-directory>`, and `wizz dev`; their documented defaults, generated output paths, and non-zero failure behavior are stable within a CLI major version.

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

The output directory is created when needed. It must be different from the input directory. Wizz continues compiling independent components after an error, reports each failed file and its source location, and exits with a non-zero status if any component fails.

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

The build rewrites the import to `./components/Counter.js`, which follows the output-path mapping. Imported component tags must be nested inside a native element and cannot yet receive attributes or children. Destroying the parent component also destroys all imported child components.

Serve the directory over HTTP when loading browser ES modules, for example:

```bash
node scripts/dev.js
```

The development command builds `src` into `dist`, copies `index.html` and `App.css` into the output directory, serves it at `http://localhost:3000`, and watches `.wizz` files for changes. It reports compiler errors while keeping the server available for subsequent fixes.

Requests for browser routes such as `http://localhost:3000/Home` receive the document shell, allowing the client router to select the matching component. Existing output files such as `/runtime/main.js` and `/pages/Home.js` are served directly; missing asset paths return HTTP 404.

## Compatibility and Versioning

Wizz's compatibility contract has three semver versions, defined in `src/compiler/version.js`: the compiler itself, the component syntax contract, and the generated output contract.

As a component author, within one `syntax` major version any component that compiled before keeps compiling with the same meaning. New syntax may be added in a minor version, but existing syntax never changes meaning without a major bump.

As a consumer of generated modules, within one `output` major version every generated module keeps its surface: the `mountComponent(target)` default export, the returned `{ destroy() }` handle, and the teardown behavior behind it.

A breaking change to either contract bumps its major version and the compiler's major version. Every compiled module is stamped with all three versions on its first line, so build artifacts stay traceable to the compiler that produced them:

```js
// Generated by Wizz 1.1.0 (component syntax 1.0.0, generated output 1.1.0). Edits will be overwritten.
```

`compile()` also returns the frozen version table as its `version` field.

## Compiler Errors

Always provide `filePath` when compiling a source file. Wizz then includes both the component path and source location in compiler errors:

```text
Unclosed tag <main> starting at src/App.wizz:4:1.
```

## Browser Support

Wizz targets current evergreen browsers that support native ES modules and dynamic `import()`. Generated components also require `queueMicrotask()`, standard DOM construction and mutation APIs (`createElement`, `createTextNode`, `appendChild`, `insertBefore`, and `removeChild`), DOM event listeners, and `document.querySelector()`. Applications using the included router additionally require the History API (`history.pushState`) and `popstate` events.

The framework does not ship browser polyfills, transpiled legacy output, SSR, or hydration. Internet Explorer and browsers without native ES modules are unsupported. Serve built files over HTTP(S), with JavaScript served as `text/javascript`; opening modules from the filesystem is not a supported deployment mode.

## Security Boundaries

Treat every `.wizz` component as trusted application code. Wizz parses and rewrites component scripts during compilation but does not execute them at build time. Once its generated module loads in a browser, the component's `<script>` content, template expressions, and event-handler expressions execute with the same origin, DOM, storage, network, and browser permissions as the hosting application. Wizz is not a sandbox and must not compile user-submitted or otherwise untrusted component source.

Template text is emitted with `document.createTextNode()`, and static text and attribute values are serialized into generated JavaScript rather than concatenated as source. This avoids HTML-string parsing for those values. It is not an application-level sanitization system: dynamic attributes and expressions are ordinary JavaScript, and URL-bearing attributes such as `href` or `src` need application-owned validation when their values originate from untrusted data.

The development server is for local development only. It provides no authentication, TLS, access control, cache policy, security headers, or production error handling. Deploy the generated `dist` directory behind production hosting that supplies the required transport, headers, access controls, and Content Security Policy. Generated application modules are external ES modules, but their component code still needs a CSP compatible with application JavaScript and dynamic module imports.

File-backed components with author scripts produce source maps containing the full original `.wizz` content in `sourcesContent`. Keep `.map` files private or disable their publication when component source should not be exposed to browser users.

## Generated-Code Assumptions

Generated modules require a browser-like global `document` when `mountComponent(target)` runs. The supplied `target` must be a live DOM node, and callers must call the returned `destroy()` handle exactly once. Destruction removes Wizz-tracked listeners and the root node; application-managed listeners, timers, subscriptions, and global resources remain the component author's responsibility and should be released from `onDestroy`.

Wizz owns the DOM subtree it creates. Do not manually reorder, remove, or replace its nodes while a component is mounted: generated updates use `data-wizz-id` lookups and child-node indexes. Reactive IDs are currently allocated per component instance but looked up through `document.querySelector()`, so applications must not mount multiple reactive instances whose generated IDs can overlap at the same time. Static components and one active reactive instance are unaffected; instance-scoped lookup is future work.

Generated output preserves author script text inside the component factory and adds scheduler calls only for the documented mutation forms. It assumes the preserved script is valid JavaScript in that lexical context; it is not a JavaScript sandbox or a complete JavaScript transformation pipeline. The supported component syntax and intentional rewrite boundaries are documented in the [compiler documentation](src/compiler/README.md) and [generator documentation](src/compiler/generator/README.md).

## Further Reading

- [Compiler API and error contract](src/compiler/README.md)
- [Project structure and compilation pipeline](STRUCTURE.md)
- [Roadmap](ROADMAP.md)

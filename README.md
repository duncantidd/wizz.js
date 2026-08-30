# Wizz

Wizz is a zero-dependency component compiler. It turns `.wizz` component source into a browser ES module that mounts and updates DOM using platform-native APIs.

## Requirements

- Node.js 18 or newer
- A modern browser for running generated modules

There are no packages to install.

## Get Started

Clone the repository and run the test suite from its root:

```bash
node --test
```

To see the compiler output for the included example component:

```bash
node test.js
```

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

`src/runtime/main.js` defines an explicit route table. The initial application route is `/`, which loads the emitted `App.js` module:

```js
const routes = {
  '/': () => import('../App.js')
};
```

Add routes explicitly as compiled component modules become available. The router loads the component matching `window.location.pathname`, destroys the previously mounted component before each replacement, and renders `Not found` for unmatched paths.

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

## Further Reading

- [Compiler API and error contract](src/compiler/README.md)
- [Project structure and compilation pipeline](STRUCTURE.md)
- [Roadmap](ROADMAP.md)

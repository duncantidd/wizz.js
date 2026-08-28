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

## Compiler Errors

Always provide `filePath` when compiling a source file. Wizz then includes both the component path and source location in compiler errors:

```text
Unclosed tag <main> starting at src/App.wizz:4:1.
```

## Further Reading

- [Compiler API and error contract](src/compiler/README.md)
- [Project structure and compilation pipeline](STRUCTURE.md)
- [Roadmap](ROADMAP.md)

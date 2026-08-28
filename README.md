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

Serve the directory over HTTP when loading browser ES modules, for example:

```bash
python3 -m http.server
```

Then open the printed local URL in a browser.

## Compiler Errors

Always provide `filePath` when compiling a source file. Wizz then includes both the component path and source location in compiler errors:

```text
Unclosed tag <main> starting at src/App.wizz:4:1.
```

## Further Reading

- [Compiler API and error contract](src/compiler/README.md)
- [Project structure and compilation pipeline](STRUCTURE.md)
- [Roadmap](ROADMAP.md)

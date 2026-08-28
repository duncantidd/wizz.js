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
  Counter.wizz
  pages/
    Home.wizz
```

```bash
node build.js src dist
```

Wizz recursively compiles every `.wizz` file and preserves its path below the output directory:

```text
src/Counter.wizz     -> dist/Counter.js
src/pages/Home.wizz  -> dist/pages/Home.js
```

The output directory is created when needed. It must be different from the input directory. Wizz continues compiling independent components after an error, reports each failed file and its source location, and exits with a non-zero status if any component fails.

The generated file has a default `mountComponent(target)` export. Import it from a browser module and pass it a DOM element:

```html
<div id="app"></div>
<script type="module">
  import mountComponent from './Counter.js';

  const target = document.getElementById('app');
  const component = mountComponent(target);

  // Call component.destroy() when the component is no longer needed.
</script>
```

Serve the directory over HTTP when loading browser ES modules, for example:

```bash
python3 -m http.server
```

Then open the printed local URL in a browser.

## Compiler Errors

Always provide `filePath` when compiling a source file. Wizz then includes both the component path and source location in compiler errors:

```text
Unclosed tag <main> starting at Counter.wizz:4:1.
```

## Further Reading

- [Compiler API and error contract](src/compiler/README.md)
- [Project structure and compilation pipeline](STRUCTURE.md)
- [Roadmap](ROADMAP.md)

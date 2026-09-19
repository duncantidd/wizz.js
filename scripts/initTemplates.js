// The canonical starter templates `wizz init` scaffolds.
//
// Kept minimal on purpose: together they demonstrate every load-bearing
// surface — the document shell contract (`#app` mount point plus the
// runtime module script), the route conventions (src/App.wizz at `/`,
// src/pages/*.wizz below `/`), the document head block, scoped component
// styles, props, and persistent state — with no stylesheet or asset
// dependencies, so a scaffolded project runs with nothing but `wizz dev`.
// The templates are compile targets: initTemplates.test.js compiles each
// one for both targets and init.test.js serves the scaffolded project, so
// a language or generator change that would break new projects fails the
// suite before it can ship.

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>My Wizz App</title>
</head>
<body>
  <div id="app"></div>

  <script type="module" src="/runtime/main.js"></script>
</body>
</html>
`;

const APP_WIZZ = `<script>
  import Counter from "./components/Counter.wizz";
</script>

<wizz:head>
  <title>My Wizz App</title>
  <meta name="description" content="A Wizz component framework app">
</wizz:head>

<main>
  <h1>Hello, Wizz!</h1>
  <p>
    This page is compiled from <code>src/App.wizz</code> and served at the
    <code>/</code> route. Edit it and the browser updates without a reload.
  </p>
  <Counter />
  <p><a href="/home">Continue to the /home page</a></p>
</main>

<wizz:style>
  main {
    max-width: 40rem;
    margin: 0 auto;
    padding: 3rem 1.5rem;
    font-family: system-ui, sans-serif;
    color: #1f2937;
    line-height: 1.6;
  }
  h1 {
    font-size: 2rem;
    margin: 0 0 1rem;
  }
  a {
    color: #2563eb;
  }
</wizz:style>
`;

const HOME_WIZZ = `<script>
  import Counter from "../components/Counter.wizz";
</script>

<wizz:head>
  <title>Home - My Wizz App</title>
</wizz:head>

<main>
  <h1>The Home page</h1>
  <p>
    Files in <code>src/pages</code> get a route from their path. This one
    server-renders at <code>/home</code> and hydrates in the browser.
  </p>
  <Counter />
  <p><a href="/">Back to the start page</a></p>
</main>

<wizz:style>
  main {
    max-width: 40rem;
    margin: 0 auto;
    padding: 3rem 1.5rem;
    font-family: system-ui, sans-serif;
    color: #1f2937;
    line-height: 1.6;
  }
  h1 {
    font-size: 1.75rem;
    margin: 0 0 1rem;
  }
  a {
    color: #2563eb;
  }
</wizz:style>
`;

const COUNTER_WIZZ = `<script>
  // persist(key, default) keeps this count across reloads and tabs.
  let count = persist('count', 0);

  export let step = 1;

  function increment() {
    count += step;
  }
</script>

<div>
  <button on:click={increment}>Clicked {count} times</button>
</div>

<wizz:style>
  div {
    display: flex;
    justify-content: center;
  }
  button {
    appearance: none;
    border: 0;
    border-radius: 999px;
    background: #2563eb;
    color: #ffffff;
    cursor: pointer;
    font: inherit;
    font-size: 1rem;
    font-weight: 600;
    padding: 0.6rem 1.4rem;
  }
  button:hover {
    background: #1d4ed8;
  }
</wizz:style>
`;

// Insertion order is the scaffold order init reports.
module.exports = {
  'index.html': INDEX_HTML,
  'src/App.wizz': APP_WIZZ,
  'src/pages/Home.wizz': HOME_WIZZ,
  'src/components/Counter.wizz': COUNTER_WIZZ
};

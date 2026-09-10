#!/usr/bin/env node
// Zero-dependency SSR demo for the Contact/Home showcase project.
//
//   node scripts/ssr-demo.js            (then open http://localhost:3001)
//
// Milestone 12 delivered the compiler API + hydration runtime, not server
// integration: `wizz dev` still serves static build output only (see the
// Development Server Decision in ROADMAP.md). This script shows the delivery
// recipe an application server would follow:
//
//   1. compileServer() the component into an HTML string renderer.
//   2. renderComponent() produces { html, state } at request time.
//   3. Deliver html inside the mount point and serializeInitialState(state)
//      as a SIBLING script tag of the mount point.
//   4. Deliver a hydratable client build (compile() with { hydratable: true })
//      and call hydrateComponent(target, props, state) in the browser.
//
// v1 surface: static markup, text interpolations, dynamic attributes, and
// top-level props. src/pages/Home.wizz fits; Contact.wizz (component tag) and
// About.wizz ({#if}/{#each}) are rejected by the server target with located
// diagnostics.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { compileServer, compile } = require('../src/compiler');

const PAGE_SOURCE = path.join(__dirname, '..', 'src', 'pages', 'Home.wizz');
const STYLESHEET_PATH = path.join(__dirname, '..', 'App.css');
const PORT = process.env.PORT || 3001;
const DOCUMENT_ROUTES = new Set(['/', '/Home']);

async function main() {
  const source = fs.readFileSync(PAGE_SOURCE, 'utf8');

  // Compile once at startup: server target renders HTML strings, client
  // target is the same component with the hydration adoption walk added.
  const serverModuleSource = compileServer(source, { filePath: 'src/pages/Home.wizz' }).source;
  const clientModuleSource = compile(source, { filePath: 'src/pages/Home.wizz', hydratable: true }).source;

  // The server module is ESM; evaluate it through a temp file import.
  const serverModulePath = path.join(os.tmpdir(), `wizz-ssr-demo-${process.pid}.mjs`);
  fs.writeFileSync(serverModulePath, serverModuleSource);
  const { renderComponent, serializeInitialState } = await import(pathToFileURL(serverModulePath).href);

  const server = http.createServer((request, response) => {
    // Serve each known asset explicitly and 404 everything else. A catch-all
    // that answered every path with the document would hand the browser's
    // /App.css request HTML back (Content-Type: text/html), so the stylesheet
    // would never apply — the exact bug this guard prevents.
    if (request.url === '/Home.client.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' });
      response.end(clientModuleSource);
      return;
    }
    if (request.url === '/App.css') {
      response.writeHead(200, { 'Content-Type': 'text/css' });
      response.end(fs.readFileSync(STYLESHEET_PATH));
      return;
    }
    if (!DOCUMENT_ROUTES.has(request.url)) {
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('Not found');
      return;
    }

    // Render fresh on every request — the server module holds no per-request
    // state, so concurrent requests are safe.
    const { html, state } = renderComponent();
    const stateScript = serializeInitialState(state).replace(
      '<script ',
      '<script id="wizz-state" '
    );

    const document = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>wizz.js Showcase</title>
  <link rel="stylesheet" href="./App.css">
</head>
<body>
  <div id="app">${html}</div>
  ${stateScript}
  <script type="module">
    import { hydrateComponent } from '/Home.client.js';
    const stateScript = document.getElementById('wizz-state');
    const state = stateScript ? JSON.parse(stateScript.textContent) : null;
    hydrateComponent(document.getElementById('app'), {}, state);
  </script>
</body>
</html>
`;

    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(document);
  });

  server.listen(PORT, () => {
    console.log(`SSR demo serving http://localhost:${PORT} (view-source shows server-rendered markup)`);
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

const assert = require('node:assert/strict');
const test = require('node:test');
const { TEMPLATE_SETS, DEFAULT_TEMPLATE } = require('./initTemplates.js');

const TEMPLATES = TEMPLATE_SETS.sample;
const BARE = TEMPLATE_SETS.bare;
const { compile, compileServer } = require('../src/compiler');

test('the template table names exactly the sample and bare sets, defaulting to sample', () => {
  assert.deepEqual(Object.keys(TEMPLATE_SETS), ['sample', 'bare']);
  assert.equal(DEFAULT_TEMPLATE, 'sample');
  // No prototype: a name like __proto__ or constructor can never resolve to
  // an inherited object, so it cannot smuggle a foreign file set in.
  assert.equal(Object.getPrototypeOf(TEMPLATE_SETS), null);
  assert.equal(TEMPLATE_SETS.__proto__, undefined);
  assert.equal(TEMPLATE_SETS.constructor, undefined);
});

test('the template table and its sets are frozen against mutation', () => {
  assert.ok(Object.isFrozen(TEMPLATE_SETS));
  for (const name of Object.keys(TEMPLATE_SETS)) {
    assert.ok(Object.isFrozen(TEMPLATE_SETS[name]), name);
  }
  assert.throws(() => { 'use strict'; TEMPLATE_SETS.sample['evil.js'] = 'x'; }, TypeError);
  assert.throws(() => { 'use strict'; TEMPLATE_SETS.extra = {}; }, TypeError);
  assert.equal(TEMPLATE_SETS.sample['evil.js'], undefined);
});

test('the sample set covers exactly the canonical starter files', () => {
  assert.deepEqual(Object.keys(TEMPLATES), [
    'README.md',
    'index.html',
    'App.css',
    'src/App.wizz',
    'src/pages/Home.wizz',
    'src/components/Counter.wizz',
    'src/components/Card.wizz',
    'src/server/api/health.js'
  ]);
});

test('the scaffolded README points a fresh project at the release distribution surface', () => {
  const readme = TEMPLATES['README.md'];
  // A scaffolded project has no clone of wizz.js: the extension install
  // instructions must route through the release assets, not repository
  // paths, and the CLI instructions through the public one-liner.
  assert.match(readme, /https:\/\/github\.com\/duncantidd\/wizz\.js\/releases/);
  assert.match(readme, /wizz install-vscode-extension/);
  assert.match(readme, /wizz-vscode-<version>\.vsix/);
  assert.match(readme, /code --install-extension wizz-vscode-<version>\.vsix/);
  assert.match(readme, /raw\.githubusercontent\.com\/duncantidd\/wizz\.js\/main\/scripts\/install-cli\.sh/);
  // The documented commands and defaults the rest of the templates assume.
  assert.match(readme, /wizz dev/);
  assert.match(readme, /http:\/\/localhost:3000/);
  assert.match(readme, /wizz build/);
  assert.match(readme, /dist\//);
});

test('the document shell carries the runtime mount contract and links the global stylesheet', () => {
  const shell = TEMPLATES['index.html'];
  assert.match(shell, /<div id="app"><\/div>/);
  assert.match(shell, /<script type="module" src="\/runtime\/main\.js"><\/script>/);
  assert.match(shell, /<meta name="viewport"/);
  assert.match(shell, /<meta name="theme-color" content="#0b0f14">/);
  // The relative link matches the dev server's and wizz build's App.css copy.
  assert.match(shell, /<link rel="stylesheet" href="\.\/App\.css">/);
});

test('the global stylesheet carries the shared design tokens the components consume', () => {
  const stylesheet = TEMPLATES['App.css'];
  assert.match(stylesheet, /--wizz-bg: #0b0f14;/);
  assert.match(stylesheet, /--wizz-accent: #facc15;/);
  assert.match(stylesheet, /--wizz-accent-ink: #1a1405;/);
  // The landing-page layout the starter presents: hero grid, pill badge,
  // divider, and the base button the Counter's scoped style refines.
  assert.match(stylesheet, /@media \(min-width: 960px\)/);
  assert.match(stylesheet, /main > p \{/);
  assert.match(stylesheet, /main::after \{/);
  assert.match(stylesheet, /button:focus-visible \{/);
});

// The server-side gate requires imports to be vouched for; a build's
// eligibility walk vouches the starter's own imports, so the templates are
// vouched here the same way.
const COMPONENT_VOUCHES = { Counter: true, Card: true };

for (const [setName, files] of Object.entries(TEMPLATE_SETS)) {
  for (const [templatePath, source] of Object.entries(files)) {
    if (!templatePath.endsWith('.wizz')) continue;

    test(`the ${setName} ${templatePath} template compiles for the browser target without warnings`, () => {
      const result = compile(source);
      assert.equal(typeof result.source, 'string');
      assert.match(result.source, /export default function mountComponent/);
      assert.deepEqual(result.warnings || [], []);
    });

    test(`the ${setName} ${templatePath} template compiles for the server target`, () => {
      const result = compileServer(source, { componentServerRenderable: COMPONENT_VOUCHES });
      assert.equal(typeof result.source, 'string');
      assert.match(result.source, /export function renderComponent/);
    });
  }
}

test('the starter App lands at / with a reactive head block and both showcase components', () => {
  const app = TEMPLATES['src/App.wizz'];
  assert.match(app, /<wizz:head>/);
  assert.match(app, /<title>Hello \{name\} - \{frameworkName\}<\/title>/);
  assert.match(app, /onMount\(\(\) => \{/);
  assert.match(app, /import Counter from "\.\/components\/Counter\.wizz";/);
  assert.match(app, /import Card from "\.\/components\/Card\.wizz";/);
  assert.match(app, /<Counter showReset=\{true\} \/>/);
  assert.match(app, /<Card \/>/);
});

test('the starter Home page demonstrates the src/pages route convention', () => {
  const home = TEMPLATES['src/pages/Home.wizz'];
  assert.match(home, /<wizz:head>/);
  assert.match(home, /href="\/"/);
  // The page content is wrapped so the global landing-page rules (`main > p`
  // pill badges, the hero grid) do not fight this page's own layout.
  assert.match(home, /<section class="page">/);
  assert.match(home, /<wizz:style>/);
});

test('the starter Counter demonstrates persistent state, props, and scoped styles', () => {
  const counter = TEMPLATES['src/components/Counter.wizz'];
  assert.match(counter, /let count = persist\('count', 0\);/);
  assert.match(counter, /let rawClicks = 0;/);
  assert.match(counter, /export let showReset = false;/);
  assert.match(counter, /on:click=\{increment\}/);
  assert.match(counter, /\{#if showReset\}/);
  assert.match(counter, /<wizz:style>/);
});

test('the starter Card demonstrates the animated terminal and token-driven scoped styles', () => {
  const card = TEMPLATES['src/components/Card.wizz'];
  assert.match(card, /class="terminal"/);
  assert.match(card, /data-cmd="build src dist"/);
  assert.match(card, /@keyframes inputs/);
  assert.match(card, /var\(--wizz-border\)/);
  assert.match(card, /<wizz:style>/);
});

test('the starter API handler demonstrates the request context and the secrets rule', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { pathToFileURL } = require('node:url');
  const health = TEMPLATES['src/server/api/health.js'];
  assert.match(health, /export default async function handler\(request\)/);
  assert.match(health, /request\.method/);
  // The template must teach where keys live and where they must never go.
  assert.match(health, /\.env\.server/);
  assert.match(health, /process\.env/);

  // It must run: a syntax error here would break every scaffolded project.
  // ESM only imports as a module with type: module pinned beside it — the
  // same marker the build writes beside dist output.
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-template-health-'));
  try {
    fs.writeFileSync(path.join(tempDirectory, 'package.json'), '{"type":"module"}\n', 'utf8');
    const handlerPath = path.join(tempDirectory, 'health.js');
    fs.writeFileSync(handlerPath, health, 'utf8');
    const handlerModule = await import(pathToFileURL(handlerPath).href);
    assert.equal(typeof handlerModule.default, 'function');
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('the bare set writes only the canonical shape: README, shell, and a placeholder App', () => {
  assert.deepEqual(Object.keys(BARE), ['README.md', 'index.html', 'src/App.wizz']);
  // Nothing from the sample's optional surface.
  for (const templatePath of Object.keys(BARE)) {
    assert.doesNotMatch(templatePath, /^App\.css$|^src\/(components|pages|server)\//);
  }
  // Bare is a strict subset of the sample's paths, so --bare over a sample
  // project (or the reverse) refuses on the shared files.
  for (const templatePath of Object.keys(BARE)) {
    assert.ok(Object.prototype.hasOwnProperty.call(TEMPLATES, templatePath), templatePath);
  }
});

test('the bare document shell keeps the runtime mount contract and links no stylesheet', () => {
  const shell = BARE['index.html'];
  assert.match(shell, /<div id="app"><\/div>/);
  assert.match(shell, /<script type="module" src="\/runtime\/main\.js"><\/script>/);
  assert.match(shell, /<meta name="viewport"/);
  assert.match(shell, /<\/head>/);
  // There is no App.css to link: a dangling link would 404 on every load.
  assert.doesNotMatch(shell, /App\.css/);
  assert.doesNotMatch(shell, /<link\b/i);
});

test('the bare App is a self-contained placeholder with no imports or styles', () => {
  const app = BARE['src/App.wizz'];
  assert.doesNotMatch(app, /import\s/);
  assert.doesNotMatch(app, /<wizz:style>/);
  assert.doesNotMatch(app, /persist\(/);
  assert.match(app, /<main>/);
  assert.match(app, /src\/App\.wizz/);
});

test('the bare README describes the bare layout, not the sample files', () => {
  const readme = BARE['README.md'];
  const layout = readme.slice(readme.indexOf('## Project layout'), readme.indexOf('## Growing the project'));
  assert.match(layout, /index\.html\s+Document shell/);
  assert.match(layout, /src\/App\.wizz\s+Start page \(served at \/\)/);
  for (const sampleOnly of ['Counter.wizz', 'Card.wizz', 'Home.wizz', 'health.js', 'App.css']) {
    assert.ok(!layout.includes(sampleOnly), sampleOnly);
  }
  // The build section must not claim files the bare project does not have.
  const build = readme.slice(readme.indexOf('## Build'), readme.indexOf('## Project layout'));
  assert.doesNotMatch(build, /App\.css/);
  assert.doesNotMatch(build, /extracted styles/);
  // It still teaches how to grow the project and where secrets live.
  assert.match(readme, /src\/pages\//);
  assert.match(readme, /src\/components\//);
  assert.match(readme, /<link rel="stylesheet" href="\.\/App\.css">/);
  assert.match(readme, /src\/server\/api\//);
  assert.match(readme, /\.env\.server/);
});

test('both READMEs share the same intro and editor setup, in the same section order', () => {
  const sections = (readme) => readme.split('\n').filter((line) => line.startsWith('## '));
  assert.deepEqual(sections(TEMPLATES['README.md']), [
    '## Prerequisites', '## Develop', '## Build', '## Project layout', '## Server API routes', '## Editor setup (VS Code)'
  ]);
  assert.deepEqual(sections(BARE['README.md']), [
    '## Prerequisites', '## Develop', '## Build', '## Project layout', '## Growing the project', '## Editor setup (VS Code)'
  ]);
  const intro = (readme) => readme.slice(0, readme.indexOf('## Build'));
  const editor = (readme) => readme.slice(readme.indexOf('## Editor setup (VS Code)'));
  assert.equal(intro(BARE['README.md']), intro(TEMPLATES['README.md']));
  assert.equal(editor(BARE['README.md']), editor(TEMPLATES['README.md']));
  // Fragment joins must not double or drop blank lines between sections.
  for (const readme of [TEMPLATES['README.md'], BARE['README.md']]) {
    assert.doesNotMatch(readme, /\n\n\n/);
    assert.match(readme, /\n\n## Build\n/);
    assert.ok(readme.endsWith('it).\n'));
  }
});


const assert = require('node:assert/strict');
const test = require('node:test');
const TEMPLATES = require('./initTemplates.js');
const { compile, compileServer } = require('../src/compiler');

test('the template set covers exactly the canonical starter files', () => {
  assert.deepEqual(Object.keys(TEMPLATES), [
    'README.md',
    'index.html',
    'App.css',
    'src/App.wizz',
    'src/pages/Home.wizz',
    'src/components/Counter.wizz',
    'src/components/Card.wizz'
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

for (const [templatePath, source] of Object.entries(TEMPLATES)) {
  if (!templatePath.endsWith('.wizz')) continue;

  test(`the ${templatePath} template compiles for the browser target`, () => {
    const result = compile(source);
    assert.equal(typeof result.source, 'string');
    assert.match(result.source, /export default function mountComponent/);
  });

  test(`the ${templatePath} template compiles for the server target`, () => {
    const result = compileServer(source, { componentServerRenderable: COMPONENT_VOUCHES });
    assert.equal(typeof result.source, 'string');
    assert.match(result.source, /export function renderComponent/);
  });
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

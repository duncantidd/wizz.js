const assert = require('node:assert/strict');
const test = require('node:test');
const TEMPLATES = require('./initTemplates.js');
const { compile, compileServer } = require('../src/compiler');

test('the template set covers exactly the canonical starter files', () => {
  assert.deepEqual(Object.keys(TEMPLATES), [
    'index.html',
    'src/App.wizz',
    'src/pages/Home.wizz',
    'src/components/Counter.wizz'
  ]);
});

test('the document shell carries the runtime mount contract', () => {
  const shell = TEMPLATES['index.html'];
  assert.match(shell, /<div id="app"><\/div>/);
  assert.match(shell, /<script type="module" src="\/runtime\/main\.js"><\/script>/);
  assert.match(shell, /<meta name="viewport"/);
});

for (const [templatePath, source] of Object.entries(TEMPLATES)) {
  if (!templatePath.endsWith('.wizz')) continue;

  test(`the ${templatePath} template compiles for the browser target`, () => {
    const result = compile(source);
    assert.equal(typeof result.source, 'string');
    assert.match(result.source, /export default function mountComponent/);
  });

  test(`the ${templatePath} template compiles for the server target`, () => {
    // The gate requires imports to be vouched for; a build's eligibility
    // walk vouches the starter's own Counter import, so the template is
    // vouched here the same way.
    const result = compileServer(source, { componentServerRenderable: { Counter: true } });
    assert.equal(typeof result.source, 'string');
    assert.match(result.source, /export function renderComponent/);
  });
}

test('the starter App lands at / with a head block and links to /home', () => {
  const app = TEMPLATES['src/App.wizz'];
  assert.match(app, /<wizz:head>/);
  assert.match(app, /href="\/home"/);
  assert.match(app, /import Counter from "\.\/components\/Counter\.wizz";/);
});

test('the starter Home page demonstrates the src/pages route convention', () => {
  const home = TEMPLATES['src/pages/Home.wizz'];
  assert.match(home, /import Counter from "\.\.\/components\/Counter\.wizz";/);
  assert.match(home, /<wizz:head>/);
});

test('the starter Counter demonstrates persistent state, props, and scoped styles', () => {
  const counter = TEMPLATES['src/components/Counter.wizz'];
  assert.match(counter, /let count = persist\('count', 0\);/);
  assert.match(counter, /export let step = 1;/);
  assert.match(counter, /on:click=\{increment\}/);
  assert.match(counter, /<wizz:style>/);
});

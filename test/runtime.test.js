const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { buildProject } = require('../build');

function createTemporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-runtime-test-'));
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, 'utf8');
}

function createDocument(target) {
  return {
    getElementById(id) {
      return id === 'app' ? target : null;
    },
    createElement(name) {
      return { name, childNodes: [], appendChild(node) { this.childNodes.push(node); } };
    },
    createTextNode(nodeValue) {
      return { nodeValue };
    }
  };
}

test('the document shell supplies #app and loads only the emitted runtime entry', () => {
  const documentShell = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

  assert.match(documentShell, /<div id="app"><\/div>/);
  assert.match(documentShell, /<script type="module" src="\/dist\/runtime\/main\.js"><\/script>/);
  assert.doesNotMatch(documentShell, /import mountComponent/);
});

test('emitted runtime mounts the compiled App component into #app', async (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));

  const inputDirectory = path.join(projectDirectory, 'src');
  const outputDirectory = path.join(projectDirectory, 'dist');
  writeFile(path.join(inputDirectory, 'App.wizz'), '<main><p>Ready</p></main>');
  buildProject(inputDirectory, outputDirectory, { log() {}, error() {} });
  writeFile(path.join(outputDirectory, 'package.json'), '{"type":"module"}');

  const target = { childNodes: [], appendChild(node) { this.childNodes.push(node); } };
  const originalDocument = global.document;
  global.document = createDocument(target);
  t.after(() => { global.document = originalDocument; });

  await import(`${pathToFileURL(path.join(outputDirectory, 'runtime', 'main.js')).href}?test=${Date.now()}`);

  assert.equal(target.childNodes.length, 1);
  assert.equal(target.childNodes[0].name, 'main');
});

test('emitted runtime reports a missing #app mount target', async (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));

  const inputDirectory = path.join(projectDirectory, 'src');
  const outputDirectory = path.join(projectDirectory, 'dist');
  writeFile(path.join(inputDirectory, 'App.wizz'), '<main><p>Ready</p></main>');
  buildProject(inputDirectory, outputDirectory, { log() {}, error() {} });
  writeFile(path.join(outputDirectory, 'package.json'), '{"type":"module"}');

  const originalDocument = global.document;
  global.document = createDocument(null);
  t.after(() => { global.document = originalDocument; });

  await assert.rejects(
    import(`${pathToFileURL(path.join(outputDirectory, 'runtime', 'main.js')).href}?test=${Date.now()}`),
    /Wizz could not find mount target "#app"\./
  );
});
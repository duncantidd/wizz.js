const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { initProject } = require('./init');
const { VERSIONS } = require('../src/compiler');
const {
  MAX_SOURCE_BYTES,
  TOOL_DEFINITIONS,
  ToolExecutionError,
  assertWritableComponentPath,
  compileGate,
  createToolRegistry,
  looksLikeWizzProject,
  realpathInsideRoot,
  resolveInsideRoot
} = require('./mcpTools');

const TOOL_NAMES = [
  'project_overview',
  'component_diagnostics',
  'build_project',
  'language_contract',
  'dev_workflow',
  'create_or_update_component'
];

const BROKEN_SOURCE = '<main><p>Unclosed paragraph';

function createProjectFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-mcp-tools-'));
  initProject(root);
  return root;
}

function createRegistry(root, allowWrite = false) {
  return createToolRegistry({ root, allowWrite });
}

async function refuse(promise, match) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ToolExecutionError);
    if (match) assert.match(error.message, match);
    return true;
  });
}

test('the registry exposes exactly the six Wizz tools with unique names and schemas', () => {
  const root = createProjectFixture();
  const registry = createRegistry(root);
  const tools = registry.list();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [...TOOL_NAMES].sort());
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 0);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  for (const name of TOOL_NAMES) {
    assert.equal(registry.has(name), true);
  }
  assert.equal(registry.has('nope'), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('the registry refuses a project root that does not exist', () => {
  const missing = path.join(os.tmpdir(), 'wizz-mcp-missing-root');
  fs.rmSync(missing, { recursive: true, force: true });
  assert.throws(() => createToolRegistry({ root: missing }), /Project root does not exist/);
});

test('project_overview surveys the scaffolded project', async () => {
  const root = createProjectFixture();
  const registry = createRegistry(root);
  const { structured, text } = await registry.call('project_overview', {});
  assert.equal(structured.root, root);
  assert.equal(structured.inputDirectory, 'src');
  assert.deepEqual(structured.versions, { ...VERSIONS });
  assert.equal(structured.documentShell, true);
  assert.equal(structured.adapters.length, 1);
  const files = Object.fromEntries(structured.components.map((component) => [component.file, component.route]));
  assert.equal(files['App.wizz'], '/');
  assert.equal(files['pages/Home.wizz'], '/home');
  assert.equal(files['components/Counter.wizz'], null);
  assert.deepEqual(structured.apiRoutes, [{ routePath: '/api/health', filePath: 'server/api/health.js' }]);
  assert.match(text, /Components: 4/);
  assert.match(text, /\/api\/health/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('project_overview honors an inputDirectory override and reports a missing one', async () => {
  const root = createProjectFixture();
  const registry = createRegistry(root);
  const nested = await registry.call('project_overview', { inputDirectory: 'src/components' });
  assert.deepEqual(nested.structured.components.map((component) => component.file).sort(), ['Card.wizz', 'Counter.wizz']);
  const missing = await registry.call('project_overview', { inputDirectory: 'src/nowhere' });
  assert.equal(missing.structured.components.length, 0);
  assert.match(missing.structured.discoveryError, /ENOENT|no such file/i);
  fs.rmSync(root, { recursive: true, force: true });
});

test('component_diagnostics compiles a clean project file with no diagnostics', async () => {
  const root = createProjectFixture();
  const registry = createRegistry(root);
  const { structured } = await registry.call('component_diagnostics', { path: 'src/pages/Home.wizz' });
  assert.equal(structured.target, 'src/pages/Home.wizz');
  assert.equal(structured.ok, true);
  assert.deepEqual(structured.diagnostics, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('component_diagnostics returns located records for a broken file', async () => {
  const root = createProjectFixture();
  fs.writeFileSync(path.join(root, 'src/Broken.wizz'), BROKEN_SOURCE, 'utf8');
  const registry = createRegistry(root);
  const { structured, text } = await registry.call('component_diagnostics', { path: 'src/Broken.wizz' });
  assert.equal(structured.ok, false);
  const record = structured.diagnostics[0];
  assert.equal(record.severity, 'error');
  assert.equal(record.file, 'src/Broken.wizz');
  assert.equal(typeof record.line, 'number');
  assert.equal(typeof record.column, 'number');
  assert.match(text, /WIZZ-P/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('component_diagnostics compiles inline source with an optional path label', async () => {
  const root = createProjectFixture();
  const registry = createRegistry(root);
  const labeled = await registry.call('component_diagnostics', { source: BROKEN_SOURCE, path: 'proposed/Counter.wizz' });
  assert.equal(labeled.structured.target, 'proposed/Counter.wizz');
  assert.equal(labeled.structured.ok, false);
  assert.equal(labeled.structured.diagnostics[0].file, 'proposed/Counter.wizz');
  const unlabeled = await registry.call('component_diagnostics', { source: BROKEN_SOURCE });
  assert.equal(unlabeled.structured.target, 'inline.wizz');
  fs.rmSync(root, { recursive: true, force: true });
});

test('component_diagnostics with all aggregates every component under the input directory', async () => {
  const root = createProjectFixture();
  fs.writeFileSync(path.join(root, 'src/Broken.wizz'), BROKEN_SOURCE, 'utf8');
  const registry = createRegistry(root);
  const { structured } = await registry.call('component_diagnostics', { all: true });
  assert.equal(structured.inputDirectory, 'src');
  assert.equal(structured.ok, false);
  const broken = structured.files.find((entry) => entry.file === 'Broken.wizz');
  const clean = structured.files.find((entry) => entry.file === 'pages/Home.wizz');
  assert.equal(broken.ok, false);
  assert.equal(clean.ok, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('component_diagnostics refuses ambiguous targets and unsafe paths', async () => {
  const root = createProjectFixture();
  const registry = createRegistry(root);
  await refuse(registry.call('component_diagnostics', {}), /exactly one/);
  await refuse(registry.call('component_diagnostics', { all: true, path: 'src/App.wizz' }), /excludes/);
  await refuse(registry.call('component_diagnostics', { all: 'yes' }), /must be true/);
  await refuse(registry.call('component_diagnostics', { path: '../outside.wizz' }), /inside the project root/);
  await refuse(registry.call('component_diagnostics', { path: 'src/pages/Home.js' }), /\.wizz/);
  await refuse(registry.call('component_diagnostics', { path: 'src/Missing.wizz' }), /not found/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('build_project returns the machine-readable envelope for the scaffolded project', async () => {
  const root = createProjectFixture();
  const registry = createRegistry(root);
  const { structured, text } = await registry.call('build_project', {});
  assert.equal(structured.format, 'wizz-build-diagnostics@1');
  assert.equal(structured.ok, true);
  assert.equal(structured.compiledCount, 4);
  assert.equal(structured.failedCount, 0);
  assert.equal(structured.files.length, 4);
  assert.ok(fs.existsSync(path.join(root, 'dist', 'App.js')));
  assert.match(text, /succeeded/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('build_project runs the node adapter on request', async () => {
  const root = createProjectFixture();
  const registry = createRegistry(root);
  const { structured } = await registry.call('build_project', { adapter: 'node' });
  assert.equal(structured.adapter, 'node');
  assert.ok(fs.existsSync(path.join(root, 'dist', 'server.mjs')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('build_project reports a broken component through the envelope', async () => {
  const root = createProjectFixture();
  fs.writeFileSync(path.join(root, 'src/Broken.wizz'), BROKEN_SOURCE, 'utf8');
  const registry = createRegistry(root);
  const { structured } = await registry.call('build_project', {});
  assert.equal(structured.ok, false);
  assert.equal(structured.failedCount, 1);
  assert.equal(structured.diagnostics[0].file, 'Broken.wizz');
  fs.rmSync(root, { recursive: true, force: true });
});

test('build_project refuses directories outside the root and identical directories', async () => {
  const root = createProjectFixture();
  const registry = createRegistry(root);
  await refuse(registry.call('build_project', { outputDirectory: '../dist-escape' }), /inside the project root/);
  await refuse(registry.call('build_project', { outputDirectory: 'src' }), /must be different/);
  await refuse(registry.call('build_project', { adapter: 'vercel' }), /Unknown adapter/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('language_contract documents the version triple, language surface, and diagnostic catalog', async () => {
  const root = createProjectFixture();
  const registry = createRegistry(root);
  const { text } = await registry.call('language_contract', {});
  // The literal triple is pinned deliberately: a version bump fails this
  // test until the contract text has been reviewed against the compiler.
  assert.match(text, /compiler 1\.14\.0, syntax 1\.4\.1, output 1\.8\.2/);
  assert.match(text, /export let/);
  assert.match(text, /onMount/);
  assert.match(text, /onDestroy/);
  assert.match(text, /persist\(/);
  assert.match(text, /{#each/);
  assert.match(text, /{#if/);
  assert.match(text, /wizz:style/);
  assert.match(text, /wizz:head/);
  assert.match(text, /WIZZ-P###/);
  assert.match(text, /diagnostics\.js/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('dev_workflow documents the real commands, deploy recipe, and secrets rule', async () => {
  const root = createProjectFixture();
  const registry = createRegistry(root);
  const { text } = await registry.call('dev_workflow', {});
  assert.match(text, /wizz dev \[--port/);
  assert.match(text, /wizz build \[input-directory\]/);
  assert.match(text, /--adapter node/);
  assert.match(text, /node dist\/server\.mjs/);
  assert.match(text, /\.env\.server/);
  assert.match(text, /wizz update/);
  assert.match(text, /server\/api/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('create_or_update_component refuses to run without --allow-write', async () => {
  const root = createProjectFixture();
  const registry = createRegistry(root, false);
  // A configuration refusal throws the expected ToolExecutionError; the
  // protocol session is what turns it into an isError result for the agent.
  await refuse(
    registry.call('create_or_update_component', { path: 'src/pages/About.wizz', source: '<main><p>About</p></main>' }),
    /--allow-write/
  );
  assert.ok(!fs.existsSync(path.join(root, 'src', 'pages', 'About.wizz')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('create_or_update_component creates and updates components', async () => {
  const root = createProjectFixture();
  const registry = createRegistry(root, true);
  const created = await registry.call('create_or_update_component', {
    path: 'src/pages/About.wizz',
    source: '<main><p>About</p></main>'
  });
  assert.equal(created.structured.action, 'created');
  assert.equal(fs.readFileSync(path.join(root, 'src', 'pages', 'About.wizz'), 'utf8'), '<main><p>About</p></main>');
  const updated = await registry.call('create_or_update_component', {
    path: 'src/pages/About.wizz',
    source: '<main><p>About us</p></main>',
    overwrite: true
  });
  assert.equal(updated.structured.action, 'updated');
  assert.equal(fs.readFileSync(path.join(root, 'src', 'pages', 'About.wizz'), 'utf8'), '<main><p>About us</p></main>');
  fs.rmSync(root, { recursive: true, force: true });
});

test('create_or_update_component refuses existing files without overwrite and missing files with it', async () => {
  const root = createProjectFixture();
  const registry = createRegistry(root, true);
  const existing = await registry.call('create_or_update_component', {
    path: 'src/pages/Home.wizz',
    source: '<main><p>Replaced</p></main>'
  });
  assert.equal(existing.structured.refused, 'exists');
  assert.notEqual(fs.readFileSync(path.join(root, 'src', 'pages', 'Home.wizz'), 'utf8'), '<main><p>Replaced</p></main>');
  const missing = await registry.call('create_or_update_component', {
    path: 'src/pages/Nowhere.wizz',
    source: '<main><p>Nowhere</p></main>',
    overwrite: true
  });
  assert.equal(missing.structured.refused, 'missing-file');
  assert.ok(!fs.existsSync(path.join(root, 'src', 'pages', 'Nowhere.wizz')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('create_or_update_component refuses non-.wizz targets, traversal, absolute paths, and managed trees', async () => {
  const root = createProjectFixture();
  const registry = createRegistry(root, true);
  for (const [target, match] of [
    ['src/pages/About.js', /\.wizz/],
    ['../escape.wizz', /inside the project root/],
    [path.join(root, 'src', 'Absolute.wizz'), /relative to the project root/],
    ['dist/Injected.wizz', /managed 'dist\//],
    ['node_modules/Injected.wizz', /managed 'node_modules\//],
    ['.git/Injected.wizz', /managed '\.git\//],
    ['release/Injected.wizz', /managed 'release\//],
    ['vscode-extension/Injected.wizz', /managed 'vscode-extension\//]
  ]) {
    const result = await registry.call('create_or_update_component', { path: target, source: '<main><p>x</p></main>' });
    assert.equal(result.isError, true, target);
    assert.match(result.text, match, target);
    assert.equal(result.structured.refused, 'path-refused', target);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('create_or_update_component refuses a symlink escape in both directions', async () => {
  const root = createProjectFixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-mcp-outside-'));
  fs.writeFileSync(path.join(outside, 'victim.wizz'), '<main><p>original</p></main>', 'utf8');
  fs.symlinkSync(path.join(outside, 'victim.wizz'), path.join(root, 'src', 'link.wizz'));
  fs.symlinkSync(outside, path.join(root, 'src', 'linkdir'));
  const registry = createRegistry(root, true);

  const targetLink = await registry.call('create_or_update_component', {
    path: 'src/link.wizz',
    source: '<main><p>hijacked</p></main>',
    overwrite: true
  });
  assert.equal(targetLink.isError, true);
  assert.match(targetLink.text, /symbolic link|outside the project root/);
  assert.equal(fs.readFileSync(path.join(outside, 'victim.wizz'), 'utf8'), '<main><p>original</p></main>');

  const throughDirectory = await registry.call('create_or_update_component', {
    path: 'src/linkdir/hijack.wizz',
    source: '<main><p>hijacked</p></main>'
  });
  assert.equal(throughDirectory.isError, true);
  assert.match(throughDirectory.text, /outside the project root/);
  assert.deepEqual(fs.readdirSync(outside), ['victim.wizz']);

  // A dangling symlink is refused before the write can follow it.
  fs.symlinkSync(path.join(outside, 'dangling.wizz'), path.join(root, 'src', 'dangling.wizz'));
  const dangling = await registry.call('create_or_update_component', {
    path: 'src/dangling.wizz',
    source: '<main><p>dangling</p></main>'
  });
  assert.equal(dangling.isError, true);
  assert.ok(!fs.existsSync(path.join(outside, 'dangling.wizz')));

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('create_or_update_component refuses source that does not compile and leaves the file untouched', async () => {
  const root = createProjectFixture();
  const registry = createRegistry(root, true);
  const original = fs.readFileSync(path.join(root, 'src', 'pages', 'Home.wizz'), 'utf8');
  const result = await registry.call('create_or_update_component', {
    path: 'src/pages/Home.wizz',
    source: BROKEN_SOURCE,
    overwrite: true
  });
  assert.equal(result.isError, true);
  assert.equal(result.structured.refused, 'compile-gate');
  assert.equal(result.structured.diagnostics.length, 1);
  assert.equal(result.structured.diagnostics[0].severity, 'error');
  assert.equal(fs.readFileSync(path.join(root, 'src', 'pages', 'Home.wizz'), 'utf8'), original);

  const fresh = await registry.call('create_or_update_component', {
    path: 'src/pages/New.wizz',
    source: BROKEN_SOURCE
  });
  assert.equal(fresh.isError, true);
  assert.ok(!fs.existsSync(path.join(root, 'src', 'pages', 'New.wizz')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('create_or_update_component requires a recognizable project, valid fields, and a capped source', async () => {
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-mcp-empty-'));
  const emptyRegistry = createRegistry(emptyRoot, true);
  const noProject = await emptyRegistry.call('create_or_update_component', { path: 'src/New.wizz', source: '<main><p>x</p></main>' });
  assert.equal(noProject.structured.refused, 'no-project');
  assert.match(noProject.text, /wizz init/);
  fs.rmSync(emptyRoot, { recursive: true, force: true });

  const root = createProjectFixture();
  const registry = createRegistry(root, true);
  await refuse(registry.call('create_or_update_component', { source: '<main><p>x</p></main>' }), /path/);
  await refuse(registry.call('create_or_update_component', { path: 'src/New.wizz' }), /source/);
  await refuse(registry.call('create_or_update_component', { path: 'src/New.wizz', source: 42 }), /source/);
  await refuse(registry.call('create_or_update_component', { path: 'src/New.wizz', source: '<main><p>x</p></main>', overwrite: 'yes' }), /overwrite/);
  const oversize = await registry.call('create_or_update_component', {
    path: 'src/New.wizz',
    source: '<main>' + 'x'.repeat(MAX_SOURCE_BYTES) + '</main>'
  });
  assert.equal(oversize.isError, true);
  assert.match(oversize.text, /byte limit/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a __proto__ key inside tool arguments is inert end to end', async () => {
  const root = createProjectFixture();
  const registry = createRegistry(root, true);
  // JSON.parse materializes an own __proto__ property; the protocol layer
  // strips it before handlers run, and the handler must read only declared
  // keys either way.
  const hostile = JSON.parse('{"path":"src/pages/Safe.wizz","source":"<main><p>safe</p></main>","__proto__":{"polluted":true}}');
  const result = await registry.call('create_or_update_component', hostile);
  assert.equal(result.structured.action, 'created');
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

test('path guards: lexical containment table', () => {
  const root = createProjectFixture();
  for (const good of ['src/App.wizz', './src/App.wizz', 'src/pages/../pages/Home.wizz', 'newdir/nested/New.wizz']) {
    const guard = resolveInsideRoot(root, good);
    assert.equal(guard.ok, true, good);
    assert.ok(guard.absolutePath.startsWith(root + path.sep), good);
  }
  // 'C:\evil.wizz' is deliberately absent: on POSIX it is a legal (weird)
  // relative filename, not an absolute path — the guard must not guess.
  for (const bad of ['', '   ', '.', '..', '../sibling.wizz', '/etc/passwd']) {
    const guard = resolveInsideRoot(root, bad);
    assert.equal(guard.ok, false, bad);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('path guards: filesystem containment catches symlinked ancestors', () => {
  const root = createProjectFixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-mcp-real-'));
  fs.symlinkSync(outside, path.join(root, 'src', 'linkdir'));
  const target = path.join(root, 'src', 'linkdir', 'inside.wizz');
  const real = realpathInsideRoot(root, target);
  assert.equal(real.ok, false);
  assert.match(real.reason, /outside the project root/);
  const inside = realpathInsideRoot(root, path.join(root, 'src', 'nested', 'deep', 'New.wizz'));
  assert.equal(inside.ok, true);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('compileGate and helpers behave as documented', () => {
  const clean = compileGate('<main><p>ok</p></main>', 'a.wizz');
  assert.deepEqual(clean, { ok: true, diagnostics: [] });
  const broken = compileGate(BROKEN_SOURCE, 'a.wizz');
  assert.equal(broken.ok, false);
  assert.equal(broken.diagnostics.length, 1);
  assert.equal(looksLikeWizzProject(fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-mcp-helper-'))), false);
  assert.equal(looksLikeWizzProject(process.cwd()), true);
});

test('TOOL_DEFINITIONS is frozen and the write tool requires its fields', () => {
  assert.throws(() => {
    TOOL_DEFINITIONS.push({ name: 'rogue' });
  });
  const write = TOOL_DEFINITIONS.find((tool) => tool.name === 'create_or_update_component');
  assert.deepEqual(write.inputSchema.required, ['path', 'source']);
});
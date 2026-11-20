const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { initProject } = require('./init');
const { VERSIONS, compile } = require('../src/compiler');
const { CODES } = require('../src/compiler/diagnostics');
const {
  MAX_SOURCE_BYTES,
  TEMPLATE_LIMITS,
  TOOL_DEFINITIONS,
  ToolExecutionError,
  assertWritableComponentPath,
  compileGate,
  createToolRegistry,
  looksLikeWizzProject,
  realpathInsideRoot,
  resolveInsideRoot,
  templateLimitsMarkdown,
  writeComponentFile
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
  assert.match(text, /compiler 1\.23\.0, syntax 1\.6\.0, output 1\.13\.0/);
  // Reviewed for 1.23.0 / output 1.13.0 (issues #69 and #73): the expression grammar, bindings, and G026 warnings.
  assert.match(text, /- bind:value=\{name\} on <input>, <textarea>, <select>/);
  assert.match(text, /warning WIZZ-G026/);
  assert.match(text, /the conditional a \? b : c,\ncalls of a function or method/);
  assert.match(text, /the branch is replaced when a\n  reactive let or prop the condition reads changes/);
  assert.match(text, /on:click=\{\(\) => remove\(item\.id\)\}/);
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
test('component_diagnostics caps inline source at the compile limit before the parser runs', async () => {
  const root = createProjectFixture();
  const registry = createRegistry(root, false);
  await assert.rejects(
    () => registry.call('component_diagnostics', { source: 'x'.repeat(MAX_SOURCE_BYTES + 1) }),
    (error) => error instanceof ToolExecutionError && /byte compile limit/.test(error.message)
  );
  // The boundary value itself is accepted (the cap is exclusive).
  const boundarySource = '<main><p>x</p></main>' + 'x'.repeat(MAX_SOURCE_BYTES - '<main><p>x</p></main>'.length);
  assert.equal(Buffer.byteLength(boundarySource, 'utf8'), MAX_SOURCE_BYTES);
  await registry.call('component_diagnostics', { source: boundarySource });
  fs.rmSync(root, { recursive: true, force: true });
});

test('component_diagnostics reports oversized project files as records in all and path modes', async () => {
  const root = createProjectFixture();
  const registry = createRegistry(root, false);
  fs.writeFileSync(path.join(root, 'src', 'Big.wizz'), '<main><p>x</p></main>' + 'x'.repeat(MAX_SOURCE_BYTES), 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'Small.wizz'), '<main><p>small</p></main>', 'utf8');

  const all = await registry.call('component_diagnostics', { all: true });
  const bigEntry = all.structured.files.find((entry) => entry.file === 'Big.wizz');
  const smallEntry = all.structured.files.find((entry) => entry.file === 'Small.wizz');
  assert.equal(bigEntry.ok, false);
  assert.match(bigEntry.diagnostics[0].message, /byte compile limit/);
  assert.equal(smallEntry.ok, true, 'the oversized file must not stop the remaining diagnostics');
  assert.equal(all.structured.ok, false);

  const single = await registry.call('component_diagnostics', { path: 'src/Big.wizz' });
  assert.equal(single.structured.ok, false);
  assert.match(single.structured.diagnostics[0].message, /byte compile limit/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('writeComponentFile writes through an O_NOFOLLOW fd on the verified parent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-write-fd-'));
  const targetDirectory = path.join(root, 'src', 'pages');
  fs.mkdirSync(targetDirectory, { recursive: true });
  const target = path.join(targetDirectory, 'New.wizz');
  const expectedRealParent = fs.realpathSync(targetDirectory);

  const created = writeComponentFile(target, '<main><p>x</p></main>', expectedRealParent);
  assert.deepEqual(created, { ok: true });
  assert.equal(fs.readFileSync(target, 'utf8'), '<main><p>x</p></main>');

  const updated = writeComponentFile(target, '<main><p>y</p></main>', expectedRealParent);
  assert.deepEqual(updated, { ok: true });
  assert.equal(fs.readFileSync(target, 'utf8'), '<main><p>y</p></main>');
  fs.rmSync(root, { recursive: true, force: true });
});

test('writeComponentFile refuses a symlink planted at the target instead of following it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-write-fd-'));
  const targetDirectory = path.join(root, 'src');
  fs.mkdirSync(targetDirectory, { recursive: true });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-write-outside-'));
  fs.writeFileSync(path.join(outside, 'victim.wizz'), 'original', 'utf8');
  const target = path.join(targetDirectory, 'link.wizz');
  fs.symlinkSync(path.join(outside, 'victim.wizz'), target);
  const expectedRealParent = fs.realpathSync(targetDirectory);

  const result = writeComponentFile(target, '<main><p>x</p></main>', expectedRealParent);
  assert.equal(result.ok, false);
  assert.match(result.reason, /symbolic link/);
  assert.equal(fs.readFileSync(path.join(outside, 'victim.wizz'), 'utf8'), 'original');
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('writeComponentFile refuses an ancestor directory swapped for a symlink after the checks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-write-fd-'));
  const targetDirectory = path.join(root, 'src', 'components');
  fs.mkdirSync(targetDirectory, { recursive: true });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-write-outside-'));
  fs.writeFileSync(path.join(outside, 'victim.wizz'), 'original', 'utf8');

  // The guard computed this realpath while src/components was still a real
  // directory inside the root; the attacker then swaps it for a symlink
  // pointing outside. The write must refuse, and nothing may land outside.
  const staleExpectedRealParent = fs.realpathSync(targetDirectory);
  fs.rmSync(targetDirectory, { recursive: true });
  fs.symlinkSync(outside, targetDirectory);

  const result = writeComponentFile(path.join(targetDirectory, 'New.wizz'), '<main><p>x</p></main>', staleExpectedRealParent);
  assert.equal(result.ok, false);
  assert.match(result.reason, /target directory changed/);
  assert.equal(fs.readFileSync(path.join(outside, 'victim.wizz'), 'utf8'), 'original');
  assert.ok(!fs.existsSync(path.join(outside, 'New.wizz')));
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Template language limits (issue #77): one table feeds the README, the
// language_contract tool, and project_overview. These tests keep the three
// in sync and pin every documented claim against the real compiler, so a
// compiler change that lifts (or changes) a limit fails here until the
// table is updated.
// ---------------------------------------------------------------------------

const README_PATH = path.join(__dirname, '..', 'README.md');

function component(script, template) {
  return `<script>\n${script}\n</script>\n${template}`;
}

function compileCode(source) {
  try {
    compile(source);
    return null;
  } catch (error) {
    return error.code;
  }
}

function generated(source) {
  return compile(source).source;
}

test('the README embeds the template limits table verbatim', () => {
  const readme = fs.readFileSync(README_PATH, 'utf8');
  assert.ok(readme.includes(`\n${templateLimitsMarkdown()}\n`), 'README.md must contain templateLimitsMarkdown() output; regenerate the table');
  // The table sits near the top: before the CLI reference and the first
  // authoring section, where a newcomer reads it before writing code.
  const tableAt = readme.indexOf('## Template Language at a Glance');
  assert.ok(tableAt > 0);
  assert.ok(tableAt < readme.indexOf('## CLI'));
  assert.ok(tableAt < readme.indexOf('## Create a Component'));
});

test('templateLimitsMarkdown escapes pipes so every row keeps exactly five cells', () => {
  const rows = templateLimitsMarkdown().split('\n');
  assert.equal(rows.length, TEMPLATE_LIMITS.length + 2);
  for (const row of rows) {
    // Unescaped pipes delimit cells: 5 cells means 6 delimiters.
    const delimiters = row.match(/(?<!\\)\|/g) || [];
    assert.equal(delimiters.length, 6, row);
  }
  // The expressions row documents `&&`/`||`, so escaping is exercised.
  assert.match(templateLimitsMarkdown(), /`\\\|\\\|`/);
});

test('TEMPLATE_LIMITS rows are frozen, complete, and cite only real diagnostic codes', () => {
  const catalog = new Set(Object.values(CODES).flatMap((stage) => Object.values(stage)));
  const fields = ['area', 'supported', 'limit', 'failure', 'workaround'];
  assert.ok(Object.isFrozen(TEMPLATE_LIMITS));
  assert.equal(new Set(TEMPLATE_LIMITS.map((row) => row.area)).size, TEMPLATE_LIMITS.length);
  for (const row of TEMPLATE_LIMITS) {
    assert.ok(Object.isFrozen(row));
    assert.deepEqual(Object.keys(row), fields);
    for (const field of fields) {
      assert.equal(typeof row[field], 'string');
      assert.ok(row[field].trim().length > 0, `${row.area}.${field}`);
      assert.doesNotMatch(row[field], /\n/);
    }
    for (const code of Object.values(row).join(' ').match(/WIZZ-[PAG]\d{3}/g) || []) {
      assert.ok(catalog.has(code), `${row.area} cites unknown code ${code}`);
    }
  }
});

test('language_contract serves the limits table as text and as a defensive structured copy', async () => {
  const root = createProjectFixture();
  const registry = createRegistry(root);
  const first = await registry.call('language_contract', {});
  assert.match(first.text, /Template language at a glance/);
  for (const row of TEMPLATE_LIMITS) {
    assert.ok(first.text.includes(`- ${row.area}`), row.area);
    assert.ok(first.text.includes(row.limit), row.area);
    assert.ok(first.text.includes(row.workaround), row.area);
  }
  // The corrected grammar line names the arithmetic operators the parser
  // actually accepts.
  assert.match(first.text, /\+ - \* \/, strict equality \(===\)/);
  assert.deepEqual(first.structured.templateLimits, TEMPLATE_LIMITS.map((row) => ({ ...row })));
  // A caller mutating one response cannot corrupt the next one.
  first.structured.templateLimits[0].limit = 'tampered';
  first.structured.templateLimits.length = 0;
  const second = await registry.call('language_contract', {});
  assert.equal(second.structured.templateLimits.length, TEMPLATE_LIMITS.length);
  assert.equal(second.structured.templateLimits[0].limit, TEMPLATE_LIMITS[0].limit);
  fs.rmSync(root, { recursive: true, force: true });
});

test('project_overview surfaces the limits before any component is written', async () => {
  const root = createProjectFixture();
  const registry = createRegistry(root);
  const { structured, text } = await registry.call('project_overview', {});
  assert.match(text, /Template language limits \(full contract: language_contract\):/);
  for (const row of TEMPLATE_LIMITS) {
    assert.ok(text.includes(`- ${row.area}: ${row.limit}`), row.area);
  }
  assert.deepEqual(structured.templateLimits, TEMPLATE_LIMITS.map((row) => ({ ...row })));
  // A missing input directory still answers with the limits.
  const missing = await registry.call('project_overview', { inputDirectory: 'src/nowhere' });
  assert.equal(missing.structured.templateLimits.length, TEMPLATE_LIMITS.length);
  fs.rmSync(root, { recursive: true, force: true });
});

test('every documented compile-error limit fails with the code the table cites', () => {
  const imports = "  import Card from './Card.wizz';\n  let xs = [];\n  function f() {}";
  const cases = [
    // Expressions row: each excluded form is WIZZ-P033.
    ...['a[0]', 'a == 1', 'a != 1', 'a ?? 1', 'a?.b', '--a', 'f()()', '`x${a}`', '[1]', '@html a', 'eval(a)', 'a.constructor.constructor(a)']
      .map((expression) => [`expression ${expression}`, component('let a = { b: 1 };', `<p>{${expression}}</p>`), 'WIZZ-P033']),
    ['quoted attribute interpolation', component('let kind = "x";', '<div class="card {kind}"></div>'), 'WIZZ-P055'],
    ['{:else if}', component('let a = 1;', '<div>{#if a === 1}<b>a</b>{:else if a === 2}<i>b</i>{/if}</div>'), 'WIZZ-P033'],
    ['each member collection', component('let s = { xs: [] };', '<ul>{#each s.xs as x}<li>{x}</li>{/each}</ul>'), 'WIZZ-P002'],
    ['each index alias', component('let xs = [];', '<ul>{#each xs as x, i}<li>{x}</li>{/each}</ul>'), 'WIZZ-P002'],
    ['each body component', component(imports, '<ul>{#each xs as x}<li><Card /></li>{/each}</ul>'), 'WIZZ-G004'],
    ['each body nested if', component('let xs = [];', '<ul>{#each xs as x}<li>{#if x === 1}<b>a</b>{/if}</li>{/each}</ul>'), 'WIZZ-G005'],
    ['each body nested each', component('let xs = [];', '<ul>{#each xs as x}<li>{#each xs as y}<b>{y}</b>{/each}</li>{/each}</ul>'), 'WIZZ-G005'],
    ['each body two roots', component('let xs = [];', '<ul>{#each xs as x}<li>{x}</li><li>{x}</li>{/each}</ul>'), 'WIZZ-G003'],
    ['component children', component(imports, '<div><Card>hi</Card></div>'), 'WIZZ-G008'],
    ['component on:', component(imports, '<div><Card on:click={f} /></div>'), 'WIZZ-G011'],
    ['component at root', component(imports, '<Card />'), 'WIZZ-G010'],
    // Bindings row.
    ['bind:group', component('let a = "";', '<main><input bind:group={a} /></main>'), 'WIZZ-P062'],
    ['bind in each body', component('let a = "";\n  let xs = [];', '<ul>{#each xs as x}<li><input bind:value={a} /></li>{/each}</ul>'), 'WIZZ-P062'],
    ['bind on component', component("import Card from './Card.wizz';\n  let a = '';", '<main><Card bind:value={a} /></main>'), 'WIZZ-P062'],
    ['bind dynamic type', component('let a = "";\n  let t = "text";', '<main><input type={t} bind:value={a} /></main>'), 'WIZZ-P062'],
    ['bind member target', component('let s = { a: "" };', '<main><input bind:value={s.a} /></main>'), 'WIZZ-P063'],
    ['bind const', component('const a = "";', '<main><input bind:value={a} /></main>'), 'WIZZ-P063'],
    ['bind prop', component('export let a = "";', '<main><input bind:value={a} /></main>'), 'WIZZ-P063'],
    ['bind with value', component('let a = "";', '<main><input value={a} bind:value={a} /></main>'), 'WIZZ-P064']
  ];
  for (const [name, source, code] of cases) {
    assert.equal(compileCode(source), code, name);
  }
});

test('every documented silent limit compiles and generates the documented behavior', () => {
  // {#if}: a test reading only const values is selected inline at mount and
  // gets no block machinery, so nothing ever re-evaluates it.
  const constIf = generated(component('const ok = 1;', '<div>{#if ok === 1}<b>a</b>{:else}<i>b</i>{/if}</div>'));
  assert.match(constIf, /if \(ok === 1\) \{/);
  assert.doesNotMatch(constIf, /__wizzIfBlock|__wizzIfMake/);

  // {#each}: a handler expression is evaluated once, when the item is
  // created; only what an arrow reads at call time follows the item.
  const eachHandler = generated(component('let xs = [];\n  function make(x) { return () => x; }', '<ul>{#each xs as x}<li on:click={make(x)}>{x}</li>{/each}</ul>'));
  assert.match(eachHandler, /__wizzOn\([^,]+, "click", make\(x\)\)/);

  // Expressions: a call is tracked through the reactive names passed to it.
  // One that reads state only inside the function has no dependency, so it
  // is rendered at mount and never rewritten.
  const hiddenRead = generated(component('let n = 0;\n  function label() { return n + 1; }', '<main><p>{label()}</p><b>{label(n)}</b></main>'));
  assert.match(hiddenRead, /createTextNode\(String\(label\(\)\)\)/);
  assert.doesNotMatch(hiddenRead, /nodeValue = String\(label\(\)\)/);
  assert.match(hiddenRead, /nodeValue = String\(label\(n\)\)/);
  assert.equal(eachHandler.split('make(x))').length, 2, 'update() does not re-evaluate the handler expression');

  // {#each}: in-place mutation schedules nothing; a const collection is
  // accepted.
  assert.doesNotMatch(generated(component('let xs = [];\n  function add() { xs.push(1); }', '<ul on:click={add}>{#each xs as x}<li>{x}</li>{/each}</ul>')), /__wizzQueueUpdate\(\{ xs/);
  assert.equal(compileCode(component('const xs = [];', '<ul>{#each xs as x}<li>{x}</li>{/each}</ul>')), null);

  // Dynamic attributes: boolean attributes toggle presence; other names keep
  // "false" and are removed only for null/undefined (issue #72).
  const attributes = generated(component('let a = false;', '<div hidden={a} aria-pressed={a} disabled={a}></div>'));
  assert.match(attributes, /__wizzAttr\([^,]+, "hidden", a, 1\)/);
  assert.match(attributes, /__wizzAttr\([^,]+, "aria-pressed", a\)/);
  assert.match(attributes, /\.disabled = a;/);

  // Braces in quotes that hold no expression stay literal text.
  assert.match(generated(component('let kind = "x";', '<div data-x=\'{"a":1}\'></div>')), /setAttribute\("data-x", "\{\\"a\\":1\}"\)/);

  // Assignments nested in an expression schedule no update, and the compile
  // says so with a WIZZ-G026 warning.
  const nested = compile(component('let a = 1;\n  let ok = 1;', '<button on:click={() => ok ? a = 2 : 0}>{a}</button>'));
  assert.doesNotMatch(nested.source, /__wizzQueueUpdate\(\{ a/);
  assert.deepEqual(nested.warnings.map((warning) => warning.code), ['WIZZ-G026']);
});

test('every documented working pattern compiles and is reactive', () => {
  // Parenthesized assignment bodies and bindings update (issue #73).
  assert.match(generated(component('let a = 1;', '<button on:click={() => (a = 2)}>{a}</button>')), /__wizzQueueUpdate\(\{ a: true \}\)/);
  const bound = generated(component('let name = "";\n  let done = false;', '<main><input bind:value={name} /><input type="checkbox" bind:checked={done} /></main>'));
  assert.match(bound, /\.value = name;/);
  assert.match(bound, /"input", \(__wizzEvent\) => \{ name = __wizzEvent\.target\.value; __wizzQueueUpdate\(\{ name: true \}\); \}/);
  assert.match(bound, /"change", \(__wizzEvent\) => \{ done = __wizzEvent\.target\.checked; __wizzQueueUpdate\(\{ done: true \}\); \}/);
  // A per-row field is a value + on:input pair.
  assert.match(generated(component('let items = [];\n  function rename(id, v) {}', '<ul>{#each items as item}<li><input value={item.name} on:input={(e) => rename(item.id, e.target.value)} /></li>{/each}</ul>')), /rename\(item\.id, e\.target\.value\)/);
  // Derived value recomputed in a handler.
  assert.match(generated(component("let done = false;\n  let label = 'Open';\n  function toggle() { done = !done; label = done ? 'Done' : 'Open'; }", '<button on:click={toggle}>{label}</button>')), /__wizzQueueUpdate\(\{ label: true \}\)/);
  // A reactive {#if} re-evaluates when its dependency changes (issue #71).
  const reactiveIf = generated(component('let ok = 1;\n  function flip() { ok = 2; }', '<div on:click={flip}>{#if ok === 1}<b>a</b>{:else}<i>b</i>{/if}</div>'));
  assert.match(reactiveIf, /__wizzIf_1\.sync\(__wizzChanged, __wizzChanged\.ok\)/);
  assert.match(reactiveIf, /__wizzIfBlock\([^,]+, [^,]+, \(\) => \(ok === 1\), \[__wizzIfMake_1_0, __wizzIfMake_1_1\]/);
  // Keeping an element mounted and toggling it with hidden={flag}.
  assert.match(generated(component('let closed = true;\n  function open() { closed = false; }', '<div on:click={open}><p hidden={closed}>x</p></div>')), /__wizzAttr\(__wizzTarget_\d+, "hidden", closed, 1\)/);
  // Nested {#if} inside {:else} for chains.
  assert.equal(compileCode(component('let a = 1;', '<div>{#if a === 1}<b>a</b>{:else}{#if a === 2}<i>b</i>{:else}<u>c</u>{/if}{/if}</div>')), null);
  // Reassigning the collection.
  assert.match(generated(component('let xs = [];\n  function add() { xs = [...xs, 1]; }', '<ul on:click={add}>{#each xs as x}<li>{x}</li>{/each}</ul>')), /__wizzQueueUpdate\(\{ xs: true \}\)/);
  // A per-row inline arrow reading the item when it runs (issue #70).
  const rowHandler = generated(component("let rows = [];\n  let picked = '';\n  function pick(id) { picked = id; }", '<ul>{#each rows as row (row.id)}<li class={row.cls}><button on:click={() => pick(row.id)}>{row.name}</button></li>{/each}</ul>'));
  assert.match(rowHandler, /__wizzOn\([^,]+, "click", \(\) => pick\(row\.id\)\)/);
  assert.match(rowHandler, /update\(__wizzItem\) \{\n\s+row = __wizzItem;/);
  // Whole-value attribute expression.
  assert.equal(compileCode(component('let kind = "x";', "<div class={'card ' + kind}></div>")), null);
  // Two-way input through an inline arrow, and through a named setter.
  assert.match(generated(component('let name = "";', '<input value={name} on:input={(e) => name = e.target.value} />')), /\(e\) => \{ name = e\.target\.value; __wizzQueueUpdate\(\{ name: true \}\); \}/);
  assert.match(generated(component('let name = "";\n  function setName(e) { name = e.target.value; }', '<input value={name} on:input={setName} />')), /function setName\(e\) \{ name = e\.target\.value; __wizzQueueUpdate\(\{ name: true \}\);/);
  // Callback props instead of on: on a component tag.
  assert.match(generated(component("  import Card from './Card.wizz';\n  function select() {}", '<div><Card onSelect={select} /></div>')), /"onSelect": select/);
});

// --- Untracked-assignment warnings (issue #73) ---

const WARNING_SOURCE = '<script>\nlet count = 0;\nfunction bump() { g(count += 1); }\nfunction g() {}\n</script><main on:click={bump}>{count}</main>';

test('component_diagnostics reports warnings without failing ok', async () => {
  const root = createProjectFixture();
  const registry = createRegistry(root);
  const { structured, text } = await registry.call('component_diagnostics', { source: WARNING_SOURCE, path: 'src/Bump.wizz' });
  assert.equal(structured.ok, true);
  assert.deepEqual(structured.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.severity, diagnostic.line]), [['WIZZ-G026', 'warning', 3]]);
  assert.match(text, /^src\/Bump\.wizz: 1 diagnostic\(s\), 1 warning\(s\)\n/);
  assert.match(text, /WIZZ-G026 \[warning\] src\/Bump\.wizz:3:21/);

  // A clean source still reads as clean.
  const clean = await registry.call('component_diagnostics', { source: '<main>x</main>' });
  assert.match(clean.text, /^inline\.wizz: no diagnostics\n/);

  // The project-wide mode lists files with warnings and keeps ok.
  fs.writeFileSync(path.join(root, 'src', 'Bump.wizz'), WARNING_SOURCE);
  const all = await registry.call('component_diagnostics', { all: true });
  assert.equal(all.structured.ok, true);
  assert.match(all.text, /all clean; some with warnings/);
  assert.match(all.text, /Bump\.wizz:\nWIZZ-G026 \[warning\]/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('create_or_update_component writes a component with warnings and reports them', async () => {
  const root = createProjectFixture();
  const registry = createRegistry(root, true);
  const created = await registry.call('create_or_update_component', { path: 'src/Bump.wizz', source: WARNING_SOURCE });
  assert.equal(created.structured.action, 'created');
  assert.equal(fs.readFileSync(path.join(root, 'src', 'Bump.wizz'), 'utf8'), WARNING_SOURCE);
  assert.deepEqual(created.structured.diagnostics.map((diagnostic) => diagnostic.code), ['WIZZ-G026']);
  assert.match(created.text, /^Created src\/Bump\.wizz\.\nWIZZ-G026 \[warning\]/);
  fs.rmSync(root, { recursive: true, force: true });
});

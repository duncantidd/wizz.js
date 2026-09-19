const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const {
  BUILD_DIAGNOSTICS_FORMAT,
  buildProject,
  copyRuntimeModules,
  discoverWizzFiles,
  getOutputPath,
  getRoutePath,
  validateRouteEntries,
  main,
  parseBuildArguments
} = require('./build');

function createTemporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-build-test-'));
}

function writeFile(filePath, contents = '') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, 'utf8');
}

function createLogger() {
  return {
    messages: [],
    errors: [],
    log(message) {
      this.messages.push(message);
    },
    error(message) {
      this.errors.push(message);
    }
  };
}

test('accepts input and output directory arguments in order', () => {
  const argumentsResult = parseBuildArguments(['src', 'dist']);

  assert.deepEqual(argumentsResult, {
    inputDirectory: 'src',
    outputDirectory: 'dist',
    json: false
  });
});

test('preserves absolute and nested directory arguments', () => {
  const argumentsResult = parseBuildArguments([
    '/projects/example/src',
    'build/generated/components'
  ]);

  assert.deepEqual(argumentsResult, {
    inputDirectory: '/projects/example/src',
    outputDirectory: 'build/generated/components',
    json: false
  });
});

test('recognizes --json in any argument position', () => {
  assert.equal(parseBuildArguments(['--json', 'src', 'dist']).json, true);
  assert.equal(parseBuildArguments(['src', 'dist', '--json']).json, true);
  assert.equal(parseBuildArguments(['src', '--json', 'dist']).json, true);
  assert.throws(() => parseBuildArguments(['src', 'dist', '--json', 'extra']), /Usage/);
  assert.throws(() => parseBuildArguments(['--json']), /Usage/);
});

test('rejects missing directory arguments with usage guidance', () => {
  assert.throws(
    () => parseBuildArguments([]),
    /Usage: node build\.js <input-directory> <output-directory>/
  );
  assert.throws(
    () => parseBuildArguments(['src']),
    /Usage: node build\.js <input-directory> <output-directory>/
  );
});

test('rejects extra directory arguments with usage guidance', () => {
  assert.throws(
    () => parseBuildArguments(['src', 'dist', 'unexpected']),
    /Usage: node build\.js <input-directory> <output-directory>/
  );
});

test('rejects a non-array argument collection', () => {
  assert.throws(
    () => parseBuildArguments('src dist'),
    /Build arguments must be an array\./
  );
  assert.throws(
    () => parseBuildArguments(null),
    /Build arguments must be an array\./
  );
});

test('recursively discovers .wizz files in deterministic path order', (t) => {
  const inputDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(inputDirectory, { recursive: true, force: true }));

  const expectedFiles = [
    path.join(inputDirectory, 'App.wizz'),
    path.join(inputDirectory, 'components', 'Button.wizz'),
    path.join(inputDirectory, 'components', 'forms', 'Input.wizz'),
    path.join(inputDirectory, 'pages', 'Home.wizz')
  ];

  for (const filePath of expectedFiles) {
    writeFile(filePath, '<main></main>');
  }

  writeFile(path.join(inputDirectory, 'README.md'));
  writeFile(path.join(inputDirectory, 'components', 'Button.js'));
  writeFile(path.join(inputDirectory, 'components', 'forms', 'Input.wizz.bak'));
  fs.mkdirSync(path.join(inputDirectory, 'ignored.wizz'));

  assert.deepEqual(discoverWizzFiles(inputDirectory), expectedFiles);
});

test('returns no files when an input directory contains no .wizz files', (t) => {
  const inputDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(inputDirectory, { recursive: true, force: true }));

  writeFile(path.join(inputDirectory, 'README.md'));
  writeFile(path.join(inputDirectory, 'nested', 'component.js'));

  assert.deepEqual(discoverWizzFiles(inputDirectory), []);
});

test('maps a root component from the input directory into the output directory', () => {
  const inputDirectory = path.join(path.sep, 'projects', 'example', 'src');
  const outputDirectory = path.join(path.sep, 'projects', 'example', 'dist');

  assert.equal(
    getOutputPath(inputDirectory, outputDirectory, path.join(inputDirectory, 'App.wizz')),
    path.join(outputDirectory, 'App.js')
  );
});

test('preserves nested paths and replaces only the final .wizz extension', () => {
  const inputDirectory = path.join(path.sep, 'projects', 'example', 'src');
  const outputDirectory = path.join(path.sep, 'projects', 'example', 'dist');

  assert.equal(
    getOutputPath(
      inputDirectory,
      outputDirectory,
      path.join(inputDirectory, 'pages', 'admin.v2', 'Home.wizz')
    ),
    path.join(outputDirectory, 'pages', 'admin.v2', 'Home.js')
  );
});

test('maps page files to lowercase browser route paths', () => {
  const inputDirectory = path.join(path.sep, 'projects', 'example', 'src');

  assert.equal(getRoutePath(inputDirectory, path.join(inputDirectory, 'App.wizz')), '/');
  assert.equal(getRoutePath(inputDirectory, path.join(inputDirectory, 'pages', 'index.wizz')), '/');
  assert.equal(getRoutePath(inputDirectory, path.join(inputDirectory, 'pages', 'Home.wizz')), '/home');
  assert.equal(getRoutePath(inputDirectory, path.join(inputDirectory, 'pages', 'Admin', 'Users.wizz')), '/admin/users');
  assert.equal(getRoutePath(inputDirectory, path.join(inputDirectory, 'pages', 'Docs', 'index.wizz')), '/docs');
  assert.equal(getRoutePath(inputDirectory, path.join(inputDirectory, 'components', 'Card.wizz')), null);
});

test('rejects duplicate normalized routes with both component paths', () => {
  assert.throws(
    () => validateRouteEntries([
      { inputPath: '/project/src/pages/Home.wizz', filePath: 'pages/Home.wizz', routePath: '/home' },
      { inputPath: '/project/src/pages/home.wizz', filePath: 'pages/home.wizz', routePath: '/home' }
    ]),
    (error) => error.filePath === '/project/src/pages/home.wizz'
      && error.message === "Ambiguous route '/home' is claimed by pages/Home.wizz and pages/home.wizz"
  );
});

test('rejects runtime-reserved routes with the claiming component path', () => {
  assert.throws(
    () => validateRouteEntries([
      { inputPath: '/project/src/pages/runtime/Status.wizz', filePath: 'pages/runtime/Status.wizz', routePath: '/runtime/status' }
    ]),
    (error) => error.filePath === '/project/src/pages/runtime/Status.wizz'
      && error.message === "Route '/runtime/status' is reserved for Wizz runtime files: pages/runtime/Status.wizz"
  );
});

test('rejects colliding page routes before writing a route manifest', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  const inputDirectory = path.join(projectDirectory, 'src');
  const outputDirectory = path.join(projectDirectory, 'dist');
  const conflictingPage = path.join(inputDirectory, 'pages', 'home.wizz');
  writeFile(path.join(inputDirectory, 'pages', 'Home.wizz'), '<main>One</main>');
  writeFile(conflictingPage, '<main>Two</main>');

  assert.throws(
    () => buildProject(inputDirectory, outputDirectory, createLogger()),
    (error) => (error.filePath === conflictingPage || error.filePath === path.join(inputDirectory, 'pages', 'Home.wizz'))
      && error.message.startsWith("Ambiguous route '/home' is claimed by")
      && error.message.includes('pages/Home.wizz')
      && error.message.includes('pages/home.wizz')
  );
  assert.equal(fs.existsSync(path.join(outputDirectory, 'runtime', 'routes.js')), false);
});

test('rejects paths outside the input directory', () => {
  const inputDirectory = path.join(path.sep, 'projects', 'example', 'src');
  const outputDirectory = path.join(path.sep, 'projects', 'example', 'dist');

  assert.throws(
    () => getOutputPath(inputDirectory, outputDirectory, path.join(path.sep, 'projects', 'example', 'Other.wizz')),
    /Input file must be inside the input directory/
  );
});

test('rejects inputs that are not .wizz files', () => {
  const inputDirectory = path.join(path.sep, 'projects', 'example', 'src');
  const outputDirectory = path.join(path.sep, 'projects', 'example', 'dist');

  assert.throws(
    () => getOutputPath(inputDirectory, outputDirectory, path.join(inputDirectory, 'App.wizz.bak')),
    /Input file must have a \.wizz extension/
  );
});

test('builds nested components into missing output directories', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));

  const inputDirectory = path.join(projectDirectory, 'src');
  const outputDirectory = path.join(projectDirectory, 'dist');
  writeFile(path.join(inputDirectory, 'App.wizz'), '<main><p>App</p></main>');
  writeFile(
    path.join(inputDirectory, 'pages', 'Home.wizz'),
    '<script>let count = 0;</script><main><p>{count}</p></main>'
  );
  writeFile(path.join(inputDirectory, 'pages', 'ignored.js'), 'export default null;');

  const logger = createLogger();
  const result = buildProject(inputDirectory, outputDirectory, logger);

  assert.deepEqual(result, { compiledCount: 2, failedCount: 0 });
  // Built artifacts self-identify the compiler and contract versions that produced them.
  assert.match(
    fs.readFileSync(path.join(outputDirectory, 'App.js'), 'utf8'),
    /^\/\/ Generated by Wizz \d+\.\d+\.\d+ \(component syntax \d+\.\d+\.\d+, generated output \d+\.\d+\.\d+\)/m
  );
  assert.match(
    fs.readFileSync(path.join(outputDirectory, 'App.js'), 'utf8'),
    /^export default function mountComponent\(target, props = \{\}\)/m
  );
  assert.equal(fs.existsSync(path.join(outputDirectory, 'App.js.map')), false);
  assert.match(
    fs.readFileSync(path.join(outputDirectory, 'pages', 'Home.js'), 'utf8'),
    /^export default function mountComponent\(target, props = \{\}\)/m
  );
  const homeSourceMap = JSON.parse(fs.readFileSync(path.join(outputDirectory, 'pages', 'Home.js.map'), 'utf8'));
  assert.equal(homeSourceMap.file, 'Home.js');
  assert.deepEqual(homeSourceMap.sources, [path.join(inputDirectory, 'pages', 'Home.wizz')]);
  assert.equal(homeSourceMap.sourcesContent[0], '<script>let count = 0;</script><main><p>{count}</p></main>');
  assert.match(
    fs.readFileSync(path.join(outputDirectory, 'pages', 'Home.js'), 'utf8'),
    /\/\/# sourceMappingURL=Home\.js\.map$/
  );
  assert.equal(fs.existsSync(path.join(outputDirectory, 'pages', 'ignored.js')), false);
  // Eligible route pages ship their server and hydratable builds beside the
  // client module; the manifest advertises both so the dev server and the
  // runtime can find them without filesystem probing.
  for (const moduleName of ['App', 'pages/Home']) {
    assert.match(
      fs.readFileSync(path.join(outputDirectory, `${moduleName}.js`), 'utf8'),
      /^export default function mountComponent\(target, props = \{\}\)/m
    );
    assert.match(
      fs.readFileSync(path.join(outputDirectory, `${moduleName}.server.js`), 'utf8'),
      /^export function renderComponent\(props = \{\}\)/m
    );
    assert.equal(fs.existsSync(path.join(outputDirectory, `${moduleName}.server.js.map`)), false);
    assert.match(
      fs.readFileSync(path.join(outputDirectory, `${moduleName}.hydrate.js`), 'utf8'),
      /^export function hydrateComponent\(target, props = \{\}, state = null\)/m
    );
  }
  // Source-map presence mirrors the client build: reactive pages get one,
  // static pages (no source-map markers) do not.
  const homeHydrateSourceMap = JSON.parse(fs.readFileSync(path.join(outputDirectory, 'pages', 'Home.hydrate.js.map'), 'utf8'));
  assert.equal(homeHydrateSourceMap.file, 'Home.hydrate.js');
  assert.match(
    fs.readFileSync(path.join(outputDirectory, 'pages', 'Home.hydrate.js'), 'utf8'),
    /\/\/# sourceMappingURL=Home\.hydrate\.js\.map$/
  );
  assert.equal(fs.existsSync(path.join(outputDirectory, 'App.hydrate.js.map')), false);
  assert.deepEqual(
    fs.readFileSync(path.join(outputDirectory, 'runtime', 'routes.js'), 'utf8'),
    [
      '// Generated by Wizz. Edits will be overwritten.',
      'export const pageModules = [',
      '  {',
      '    "filePath": "App.wizz",',
      '    "modulePath": "../App.js",',
      '    "routePath": "/",',
      '    "serverModulePath": "../App.server.js",',
      '    "hydratableModulePath": "../App.hydrate.js"',
      '  },',
      '  {',
      '    "filePath": "pages/Home.wizz",',
      '    "modulePath": "../pages/Home.js",',
      '    "routePath": "/home",',
      '    "serverModulePath": "../pages/Home.server.js",',
      '    "hydratableModulePath": "../pages/Home.hydrate.js"',
      '  }',
      '];',
      ''
    ].join('\n')
  );
  assert.equal(
    fs.readFileSync(path.join(outputDirectory, 'runtime', 'main.js'), 'utf8'),
    fs.readFileSync(path.join(__dirname, 'src', 'runtime', 'main.js'), 'utf8')
  );
  assert.equal(logger.errors.length, 0);
});

test('emits the App root route when the project has no pages directory', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  const inputDirectory = path.join(projectDirectory, 'src');
  const outputDirectory = path.join(projectDirectory, 'dist');
  writeFile(path.join(inputDirectory, 'App.wizz'), '<main><p>App</p></main>');

  buildProject(inputDirectory, outputDirectory, createLogger());

  assert.equal(
    fs.readFileSync(path.join(outputDirectory, 'runtime', 'routes.js'), 'utf8'),
    [
      '// Generated by Wizz. Edits will be overwritten.',
      'export const pageModules = [',
      '  {',
      '    "filePath": "App.wizz",',
      '    "modulePath": "../App.js",',
      '    "routePath": "/",',
      '    "serverModulePath": "../App.server.js",',
      '    "hydratableModulePath": "../App.hydrate.js"',
      '  }',
      '];',
      ''
    ].join('\n')
  );
});

test('keeps pages whose imported component fails the gate client-only, chaining the deepest reason', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  const inputDirectory = path.join(projectDirectory, 'src');
  const outputDirectory = path.join(projectDirectory, 'dist');
  // The imported component itself has an unvouched import (its own child
  // build does not exist), which keeps the importing page client-only too;
  // the note chains the child's own gate failure as the underlying reason.
  writeFile(
    path.join(inputDirectory, 'pages', 'Static.wizz'),
    '<script>\nimport Counter from "../components/Counter.wizz";\n</script><main><Counter /></main>'
  );
  writeFile(
    path.join(inputDirectory, 'components', 'Counter.wizz'),
    '<script>\nimport Ghost from "./Ghost.wizz";\n</script><div><Ghost /></div>'
  );

  const logger = createLogger();
  const result = buildProject(inputDirectory, outputDirectory, logger);

  // Ineligibility is not a build failure: the client modules compile, only
  // the server targets reject the surface.
  assert.deepEqual(result, { compiledCount: 2, failedCount: 0 });
  assert.match(
    fs.readFileSync(path.join(outputDirectory, 'pages', 'Static.js'), 'utf8'),
    /^export default function mountComponent\(target, props = \{\}\)/m
  );
  assert.equal(fs.existsSync(path.join(outputDirectory, 'pages', 'Static.server.js')), false);
  assert.equal(fs.existsSync(path.join(outputDirectory, 'pages', 'Static.hydrate.js')), false);
  // The ineligible child ships client-only as well.
  assert.equal(fs.existsSync(path.join(outputDirectory, 'components', 'Counter.server.js')), false);
  assert.equal(fs.existsSync(path.join(outputDirectory, 'components', 'Counter.hydrate.js')), false);
  assert.equal(
    fs.readFileSync(path.join(outputDirectory, 'runtime', 'routes.js'), 'utf8'),
    [
      '// Generated by Wizz. Edits will be overwritten.',
      'export const pageModules = [',
      '  {',
      '    "filePath": "pages/Static.wizz",',
      '    "modulePath": "../pages/Static.js",',
      '    "routePath": "/static",',
      '    "serverModulePath": null,',
      '    "hydratableModulePath": null',
      '  }',
      '];',
      ''
    ].join('\n')
  );
  assert.equal(logger.errors.length, 0);
  const notices = logger.messages.filter((message) => message.startsWith('Note: server rendering skipped for'));
  // Both files are ineligible and each reports its own reason.
  assert.equal(notices.length, 2);
  const pageNotice = notices.find((message) => message.includes(path.join('pages', 'Static.wizz')));
  const componentNotice = notices.find((message) => message.includes(path.join('components', 'Counter.wizz')));
  assert.ok(pageNotice && componentNotice);
  assert.match(pageNotice, /<Counter> cannot be rendered server-side at .*:\d+:\d+\./);
  // The page's reason chains the component's own failure, which chains the
  // missing grandchild build two levels deep.
  assert.match(pageNotice, /Underlying reason: Server rendering does not support component tags; <Ghost> cannot be rendered server-side at .*:\d+:\d+\./);
  assert.match(componentNotice, /<Ghost> cannot be rendered server-side at .*:\d+:\d+\./);
  assert.match(componentNotice, /No server-renderable build was provided for this import\./);
  assert.match(pageNotice, /Serving the client build only\.$/);
});

test('reports cyclic component imports as ineligibility instead of recursing forever', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  const inputDirectory = path.join(projectDirectory, 'src');
  const outputDirectory = path.join(projectDirectory, 'dist');
  writeFile(
    path.join(inputDirectory, 'components', 'A.wizz'),
    '<script>\nimport B from "./B.wizz";\n</script><div><B /></div>'
  );
  writeFile(
    path.join(inputDirectory, 'components', 'B.wizz'),
    '<script>\nimport A from "./A.wizz";\n</script><div><A /></div>'
  );

  const logger = createLogger();
  const result = buildProject(inputDirectory, outputDirectory, logger);

  // The cycle is a server-rendering ineligibility, not a client build failure.
  assert.deepEqual(result, { compiledCount: 2, failedCount: 0 });
  assert.equal(fs.existsSync(path.join(outputDirectory, 'components', 'A.server.js')), false);
  assert.equal(fs.existsSync(path.join(outputDirectory, 'components', 'B.server.js')), false);
  const notices = logger.messages.filter((message) => message.startsWith('Note: server rendering skipped for'));
  assert.equal(notices.length, 2);
  assert.match(notices[0], /Underlying reason: its import graph contains a cycle\./);
  assert.match(notices[1], /Underlying reason: its import graph contains a cycle\./);
});

test('ships server builds for eligible component files so importing pages can render them', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  const inputDirectory = path.join(projectDirectory, 'src');
  const outputDirectory = path.join(projectDirectory, 'dist');
  writeFile(path.join(inputDirectory, 'App.wizz'), '<main><p>App</p></main>');
  writeFile(path.join(inputDirectory, 'components', 'Nav.wizz'), '<nav><p>Nav</p></nav>');

  buildProject(inputDirectory, outputDirectory, createLogger());

  // An eligible non-route component ships its server and hydratable builds
  // beside the client module: a page's server module imports them.
  assert.equal(fs.existsSync(path.join(outputDirectory, 'components', 'Nav.js')), true);
  assert.match(
    fs.readFileSync(path.join(outputDirectory, 'components', 'Nav.server.js'), 'utf8'),
    /^export function renderComponent\(props = \{\}\)/m
  );
  assert.match(
    fs.readFileSync(path.join(outputDirectory, 'components', 'Nav.hydrate.js'), 'utf8'),
    /^export function hydrateComponent\(target, props = \{\}, state = null\)/m
  );
  // Components are never routes, so the manifest still excludes them.
  assert.doesNotMatch(
    fs.readFileSync(path.join(outputDirectory, 'runtime', 'routes.js'), 'utf8'),
    /Nav/
  );
});

test('vouches an eligible import graph so a component-importing page server-renders', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  const inputDirectory = path.join(projectDirectory, 'src');
  const outputDirectory = path.join(projectDirectory, 'dist');
  // Counter is fully server-renderable, so the page rendering it is eligible
  // through the import graph: the build vouches for the child and both files
  // ship server builds.
  writeFile(
    path.join(inputDirectory, 'pages', 'Static.wizz'),
    '<script>\nimport Counter from "../components/Counter.wizz";\n</script><main><Counter /></main>'
  );
  writeFile(
    path.join(inputDirectory, 'components', 'Counter.wizz'),
    '<script>let count = 0;</script><div><button>Clicks: {count}</button></div>'
  );

  const logger = createLogger();
  const result = buildProject(inputDirectory, outputDirectory, logger);

  assert.deepEqual(result, { compiledCount: 2, failedCount: 0 });
  assert.equal(logger.errors.length, 0);
  assert.equal(logger.messages.filter((message) => message.startsWith('Note: server rendering skipped for')).length, 0);
  assert.match(
    fs.readFileSync(path.join(outputDirectory, 'pages', 'Static.server.js'), 'utf8'),
    /^import \* as __wizzServer_Counter from "\.\.\/components\/Counter\.server\.js";/m
  );
  assert.match(
    fs.readFileSync(path.join(outputDirectory, 'components', 'Counter.server.js'), 'utf8'),
    /^export function renderComponent\(props = \{\}\)/m
  );
  assert.match(
    fs.readFileSync(path.join(outputDirectory, 'pages', 'Static.hydrate.js'), 'utf8'),
    /^import \* as __wizzHydrate_Counter from "\.\.\/components\/Counter\.hydrate\.js";/m
  );
  assert.equal(
    fs.readFileSync(path.join(outputDirectory, 'runtime', 'routes.js'), 'utf8'),
    [
      '// Generated by Wizz. Edits will be overwritten.',
      'export const pageModules = [',
      '  {',
      '    "filePath": "pages/Static.wizz",',
      '    "modulePath": "../pages/Static.js",',
      '    "routePath": "/static",',
      '    "serverModulePath": "../pages/Static.server.js",',
      '    "hydratableModulePath": "../pages/Static.hydrate.js"',
      '  }',
      '];',
      ''
    ].join('\n')
  );
});

test('removes a deleted page from the route manifest after a rebuild', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  const inputDirectory = path.join(projectDirectory, 'src');
  const outputDirectory = path.join(projectDirectory, 'dist');
  const removedPage = path.join(inputDirectory, 'pages', 'Archive.wizz');
  writeFile(path.join(inputDirectory, 'App.wizz'), '<main>App</main>');
  writeFile(removedPage, '<main>Archive</main>');

  buildProject(inputDirectory, outputDirectory, createLogger());
  assert.match(fs.readFileSync(path.join(outputDirectory, 'runtime', 'routes.js'), 'utf8'), /"routePath": "\/archive"/);

  fs.rmSync(removedPage);
  buildProject(inputDirectory, outputDirectory, createLogger());
  assert.doesNotMatch(fs.readFileSync(path.join(outputDirectory, 'runtime', 'routes.js'), 'utf8'), /archive/i);
});

test('continues after invalid components and reports every failure with its path', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));

  const inputDirectory = path.join(projectDirectory, 'src');
  const outputDirectory = path.join(projectDirectory, 'dist');
  const invalidPath = path.join(inputDirectory, 'pages', 'Broken.wizz');
  const validPath = path.join(inputDirectory, 'pages', 'Home.wizz');
  writeFile(invalidPath, '<main><p>Broken</main>');
  writeFile(validPath, '<main><p>Home</p></main>');

  const logger = createLogger();
  const result = buildProject(inputDirectory, outputDirectory, logger);

  assert.deepEqual(result, { compiledCount: 1, failedCount: 1 });
  assert.equal(fs.existsSync(path.join(outputDirectory, 'pages', 'Broken.js')), false);
  assert.match(
    fs.readFileSync(path.join(outputDirectory, 'pages', 'Home.js'), 'utf8'),
    /^export default function mountComponent\(target, props = \{\}\)/m
  );
  assert.equal(logger.errors.length, 1);
  assert.match(logger.errors[0], new RegExp(`Compilation failed for ${invalidPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`));
  assert.match(logger.errors[0], /Mismatched closing tag|Unclosed tag/);
  assert.match(logger.errors[0], new RegExp(`${invalidPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:1:16`));
  assert.match(logger.errors[0], /1 \| <main><p>Broken<\/main>\n  \|                \^/);
});

test('rejects a missing input directory and identical input and output directories', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));

  const inputDirectory = path.join(projectDirectory, 'src');
  fs.mkdirSync(inputDirectory);

  assert.throws(
    () => buildProject(path.join(projectDirectory, 'missing'), path.join(projectDirectory, 'dist')),
    /Input directory does not exist or is not a directory/
  );
  assert.throws(
    () => buildProject(inputDirectory, inputDirectory),
    /Input and output directories must be different\./
  );
});

test('returns a non-zero status when one or more project components fail', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));

  const inputDirectory = path.join(projectDirectory, 'src');
  const outputDirectory = path.join(projectDirectory, 'dist');
  writeFile(path.join(inputDirectory, 'Broken.wizz'), '<main><p>Broken</main>');

  assert.equal(main([inputDirectory, outputDirectory], createLogger()), 1);
});

test('the CLI sets a non-zero exit code when compilation fails', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));

  const inputDirectory = path.join(projectDirectory, 'src');
  writeFile(path.join(inputDirectory, 'Broken.wizz'), '<main><p>Broken</main>');

  const result = spawnSync(process.execPath, [
    path.join(__dirname, 'build.js'),
    inputDirectory,
    path.join(projectDirectory, 'dist')
  ], { encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Compilation failed for .*Broken\.wizz:/);
});

test('copies runtime modules without requiring component files', (t) => {
  const outputDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));

  copyRuntimeModules(outputDirectory);

  assert.equal(
    fs.readFileSync(path.join(outputDirectory, 'runtime', 'main.js'), 'utf8'),
    fs.readFileSync(path.join(__dirname, 'src', 'runtime', 'main.js'), 'utf8')
  );
});
test('extracts styled component rules into app.css linked from the copied shell', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));

  const inputDirectory = path.join(projectDirectory, 'src');
  const outputDirectory = path.join(projectDirectory, 'dist');
  // The motivating case: two components on one page with conflicting h2
  // rules, plus an @media block and a @keyframes rule to prove the extracted
  // CSS is scoped exactly like the injected <style> tags are.
  writeFile(
    path.join(inputDirectory, 'components', 'Card.wizz'),
    '<div><h2>Card title</h2></div><wizz:style>h2 { font-size: 24px } @media (min-width: 600px) { h2 { font-size: 28px } }</wizz:style>'
  );
  writeFile(
    path.join(inputDirectory, 'components', 'Panel.wizz'),
    '<div><h2>Panel title</h2></div><wizz:style>h2 { font-size: 30px }\n@keyframes panel-in { from { opacity: 0 } }</wizz:style>'
  );
  writeFile(
    path.join(inputDirectory, 'pages', 'Home.wizz'),
    '<script>import Card from "../components/Card.wizz";\nimport Panel from "../components/Panel.wizz";</script><main><Card /><Panel /><h2>Page heading</h2></main>'
  );
  writeFile(path.join(inputDirectory, 'index.html'), [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '  <title>Showcase</title>',
    '</head>',
    '<body>',
    '  <div id="app"></div>',
    '</body>',
    '</html>',
    ''
  ].join('\n'));

  buildProject(inputDirectory, outputDirectory, createLogger());

  const stylesheet = fs.readFileSync(path.join(outputDirectory, 'app.css'), 'utf8');
  // Discovery order: components sort before pages, so Card precedes Panel;
  // each block carries its source file header.
  // The scanner preserves the author's formatting verbatim; only the
  // selectors and keyframe names are rewritten.
  assert.match(stylesheet, /\/\* components\/Card\.wizz \*\/\nh2\[data-wizz-s="[a-z0-9]+"\] \{ font-size: 24px \} @media \(min-width: 600px\) \{ h2\[data-wizz-s="[a-z0-9]+"\] \{ font-size: 28px \} \}/);
  assert.match(stylesheet, /\/\* components\/Panel\.wizz \*\/\nh2\[data-wizz-s="[a-z0-9]+"\] \{ font-size: 30px \}\n@keyframes panel-in-[a-z0-9]+ \{ from \{ opacity: 0 \} \}/);
  // The two conflicting h2 rules scope to different attributes.
  const scopes = [...stylesheet.matchAll(/h2\[data-wizz-s="([^"]+)"\]/g)].map((match) => match[1]);
  assert.equal(new Set(scopes).size, 2);
  assert.equal(scopes.length, 3); // Card twice (base + media), Panel once

  // The copied shell links the stylesheet before </head>.
  const shell = fs.readFileSync(path.join(outputDirectory, 'index.html'), 'utf8');
  const linkIndex = shell.indexOf('<link rel="stylesheet" href="/app.css">');
  assert.ok(linkIndex !== -1, 'shell should link app.css');
  assert.ok(linkIndex < shell.indexOf('</head>'), 'link should come before </head>');
  assert.ok(shell.includes('<title>Showcase</title>'), 'shell content is preserved');
  assert.ok(shell.includes('<div id="app"></div>'), 'mount point is preserved');
});

test('copies the document shell verbatim when no component has styles', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));

  const inputDirectory = path.join(projectDirectory, 'src');
  const outputDirectory = path.join(projectDirectory, 'dist');
  writeFile(path.join(inputDirectory, 'App.wizz'), '<main><p>App</p></main>');
  const shell = '<!DOCTYPE html>\n<html><head><title>Plain</title></head><body><div id="app"></div></body></html>';
  writeFile(path.join(inputDirectory, 'index.html'), shell);

  buildProject(inputDirectory, outputDirectory, createLogger());

  assert.equal(fs.existsSync(path.join(outputDirectory, 'app.css')), false);
  assert.equal(fs.readFileSync(path.join(outputDirectory, 'index.html'), 'utf8'), shell);
});

test('leaves an already-linked app.css reference alone', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));

  const inputDirectory = path.join(projectDirectory, 'src');
  const outputDirectory = path.join(projectDirectory, 'dist');
  writeFile(
    path.join(inputDirectory, 'App.wizz'),
    '<main><p>App</p></main><wizz:style>main { padding: 0 }</wizz:style>'
  );
  const shell = '<!DOCTYPE html>\n<html><head><link rel="stylesheet" href="/app.css"></head><body><div id="app"></div></body></html>';
  writeFile(path.join(inputDirectory, 'index.html'), shell);

  buildProject(inputDirectory, outputDirectory, createLogger());

  // The stylesheet is still extracted, but the author's own link stands.
  assert.match(fs.readFileSync(path.join(outputDirectory, 'app.css'), 'utf8'), /main\[data-wizz-s="[a-z0-9]+"\]/);
  const builtShell = fs.readFileSync(path.join(outputDirectory, 'index.html'), 'utf8');
  assert.equal(builtShell.split('/app.css').length - 1, 1); // the author's own link, unmodified
  assert.equal((builtShell.match(/<link /g) || []).length, 1);
});

test('builds styled components without a document shell', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));

  const inputDirectory = path.join(projectDirectory, 'src');
  const outputDirectory = path.join(projectDirectory, 'dist');
  writeFile(
    path.join(inputDirectory, 'App.wizz'),
    '<main><p>App</p></main><wizz:style>main { padding: 0 }</wizz:style>'
  );

  const logger = createLogger();
  const result = buildProject(inputDirectory, outputDirectory, logger);

  // Existing behavior is preserved: no shell at the input root is not an
  // error, and the dev server reports the missing shell at serve time.
  assert.deepEqual(result, { compiledCount: 1, failedCount: 0 });
  assert.match(fs.readFileSync(path.join(outputDirectory, 'app.css'), 'utf8'), /main\[data-wizz-s="[a-z0-9]+"\]/);
  assert.equal(fs.existsSync(path.join(outputDirectory, 'index.html')), false);
  assert.match(logger.messages.join('\n'), /no index\.html document shell was found/);
});

test('finds the document shell at the project root for the src layout', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));

  // The conventional layout: components in src/, index.html at the root.
  const inputDirectory = path.join(projectDirectory, 'src');
  const outputDirectory = path.join(projectDirectory, 'dist');
  writeFile(
    path.join(inputDirectory, 'App.wizz'),
    '<main><p>App</p></main><wizz:style>p { margin: 0 }</wizz:style>'
  );
  writeFile(path.join(projectDirectory, 'index.html'), '<!DOCTYPE html>\n<html><head></head><body><div id="app"></div></body></html>');

  const logger = createLogger();
  buildProject(inputDirectory, outputDirectory, logger);

  const shell = fs.readFileSync(path.join(outputDirectory, 'index.html'), 'utf8');
  assert.match(shell, /<link rel="stylesheet" href="\/app\.css">/);
  assert.equal(logger.messages.filter((message) => message.includes('document shell')).length, 0);
});

test('threads moduleQuery into child server import specifiers', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));

  const inputDirectory = path.join(projectDirectory, 'src');
  const outputDirectory = path.join(projectDirectory, 'dist');
  writeFile(path.join(inputDirectory, 'Card.wizz'), '<article><h2>Card</h2></article>');
  writeFile(
    path.join(inputDirectory, 'App.wizz'),
    '<script>import Card from "./Card.wizz";</script><main><Card /></main>'
  );

  buildProject(inputDirectory, outputDirectory, createLogger(), { moduleQuery: '?v=42-1' });

  const appServer = fs.readFileSync(path.join(outputDirectory, 'App.server.js'), 'utf8');
  assert.match(appServer, /^import \* as __wizzServer_Card from "\.\/Card\.server\.js\?v=42-1";$/m);
  // The child module itself receives the option too, though it renders no
  // component tags and therefore emits no imports.
  const cardServer = fs.readFileSync(path.join(outputDirectory, 'Card.server.js'), 'utf8');
  assert.doesNotMatch(cardServer, /^import \* as __wizzServer_/m);
});

test('pins the output directory as ES modules for Node-side imports', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));

  const inputDirectory = path.join(projectDirectory, 'src');
  const outputDirectory = path.join(projectDirectory, 'dist');
  writeFile(path.join(inputDirectory, 'App.wizz'), '<main><p>Ready</p></main>');

  buildProject(inputDirectory, outputDirectory, createLogger());

  // Node 18 has no module-syntax detection: without this marker, importing
  // the emitted server modules from a CommonJS application (the SSR recipe)
  // fails on it. The dev server makes the same import on every request.
  const markerPath = path.join(outputDirectory, 'package.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(markerPath, 'utf8')), { type: 'module' });
});

test('a package.json already present in the output directory is respected', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));

  const inputDirectory = path.join(projectDirectory, 'src');
  const outputDirectory = path.join(projectDirectory, 'dist');
  writeFile(path.join(inputDirectory, 'App.wizz'), '<main><p>Ready</p></main>');
  writeFile(path.join(outputDirectory, 'package.json'), '{"type":"commonjs","name":"embedder-dist"}');

  buildProject(inputDirectory, outputDirectory, createLogger());

  // The embedding project may have placed it deliberately; a build is an
  // overwrite of Wizz's own artifacts, not of the output directory's owner.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outputDirectory, 'package.json'), 'utf8')), {
    type: 'commonjs',
    name: 'embedder-dist'
  });
});

test('the build --json envelope format string is versioned', () => {
  assert.equal(BUILD_DIAGNOSTICS_FORMAT, 'wizz-build-diagnostics@1');
});

test('the JSON build mode returns an envelope with per-file diagnostics', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));

  const inputDirectory = path.join(projectDirectory, 'src');
  const outputDirectory = path.join(projectDirectory, 'dist');
  writeFile(path.join(inputDirectory, 'App.wizz'), '<main><p>Ready</p></main>');
  writeFile(path.join(inputDirectory, 'Broken.wizz'), '<main><p>Broken</main>');

  const result = buildProject(inputDirectory, outputDirectory, createLogger(), { json: true });

  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.length, 1);
  assert.deepEqual(result.diagnostics[0], {
    code: 'WIZZ-P018',
    severity: 'error',
    message: 'Mismatched closing tag. Expected </p>, found </main> at Broken.wizz:1:16.',
    file: 'Broken.wizz',
    line: 1,
    column: 16
  });
  assert.deepEqual(result.files, [
    { file: 'App.wizz', serverRenderable: true },
    { file: 'Broken.wizz', serverRenderable: false }
  ]);
  // The envelope is a build result: artifacts are still written for the
  // files that compiled.
  assert.equal(fs.existsSync(path.join(outputDirectory, 'App.js')), true);
  assert.equal(fs.existsSync(path.join(outputDirectory, 'Broken.js')), false);
});

test('the JSON build mode returns an empty envelope for a clean build', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));

  const inputDirectory = path.join(projectDirectory, 'src');
  const outputDirectory = path.join(projectDirectory, 'dist');
  writeFile(path.join(inputDirectory, 'App.wizz'), '<main><p>Ready</p></main>');

  const result = buildProject(inputDirectory, outputDirectory, createLogger(), { json: true });

  assert.deepEqual(result, {
    compiledCount: 1,
    failedCount: 0,
    ok: true,
    diagnostics: [],
    files: [{ file: 'App.wizz', serverRenderable: true }]
  });
});

test('the JSON build mode turns build-level failures into envelope records', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));

  const inputDirectory = path.join(projectDirectory, 'src');
  const outputDirectory = path.join(projectDirectory, 'dist');
  // A route inside the reserved /runtime namespace makes the manifest
  // validation throw after the client builds have succeeded.
  writeFile(path.join(inputDirectory, 'pages', 'runtime', 'Status.wizz'), '<main><p>Up</p></main>');

  const result = buildProject(inputDirectory, outputDirectory, createLogger(), { json: true });

  assert.equal(result.ok, false);
  assert.equal(result.failedCount, 0);
  assert.deepEqual(result.diagnostics, [{
    code: null,
    severity: 'error',
    message: "Route '/runtime/status' is reserved for Wizz runtime files: pages/runtime/Status.wizz",
    file: 'pages/runtime/Status.wizz',
    line: null,
    column: null
  }]);
});

test('the JSON build mode reports build-level errors for unusable directories', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));

  const result = buildProject(
    path.join(projectDirectory, 'missing'),
    path.join(projectDirectory, 'dist'),
    createLogger(),
    { json: true }
  );

  assert.equal(result.ok, false);
  assert.deepEqual(result.diagnostics, [{
    code: null,
    severity: 'error',
    message: `Input directory does not exist or is not a directory: ${path.join(projectDirectory, 'missing')}`,
    file: null,
    line: null,
    column: null
  }]);
  assert.deepEqual(result.files, []);
});

test('the JSON build mode never throws for compile failures', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));

  const inputDirectory = path.join(projectDirectory, 'src');
  writeFile(path.join(inputDirectory, 'App.wizz'), '{/each}');

  const result = buildProject(inputDirectory, path.join(projectDirectory, 'dist'), createLogger(), { json: true });
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].code, 'WIZZ-P003');
});

test('main prints only the diagnostics envelope in JSON mode and exits non-zero on failure', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  writeFile(path.join(projectDirectory, 'src', 'App.wizz'), '<main><p>Ready</p></main>');
  writeFile(path.join(projectDirectory, 'src', 'Broken.wizz'), '<main><p>Broken</main>');

  const printed = [];
  const originalLog = console.log;
  console.log = (message) => printed.push(message);
  let exitCode;
  try {
    exitCode = main([path.join(projectDirectory, 'src'), path.join(projectDirectory, 'dist'), '--json']);
  } finally {
    console.log = originalLog;
  }

  assert.equal(exitCode, 1);
  assert.equal(printed.length, 1);
  const envelope = JSON.parse(printed[0]);
  assert.deepEqual(Object.keys(envelope), ['format', 'ok', 'diagnostics', 'files']);
  assert.equal(envelope.format, 'wizz-build-diagnostics@1');
  assert.equal(envelope.ok, false);
  assert.equal(envelope.diagnostics[0].code, 'WIZZ-P018');
  assert.equal(envelope.diagnostics[0].file, 'Broken.wizz');
  assert.deepEqual(envelope.files.map((entry) => entry.file), ['App.wizz', 'Broken.wizz']);
});

test('main prints only the diagnostics envelope in JSON mode and exits zero when clean', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  writeFile(path.join(projectDirectory, 'src', 'App.wizz'), '<main><p>Ready</p></main>');

  const printed = [];
  const originalLog = console.log;
  console.log = (message) => printed.push(message);
  let exitCode;
  try {
    exitCode = main(['--json', path.join(projectDirectory, 'src'), path.join(projectDirectory, 'dist')]);
  } finally {
    console.log = originalLog;
  }

  assert.equal(exitCode, 0);
  const envelope = JSON.parse(printed[0]);
  assert.equal(envelope.ok, true);
  assert.deepEqual(envelope.diagnostics, []);
  assert.deepEqual(envelope.files, [{ file: 'App.wizz', serverRenderable: true }]);
});

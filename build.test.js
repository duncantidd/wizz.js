const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const {
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
    outputDirectory: 'dist'
  });
});

test('preserves absolute and nested directory arguments', () => {
  const argumentsResult = parseBuildArguments([
    '/projects/example/src',
    'build/generated/components'
  ]);

  assert.deepEqual(argumentsResult, {
    inputDirectory: '/projects/example/src',
    outputDirectory: 'build/generated/components'
  });
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

test('keeps pages that fail the server-renderability gate client-only without failing the build', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  const inputDirectory = path.join(projectDirectory, 'src');
  const outputDirectory = path.join(projectDirectory, 'dist');
  // An import whose child has no vouched server build keeps the page
  // client-only; the note chains the unvouched-import reason.
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

  // Ineligibility is not a build failure: the client module compiles, only
  // the server target rejects the surface.
  assert.deepEqual(result, { compiledCount: 2, failedCount: 0 });
  assert.match(
    fs.readFileSync(path.join(outputDirectory, 'pages', 'Static.js'), 'utf8'),
    /^export default function mountComponent\(target, props = \{\}\)/m
  );
  assert.equal(fs.existsSync(path.join(outputDirectory, 'pages', 'Static.server.js')), false);
  assert.equal(fs.existsSync(path.join(outputDirectory, 'pages', 'Static.hydrate.js')), false);
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
  assert.equal(notices.length, 1);
  assert.match(notices[0], new RegExp(`Note: server rendering skipped for ${path.join(inputDirectory, 'pages', 'Static.wizz').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} —`));
  assert.match(notices[0], /<Counter> cannot be rendered server-side at .*:\d+:\d+\./);
  assert.match(notices[0], /No server-renderable build was provided for this import\./);
  assert.match(notices[0], /Serving the client build only\.$/);
});

test('does not emit server builds for non-route component files', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  const inputDirectory = path.join(projectDirectory, 'src');
  const outputDirectory = path.join(projectDirectory, 'dist');
  writeFile(path.join(inputDirectory, 'App.wizz'), '<main><p>App</p></main>');
  writeFile(path.join(inputDirectory, 'components', 'Nav.wizz'), '<nav><p>Nav</p></nav>');

  buildProject(inputDirectory, outputDirectory, createLogger());

  assert.equal(fs.existsSync(path.join(outputDirectory, 'components', 'Nav.js')), true);
  assert.equal(fs.existsSync(path.join(outputDirectory, 'components', 'Nav.server.js')), false);
  assert.equal(fs.existsSync(path.join(outputDirectory, 'components', 'Nav.hydrate.js')), false);
  assert.doesNotMatch(
    fs.readFileSync(path.join(outputDirectory, 'runtime', 'routes.js'), 'utf8'),
    /Nav/
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
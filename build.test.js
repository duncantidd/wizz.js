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
    /^export default function mountComponent\(target\)/m
  );
  assert.equal(fs.existsSync(path.join(outputDirectory, 'App.js.map')), false);
  assert.match(
    fs.readFileSync(path.join(outputDirectory, 'pages', 'Home.js'), 'utf8'),
    /^export default function mountComponent\(target\)/m
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
  assert.equal(
    fs.readFileSync(path.join(outputDirectory, 'runtime', 'main.js'), 'utf8'),
    fs.readFileSync(path.join(__dirname, 'src', 'runtime', 'main.js'), 'utf8')
  );
  assert.equal(logger.errors.length, 0);
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
    /^export default function mountComponent\(target\)/m
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
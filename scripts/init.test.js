const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { TEMPLATE_SETS } = require('./initTemplates.js');
const {
  TEMPLATE_PROMPT,
  checkInitTarget,
  createReadlineAsk,
  initProject,
  interpretTemplateAnswer,
  promptForTemplate
} = require('./init.js');
const { runCli } = require('./cli.js');

const TEMPLATES = TEMPLATE_SETS.sample;
const BARE_PATHS = ['README.md', 'index.html', 'src/App.wizz'];

const EXPECTED_PATHS = [
  'README.md',
  'index.html',
  'App.css',
  'src/App.wizz',
  'src/pages/Home.wizz',
  'src/components/Counter.wizz',
  'src/components/Card.wizz',
  'src/server/api/health.js'
];

function createTemporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-init-test-'));
}

test('scaffolds the complete starter project and reports exactly what it created', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));

  // The target itself does not exist yet: init creates it (and parents).
  const target = path.join(projectDirectory, 'apps', 'my-site');
  const created = initProject(target);

  assert.deepEqual(created, EXPECTED_PATHS);
  for (const templatePath of EXPECTED_PATHS) {
    assert.equal(
      fs.readFileSync(path.join(target, templatePath), 'utf8'),
      TEMPLATES[templatePath]
    );
  }
});

test('scaffolds into an existing empty directory', (t) => {
  const target = createTemporaryDirectory();
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));

  assert.deepEqual(initProject(target), EXPECTED_PATHS);
});

test('refuses a non-empty target directory without --force and writes nothing', (t) => {
  const target = createTemporaryDirectory();
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  fs.writeFileSync(path.join(target, 'notes.txt'), 'keep me', 'utf8');

  assert.throws(() => initProject(target), /Directory is not empty: .* Pass --force to scaffold into it/);
  // The refusal is all-or-nothing: the uninvolved file is untouched and no
  // template was written.
  assert.equal(fs.readFileSync(path.join(target, 'notes.txt'), 'utf8'), 'keep me');
  assert.deepEqual(fs.readdirSync(target), ['notes.txt']);
});

test('--force scaffolds into a non-empty directory without conflicts', (t) => {
  const target = createTemporaryDirectory();
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  fs.writeFileSync(path.join(target, '.gitignore'), 'dist/\n', 'utf8');

  assert.deepEqual(initProject(target, { force: true }), EXPECTED_PATHS);
  assert.equal(fs.readFileSync(path.join(target, '.gitignore'), 'utf8'), 'dist/\n');
});

test('refuses to overwrite an existing template file, even with --force, and writes nothing', (t) => {
  const target = createTemporaryDirectory();
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  const existing = path.join(target, 'src', 'App.wizz');
  fs.mkdirSync(path.dirname(existing), { recursive: true });
  fs.writeFileSync(existing, '// custom work worth keeping', 'utf8');

  for (const force of [false, true]) {
    assert.throws(
      () => initProject(target, { force }),
      force
        ? /Refusing to overwrite existing file\(s\): src\/App\.wizz\./
        : /Directory is not empty: .* Pass --force to scaffold into it/
    );
  }

  // Nothing else was created despite the conflict appearing mid-list.
  assert.equal(fs.readFileSync(existing, 'utf8'), '// custom work worth keeping');
  assert.equal(fs.existsSync(path.join(target, 'index.html')), false);
});

test('refuses a target path that exists and is a file', (t) => {
  const target = createTemporaryDirectory();
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  const filePath = path.join(target, 'a-file');
  fs.writeFileSync(filePath, 'x', 'utf8');

  assert.throws(() => initProject(filePath), /The target path exists and is not a directory/);
});

test('refuses a non-string target', () => {
  assert.throws(() => initProject(undefined), /non-empty string/);
  assert.throws(() => initProject(''), /non-empty string/);
});

// The done-when: a scaffolded project serves both routes with server markup
// and delivered state, and builds cleanly. Client-side hydration itself is
// covered by the hydration suite's DOM tests; this asserts the server side
// of the contract the scaffold promises.
test('the scaffolded project serves / and /home with SSR state and builds cleanly', async (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  initProject(projectDirectory);

  const { startDevelopmentServer } = require('./dev.js');
  const logger = { log() {}, error() {} };
  // Port 0: an OS-assigned port keeps the test collision-free.
  const developmentServer = startDevelopmentServer({ projectDirectory, logger, port: 0 });
  t.after(() => developmentServer.close());
  const url = await developmentServer.listen();

  try {
    const rootResponse = await fetch(`${url}/`);
    assert.match(rootResponse.headers.get('content-type') || '', /text\/html/);
    const rootHtml = await rootResponse.text();
    // The landing page server-renders the reactive head block and both
    // showcase components. Interpolation is delimited by comment nodes so
    // hydration can map the text nodes; the head title interpolates as plain
    // text.
    assert.match(rootHtml, /<title data-wizz-head-id="r"[^>]*>Hello friend - wizz\.js<\/title>/);
    assert.match(rootHtml, /Hello <!-- -->friend<!-- --> Welcome to <!-- -->wizz\.js<!-- -->!/);
    // The Counter server-renders its persisted default, and showReset={true}
    // selects the reset branch.
    assert.match(rootHtml, /Clicks: <!-- -->0<!-- -->\. Persisted clicks: <!-- -->0<!-- -->/);
    assert.match(rootHtml, /<span class="reset"[^>]*>Reset<\/span>/);
    // The terminal card ships its markup verbatim.
    assert.match(rootHtml, /data-cmd="build src dist"/);
    assert.match(rootHtml, /application\/wizz-state/);
    // The delivered shell keeps the global stylesheet link; the dev server
    // serves App.css from the project root.
    assert.match(rootHtml, /<link rel="stylesheet" href="\.\/App\.css">/);
    const cssResponse = await fetch(`${url}/App.css`);
    assert.equal(cssResponse.status, 200);
    assert.match(cssResponse.headers.get('content-type') || '', /text\/css/);
    assert.match(await cssResponse.text(), /--wizz-accent: #facc15;/);

    const homeResponse = await fetch(`${url}/home`);
    assert.match(homeResponse.headers.get('content-type') || '', /text\/html/);
    const homeHtml = await homeResponse.text();
    assert.match(homeHtml, /The Home page/);
    assert.match(homeHtml, /Back to the start page/);
    assert.match(homeHtml, /application\/wizz-state/);

    // The scaffolded server API handler runs inside the dev server, and its
    // source stays unreachable as a static file.
    const healthResponse = await fetch(`${url}/api/health`);
    assert.equal(healthResponse.status, 200);
    assert.match(healthResponse.headers.get('content-type') || '', /application\/json/);
    assert.match(await healthResponse.text(), /^\{"ok":true,"method":"GET"\}$/);
    const handlerSourceResponse = await fetch(`${url}/api/health.js`);
    assert.equal(handlerSourceResponse.status, 404);
    assert.equal((await fetch(`${url}/server/api/health.js`)).status, 404);
  } finally {
    await developmentServer.close();
  }

  const { buildProject } = require('../build.js');
  const buildResult = buildProject(
    path.join(projectDirectory, 'src'),
    path.join(projectDirectory, 'dist'),
    logger
  );
  assert.deepEqual(buildResult, { compiledCount: 4, failedCount: 0 });

  const manifest = fs.readFileSync(path.join(projectDirectory, 'dist', 'runtime', 'routes.js'), 'utf8');
  assert.match(manifest, /"routePath": "\/"/);
  assert.match(manifest, /"routePath": "\/home"/);
  assert.match(manifest, /"serverModulePath": "\.\.\/App\.server\.js"/);
  assert.match(manifest, /"serverModulePath": "\.\.\/pages\/Home\.server\.js"/);

  // Component styles were extracted and linked from the copied shell. The
  // showcase App.wizz itself has no scoped style block — it leans on the
  // global App.css — so only the three styled components contribute.
  const stylesheet = fs.readFileSync(path.join(projectDirectory, 'dist', 'wizz.css'), 'utf8');
  assert.match(stylesheet, /\/\* pages\/Home\.wizz \*\//);
  assert.match(stylesheet, /\/\* components\/Counter\.wizz \*\//);
  assert.match(stylesheet, /\/\* components\/Card\.wizz \*\//);
  const shell = fs.readFileSync(path.join(projectDirectory, 'dist', 'index.html'), 'utf8');
  assert.match(shell, /href="\/wizz\.css"/);

  // The global stylesheet beside the shell is part of the document set: the
  // build copies it exactly as the dev server does, or the shell's ./App.css
  // link would 404 in production.
  const builtAppCss = fs.readFileSync(path.join(projectDirectory, 'dist', 'App.css'), 'utf8');
  assert.ok(builtAppCss.startsWith(TEMPLATES['App.css']));
});

// ---------------------------------------------------------------------------
// Template selection (milestone 24): sample vs bare.

test('the sample template is the default and an explicit sample writes the same files', (t) => {
  const implicitTarget = createTemporaryDirectory();
  const explicitTarget = createTemporaryDirectory();
  t.after(() => fs.rmSync(implicitTarget, { recursive: true, force: true }));
  t.after(() => fs.rmSync(explicitTarget, { recursive: true, force: true }));

  assert.deepEqual(initProject(implicitTarget), EXPECTED_PATHS);
  assert.deepEqual(initProject(explicitTarget, { template: 'sample' }), EXPECTED_PATHS);
  for (const templatePath of EXPECTED_PATHS) {
    assert.equal(
      fs.readFileSync(path.join(explicitTarget, templatePath), 'utf8'),
      fs.readFileSync(path.join(implicitTarget, templatePath), 'utf8')
    );
  }
});

test('the bare template writes only the shell, placeholder App, and README', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  const target = path.join(projectDirectory, 'nested', 'bare-app');

  assert.deepEqual(initProject(target, { template: 'bare' }), BARE_PATHS);
  for (const templatePath of BARE_PATHS) {
    assert.equal(fs.readFileSync(path.join(target, templatePath), 'utf8'), TEMPLATE_SETS.bare[templatePath]);
  }
  // No sample surface at all — not even empty directories.
  assert.deepEqual(fs.readdirSync(target).sort(), ['README.md', 'index.html', 'src']);
  assert.deepEqual(fs.readdirSync(path.join(target, 'src')), ['App.wizz']);
});

test('an unknown or inherited template name is refused before anything is written', (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  const target = path.join(projectDirectory, 'never-created');

  for (const template of ['full', '__proto__', 'constructor', 'toString', 'hasOwnProperty', '', null, 42, {}]) {
    assert.throws(() => initProject(target, { template }), /Unknown init template/, String(template));
  }
  assert.equal(fs.existsSync(target), false);
});

test('--bare --force over an existing sample project refuses on the shared files and writes nothing', (t) => {
  const target = createTemporaryDirectory();
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  initProject(target);
  const before = Object.fromEntries(
    EXPECTED_PATHS.map((templatePath) => [templatePath, fs.readFileSync(path.join(target, templatePath), 'utf8')])
  );

  assert.throws(
    () => initProject(target, { template: 'bare', force: true }),
    /Refusing to overwrite existing file\(s\): README\.md, index\.html, src\/App\.wizz\./
  );
  for (const templatePath of EXPECTED_PATHS) {
    assert.equal(fs.readFileSync(path.join(target, templatePath), 'utf8'), before[templatePath]);
  }
});

test('--bare --force into a non-empty directory without conflicts keeps the other files', (t) => {
  const target = createTemporaryDirectory();
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  fs.writeFileSync(path.join(target, 'App.css'), 'body { color: red; }\n', 'utf8');

  assert.throws(() => initProject(target, { template: 'bare' }), /Directory is not empty/);
  assert.deepEqual(initProject(target, { template: 'bare', force: true }), BARE_PATHS);
  // An unrelated App.css is not a bare-template file, so it is no conflict
  // and stays exactly as the author wrote it.
  assert.equal(fs.readFileSync(path.join(target, 'App.css'), 'utf8'), 'body { color: red; }\n');
});

test('checkInitTarget reports unusable targets without creating anything', (t) => {
  const root = createTemporaryDirectory();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const missing = path.join(root, 'a', 'b');

  assert.equal(checkInitTarget(missing), path.resolve(missing));
  assert.equal(fs.existsSync(path.join(root, 'a')), false);
  fs.writeFileSync(path.join(root, 'file'), 'x', 'utf8');
  assert.throws(() => checkInitTarget(path.join(root, 'file')), /exists and is not a directory/);
  assert.throws(() => checkInitTarget(root), /Directory is not empty/);
  assert.equal(checkInitTarget(root, { force: true }), path.resolve(root));
  assert.throws(() => checkInitTarget(''), /non-empty string/);
});

// ---------------------------------------------------------------------------
// The prompt.

test('interpretTemplateAnswer maps every documented answer and re-asks on anything else', () => {
  for (const answer of ['', 'y', 'Y', 'yes', 'YES', 'Yes', '  y  ', '\t']) {
    assert.equal(interpretTemplateAnswer(answer), 'sample', JSON.stringify(answer));
  }
  for (const answer of ['n', 'N', 'no', 'NO', 'No', ' no ']) {
    assert.equal(interpretTemplateAnswer(answer), 'bare', JSON.stringify(answer));
  }
  for (const answer of ['maybe', 'yess', 'nope', 'y n', '1', '0', 'true', 'ye', 'NOO', 'ÿes', 'y\u0000']) {
    assert.equal(interpretTemplateAnswer(answer), null, JSON.stringify(answer));
  }
});

function scriptedAsk(answers) {
  const questions = [];
  const ask = async (question) => {
    questions.push(question);
    if (answers.length === 0) return null;
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { ask, questions };
}

test('promptForTemplate asks the documented question and honors each answer', async () => {
  const cases = [
    [[''], 'sample'],
    [['Y'], 'sample'],
    [['yes'], 'sample'],
    [['n'], 'bare'],
    [['NO'], 'bare']
  ];
  for (const [answers, expected] of cases) {
    const { ask, questions } = scriptedAsk([...answers]);
    assert.equal(await promptForTemplate(ask), expected, JSON.stringify(answers));
    assert.deepEqual(questions, [TEMPLATE_PROMPT]);
  }
  assert.equal(TEMPLATE_PROMPT, 'Bootstrap with sample code? [Y/n] ');
});

test('promptForTemplate re-asks after junk until it gets a valid answer', async () => {
  const { ask, questions } = scriptedAsk(['maybe', 'yess', '???', 'no']);
  assert.equal(await promptForTemplate(ask), 'bare');
  assert.equal(questions.length, 4);
  assert.ok(questions.every((question) => question === TEMPLATE_PROMPT));
});

test('promptForTemplate aborts on EOF, including after junk', async () => {
  for (const answers of [[], ['junk'], [undefined]]) {
    await assert.rejects(promptForTemplate(scriptedAsk([...answers]).ask), (error) => {
      assert.equal(error.code, 'WIZZ_INIT_ABORTED');
      assert.equal(error.reason, 'eof');
      assert.match(error.message, /no files were written/);
      return true;
    });
  }
});

test('promptForTemplate propagates a Ctrl+C abort and other ask failures unchanged', async () => {
  const interrupt = Object.assign(new Error('Init aborted: no files were written.'), {
    code: 'WIZZ_INIT_ABORTED',
    reason: 'interrupt'
  });
  await assert.rejects(promptForTemplate(scriptedAsk([interrupt]).ask), interrupt);
  const broken = new Error('stdin exploded');
  await assert.rejects(promptForTemplate(scriptedAsk([broken]).ask), broken);
  await assert.rejects(promptForTemplate(undefined), /requires an ask function/);
});

function readlineFixture({ terminal = false } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk) => { written += chunk; });
  // readline enters terminal mode (and so recognizes Ctrl+C) when its output
  // claims to be a TTY.
  if (terminal) output.isTTY = true;
  const prompt = createReadlineAsk({ input, output });
  return { input, output, prompt, written: () => written };
}

test('the readline ask writes the question to its output stream and resolves the typed line', async (t) => {
  const { input, prompt, written } = readlineFixture();
  t.after(() => prompt.close());
  const answer = prompt.ask(TEMPLATE_PROMPT);
  input.write('n\n');
  assert.equal(await answer, 'n');
  assert.match(written(), /Bootstrap with sample code\? \[Y\/n\] /);
});

test('the readline ask keeps typed-ahead lines for the following re-asks', async (t) => {
  const { input, prompt } = readlineFixture();
  t.after(() => prompt.close());
  // Junk and the real answer arrive in one chunk, before the re-ask exists.
  input.write('junk\nno\n');
  assert.equal(await promptForTemplate(prompt.ask), 'bare');
});

test('the readline ask resolves null on EOF and after close', async () => {
  const { input, prompt } = readlineFixture();
  const answer = prompt.ask(TEMPLATE_PROMPT);
  input.end();
  assert.equal(await answer, null);
  assert.equal(await prompt.ask(TEMPLATE_PROMPT), null);
  prompt.close();
  prompt.close(); // idempotent
});

test('the readline ask still delivers a piped answer that arrives just before EOF', async () => {
  const { input, prompt } = readlineFixture();
  input.end('NO\n');
  assert.equal(await promptForTemplate(prompt.ask), 'bare');
  prompt.close();
});

test('the readline ask rejects with an interrupt abort on Ctrl+C', async () => {
  const { input, prompt, written } = readlineFixture({ terminal: true });
  const answer = prompt.ask(TEMPLATE_PROMPT);
  input.write('\u0003');
  await assert.rejects(answer, (error) => {
    assert.equal(error.code, 'WIZZ_INIT_ABORTED');
    assert.equal(error.reason, 'interrupt');
    return true;
  });
  // The shell prompt resumes on a fresh line, and the interface is closed.
  assert.ok(written().endsWith('\n'));
  assert.equal(await prompt.ask(TEMPLATE_PROMPT), null);
});

// ---------------------------------------------------------------------------
// The CLI wiring of the prompt: when it is asked, and what each answer does.

function recordingLogger() {
  const lines = { log: [], warn: [], error: [] };
  return {
    lines,
    logger: {
      log: (line) => lines.log.push(String(line)),
      warn: (line) => lines.warn.push(String(line)),
      error: (line) => lines.error.push(String(line))
    }
  };
}

function scaffoldedFiles(directory) {
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else files.push(path.relative(directory, entryPath).split(path.sep).join('/'));
    }
  };
  if (fs.existsSync(directory)) walk(directory);
  return files.sort();
}

test('wizz init on a TTY asks once and scaffolds the chosen template', async (t) => {
  const cases = [
    [[''], EXPECTED_PATHS],
    [['Y'], EXPECTED_PATHS],
    [['yes'], EXPECTED_PATHS],
    [['n'], BARE_PATHS],
    [['NO'], BARE_PATHS],
    [['junk', 'n'], BARE_PATHS]
  ];
  for (const [answers, expectedPaths] of cases) {
    const root = createTemporaryDirectory();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const target = path.join(root, 'app');
    const { ask, questions } = scriptedAsk([...answers]);
    const { logger, lines } = recordingLogger();

    const result = runCli(['init', target], { ask, stdinIsTTY: true, logger });
    assert.equal(typeof result.then, 'function', 'the interactive path is asynchronous');
    // Nothing is written while the question is open.
    assert.equal(fs.existsSync(target), false);
    assert.equal(await result, 0);
    assert.equal(questions.length, answers.length);
    assert.deepEqual(scaffoldedFiles(target), [...expectedPaths].sort());
    assert.equal(lines.log.length, expectedPaths.length + 1);
    assert.match(lines.log.at(-1), /Next: run `wizz dev`/);
  }
});

test('wizz init aborts on EOF (exit 1) and Ctrl+C (exit 130) with no files written', async (t) => {
  const root = createTemporaryDirectory();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'app');
  const interrupt = Object.assign(new Error('Init aborted: no files were written.'), {
    code: 'WIZZ_INIT_ABORTED',
    reason: 'interrupt'
  });

  for (const [answers, exitCode] of [[[], 1], [['junk'], 1], [[interrupt], 130]]) {
    const { logger, lines } = recordingLogger();
    const code = await runCli(['init', target], { ask: scriptedAsk([...answers]).ask, stdinIsTTY: true, logger });
    assert.equal(code, exitCode);
    assert.deepEqual(lines.error, ['Init aborted: no files were written.']);
    assert.deepEqual(lines.log, []);
    assert.equal(fs.existsSync(target), false);
  }
});

test('wizz init rejects with an unexpected ask failure instead of swallowing it', async (t) => {
  const root = createTemporaryDirectory();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'app');
  const broken = new Error('stdin exploded');
  await assert.rejects(
    runCli(['init', target], { ask: scriptedAsk([broken]).ask, stdinIsTTY: true, logger: recordingLogger().logger }),
    broken
  );
  assert.equal(fs.existsSync(target), false);
});

test('wizz init refuses an unusable target before asking the question', (t) => {
  const target = createTemporaryDirectory();
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  fs.writeFileSync(path.join(target, 'notes.txt'), 'keep me', 'utf8');
  const { ask, questions } = scriptedAsk(['n']);

  assert.throws(
    () => runCli(['init', target], { ask, stdinIsTTY: true, logger: recordingLogger().logger }),
    /Directory is not empty/
  );
  assert.deepEqual(questions, []);
  assert.deepEqual(fs.readdirSync(target), ['notes.txt']);
});

test('wizz init never asks without a TTY or with --json, and defaults to the sample synchronously', (t) => {
  const runs = [
    [['init'], { stdinIsTTY: false }],
    [['init', '--json'], { stdinIsTTY: true }],
    [['init', '--json'], { stdinIsTTY: false }]
  ];
  for (const [argv, options] of runs) {
    const root = createTemporaryDirectory();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const target = path.join(root, 'app');
    const { ask, questions } = scriptedAsk(['n']);
    const result = runCli([...argv, target], { ...options, ask, logger: recordingLogger().logger });
    assert.equal(result, 0, 'scripted init stays synchronous');
    assert.deepEqual(questions, []);
    assert.deepEqual(scaffoldedFiles(target), [...EXPECTED_PATHS].sort());
  }
});

test('--sample and --bare answer the question up front, on a TTY or not', (t) => {
  for (const [flag, expectedPaths] of [['--sample', EXPECTED_PATHS], ['--bare', BARE_PATHS]]) {
    for (const stdinIsTTY of [true, false]) {
      const root = createTemporaryDirectory();
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const target = path.join(root, 'app');
      const { ask, questions } = scriptedAsk(['y']);
      assert.equal(runCli(['init', flag, target], { ask, stdinIsTTY, logger: recordingLogger().logger }), 0);
      assert.deepEqual(questions, []);
      assert.deepEqual(scaffoldedFiles(target), [...expectedPaths].sort());
    }
  }
});

test('a spawned wizz init with piped stdin never prompts and writes the sample', (t) => {
  const { spawnSync } = require('node:child_process');
  const target = createTemporaryDirectory();
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  // Even a "n" on the pipe is not an answer: a pipe is not a TTY.
  const result = spawnSync(process.execPath, [path.join(__dirname, 'cli.js'), 'init', target], {
    input: 'n\n',
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.doesNotMatch(result.stdout, /Bootstrap with sample code/);
  assert.deepEqual(scaffoldedFiles(target), [...EXPECTED_PATHS].sort());
});

// The milestone 24 done-when: a bare project builds, builds for the node
// adapter, and serves under the dev server — all with no warnings or notes.
test('the bare project builds and serves with no warnings, notes, or errors', async (t) => {
  const projectDirectory = createTemporaryDirectory();
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
  initProject(projectDirectory, { template: 'bare' });

  const { startDevelopmentServer } = require('./dev.js');
  const dev = recordingLogger();
  const developmentServer = startDevelopmentServer({ projectDirectory, logger: dev.logger, port: 0 });
  t.after(() => developmentServer.close());
  const url = await developmentServer.listen();

  try {
    const rootResponse = await fetch(`${url}/`);
    assert.equal(rootResponse.status, 200);
    const rootHtml = await rootResponse.text();
    // Server-rendered placeholder plus the hydration state payload.
    assert.match(rootHtml, /<main>\s*<h1 data-wizz-id="1">Hello from <!-- -->wizz\.js<\/h1>/);
    assert.match(rootHtml, /application\/wizz-state/);
    assert.doesNotMatch(rootHtml, /App\.css|wizz\.css/);
    // No global stylesheet and no API routes: both are plain misses.
    assert.equal((await fetch(`${url}/App.css`)).status, 404);
    const apiResponse = await fetch(`${url}/api/health`);
    assert.equal(apiResponse.status, 404);
    assert.match(apiResponse.headers.get('content-type') || '', /application\/json/);
    await apiResponse.text();
    // An unknown page route falls back to the shell, as for any project.
    assert.equal((await fetch(`${url}/home`)).status, 200);
  } finally {
    await developmentServer.close();
  }
  assert.deepEqual(dev.lines.warn, []);
  assert.deepEqual(dev.lines.error, []);
  for (const line of dev.lines.log) {
    assert.doesNotMatch(line, /warn|note|missing|error/i, line);
  }

  const { main: buildMain } = require('../build.js');
  for (const adapterArguments of [[], ['--adapter', 'node']]) {
    const outputDirectory = path.join(projectDirectory, adapterArguments.length ? 'dist-node' : 'dist-static');
    const build = recordingLogger();
    const exitCode = buildMain([path.join(projectDirectory, 'src'), outputDirectory, ...adapterArguments], build.logger);
    assert.equal(exitCode, 0, build.lines.error.join('\n'));
    assert.deepEqual(build.lines.warn, []);
    assert.deepEqual(build.lines.error, []);
    for (const line of build.lines.log) {
      assert.doesNotMatch(line, /warn|note|missing|error/i, line);
    }
    // No stylesheet of any kind was produced or linked.
    assert.equal(fs.existsSync(path.join(outputDirectory, 'App.css')), false);
    assert.equal(fs.existsSync(path.join(outputDirectory, 'wizz.css')), false);
    assert.doesNotMatch(fs.readFileSync(path.join(outputDirectory, 'index.html'), 'utf8'), /<link\b/i);
    const manifest = fs.readFileSync(path.join(outputDirectory, 'runtime', 'routes.js'), 'utf8');
    assert.match(manifest, /"routePath": "\/"/);
    assert.match(manifest, /"serverModulePath": "\.\.\/App\.server\.js"/);
  }
  assert.ok(fs.existsSync(path.join(projectDirectory, 'dist-node', 'server.mjs')));
});

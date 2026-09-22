const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync, spawnSync } = require('node:child_process');
const { VERSIONS } = require('./src/compiler/version.js');

const root = __dirname;
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('the package version stays in lockstep with the compiler contract', () => {
  // The release tarball is named from package.json while the generated
  // modules it ships stamp VERSIONS.compiler: one version, two sources, so
  // this pin is what makes a drift a test failure instead of a silent lie.
  assert.equal(pkg.version, VERSIONS.compiler);
});

test('the package stays zero-dependency', () => {
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    assert.equal(key in pkg, false, `package.json must not carry a ${key} field`);
  }
});

test('the package targets the supported Node floor', () => {
  // The suite and the installer both verify Node >= 18; the engines field is
  // the same statement in npm's vocabulary.
  assert.equal(pkg.engines.node, '>=18');
});

test('the bin entry points at an existing script with a node shebang', () => {
  const binPath = path.join(root, pkg.bin.wizz);
  assert.equal(fs.existsSync(binPath), true);
  const firstLine = fs.readFileSync(binPath, 'utf8').split('\n')[0];
  assert.equal(firstLine, '#!/usr/bin/env node');
});

test('CI runs the suite on every supported Node across push and pull requests', () => {
  // The zero-dependency mandate means no YAML parser: these pins cover the
  // load-bearing lines of the workflow instead of its full parse tree.
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /node-version: \[18, 20, 22\]/);
  assert.match(workflow, /^ {6}- run: node --test$/m);
});

test('a v* tag release is guarded, tested, packed, and attached in order', () => {
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(workflow, /tags: \['v\*'\]/);
  // The tag must match package.json before anything runs...
  assert.match(workflow, /require\('\.\/package\.json'\)\.version/);
  const guard = workflow.indexOf('Refuse a tag that does not match package.json');
  const suite = workflow.indexOf('Run the suite');
  const pack = workflow.indexOf('Pack the release tarball');
  const packExtension = workflow.indexOf('Pack the VS Code extension');
  const publish = workflow.indexOf('Create the GitHub release with the tarball');
  assert.equal(guard > -1 && suite > guard && pack > suite && publish > pack, true,
    'workflow steps must run guard, suite, pack, publish in that order');
  assert.match(workflow, /mkdir -p release && npm pack --pack-destination=release/);
  assert.match(workflow, /node vscode-extension\/scripts\/pack\.js --out release/);
  assert.equal(packExtension > -1 && packExtension > pack && publish > packExtension, true,
    'the extension pack step must run after the tarball pack and before the release is created');
  assert.match(workflow, /gh release create "\$GITHUB_REF_NAME" release\/wizz-\*\.tgz release\/wizz-vscode-\*\.vsix/);
  // Registry publication is out of scope; the tarball must not be pushed to
  // npm by the workflow.
  assert.doesNotMatch(workflow, /npm publish/);
});

test('the files whitelist ships the user-facing boilerplate intact', () => {
  // The installed framework's first-run surface is exactly the live landing
  // page: this pin is the packaging-side guarantee that the boilerplate
  // files are shipped and that pruning scratch never eats them.
  const required = ['src/App.wizz', 'src/components/Card.wizz', 'src/components/Counter.wizz', 'index.html', 'App.css'];
  for (const member of required) {
    assert.equal(pkg.files.includes(member), true, `files must ship ${member}`);
    assert.equal(fs.existsSync(path.join(root, member)), true, `${member} must exist in the repository`);
  }
});

const EXPECTED_FILES = [
  'package.json', // always included by npm
  'README.md', 'LICENSE', 'CHANGELOG.md', // docs auto-included and whitelisted
  'build.js', 'index.html', 'App.css',
  'src/App.wizz',
  'src/components/Card.wizz', 'src/components/Counter.wizz', 'src/components/Panel.wizz',
  'src/pages/Home.wizz',
  'scripts/cli.js', 'scripts/dev.js', 'scripts/init.js', 'scripts/initTemplates.js',
  'scripts/releaseAssets.js', 'scripts/update.js',
  'scripts/ssr-demo.js', 'scripts/install-cli.sh'
];

function isAllowedMember(member) {
  if (EXPECTED_FILES.includes(member)) return true;
  // The compiler ships whole; its adjacent tests stay repository-only.
  if (member.startsWith('src/compiler/')) return !member.endsWith('.test.js');
  if (member.startsWith('src/runtime/')) return true;
  return false;
}

test('the packed tarball contains exactly the shipped surface', (t) => {
  // npm pack writes the tarball into a scratch destination so the test
  // never leaves tgz litter in the repository root.
  const packDestination = fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-pack-test-'));
  t.after(() => fs.rmSync(packDestination, { recursive: true, force: true }));

  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', `--pack-destination=${packDestination}`], {
    cwd: root,
    encoding: 'utf8'
  }));
  assert.equal(Array.isArray(packed), true);
  assert.equal(packed.length, 1);
  const [{ filename, name, version }] = packed;
  assert.equal(name, 'wizz');
  assert.equal(version, VERSIONS.compiler);
  assert.equal(filename, `wizz-${VERSIONS.compiler}.tgz`);

  const tarballPath = path.join(packDestination, filename);
  const members = spawnSync('tar', ['-tzf', tarballPath], { encoding: 'utf8' });
  assert.equal(members.status, 0, members.stderr);
  // npm prefixes every member with package/; strip it for comparisons and
  // drop the root entry itself.
  const files = members.stdout.split('\n')
    .filter((line) => line.startsWith('package/') && line !== 'package/')
    .map((line) => line.slice('package/'.length));

  for (const member of files) {
    assert.equal(
      isAllowedMember(member),
      true,
      `tarball member ${member} is outside the shipped surface`
    );
  }
  for (const member of EXPECTED_FILES) {
    assert.equal(files.includes(member), true, `tarball must contain ${member}`);
  }
  // The compiler tree itself must be present and test-free.
  assert.equal(files.some((member) => member === 'src/compiler/index.js'), true);
  assert.equal(files.some((member) => member.endsWith('.test.js')), false);
  // Nothing from the development-only surface may leak.
  for (const denied of ['test/', 'dist/', 'vscode-extension/', '.github/', 'scripts/cli.test.js', 'packaging.test.js']) {
    assert.equal(
      files.some((member) => member === denied || member.startsWith(denied)),
      false,
      `tarball must not contain ${denied}`
    );
  }
});

test('a tarball install builds a project on this runtime without further steps', () => {
  // The done-when for the milestone, executable offline: pack, extract, and
  // run the shipped CLI against a fresh two-file project. No npm install —
  // the package is zero-dependency by mandate.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-pack-install-'));
  try {
    const tarballPath = path.join(workspace, `wizz-${VERSIONS.compiler}.tgz`);
    execFileSync('npm', ['pack', `--pack-destination=${workspace}`], { cwd: root, encoding: 'utf8' });
    execFileSync('tar', ['-xzf', tarballPath, '-C', workspace]);

    const projectDirectory = path.join(workspace, 'fresh-project');
    fs.mkdirSync(path.join(projectDirectory, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectDirectory, 'index.html'), '<div id="app"></div>\n');
    fs.writeFileSync(path.join(projectDirectory, 'src', 'App.wizz'), '<main><p>Fresh install</p></main>\n');

    execFileSync(process.execPath, [path.join(workspace, 'package', 'scripts', 'cli.js'), 'build'], {
      cwd: projectDirectory,
      encoding: 'utf8'
    });

    const appModule = fs.readFileSync(path.join(projectDirectory, 'dist', 'App.js'), 'utf8');
    assert.match(appModule, /export default function mountComponent\(target, props = \{\}\)/);
    assert.equal(fs.existsSync(path.join(projectDirectory, 'dist', 'runtime', 'main.js')), true);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

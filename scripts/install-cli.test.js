const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { VERSIONS } = require('../src/compiler/version.js');

const root = path.join(__dirname, '..');
const installer = path.join(root, 'scripts', 'install-cli.sh');
// The installer is bash; the tests exercise it on POSIX runners only.
const skipInstallerTests = process.platform === 'win32';

// A sandboxed HOME keeps the installer's defaults ($HOME/.local/share/wizz
// and $HOME/.local/bin/wizz) away from the developer's real installation.
function createHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-install-home-'));
}

function installEnvironment(home) {
  const environment = { ...process.env, HOME: home };
  delete environment.XDG_DATA_HOME;
  delete environment.XDG_BIN_HOME;
  return environment;
}

function installedDataDirectory(home) {
  return path.join(home, '.local', 'share', 'wizz');
}

function installedLauncher(home) {
  return path.join(home, '.local', 'bin', 'wizz');
}

function createReleaseTarball(destination) {
  // The npm layout: every member under a top-level package/ directory.
  const packageDirectory = path.join(destination, 'package');
  fs.mkdirSync(path.join(packageDirectory, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(root, 'build.js'), path.join(packageDirectory, 'build.js'));
  fs.cpSync(path.join(root, 'src'), path.join(packageDirectory, 'src'), { recursive: true });
  fs.copyFileSync(path.join(root, 'scripts', 'cli.js'), path.join(packageDirectory, 'scripts', 'cli.js'));
  fs.copyFileSync(path.join(root, 'scripts', 'dev.js'), path.join(packageDirectory, 'scripts', 'dev.js'));
  fs.copyFileSync(path.join(root, 'scripts', 'apiRoutes.js'), path.join(packageDirectory, 'scripts', 'apiRoutes.js'));
  // Required by cli.js at top level: the MCP server and its two layers.
  fs.copyFileSync(path.join(root, 'scripts', 'mcp.js'), path.join(packageDirectory, 'scripts', 'mcp.js'));
  fs.copyFileSync(path.join(root, 'scripts', 'mcpProtocol.js'), path.join(packageDirectory, 'scripts', 'mcpProtocol.js'));
  fs.copyFileSync(path.join(root, 'scripts', 'mcpTools.js'), path.join(packageDirectory, 'scripts', 'mcpTools.js'));
  fs.copyFileSync(path.join(root, 'scripts', 'init.js'), path.join(packageDirectory, 'scripts', 'init.js'));
  fs.copyFileSync(path.join(root, 'scripts', 'initTemplates.js'), path.join(packageDirectory, 'scripts', 'initTemplates.js'));
  // Required by cli.js at top level: the installed launcher test below
  // exercises these requires for free.
  fs.copyFileSync(path.join(root, 'scripts', 'releaseAssets.js'), path.join(packageDirectory, 'scripts', 'releaseAssets.js'));
  fs.copyFileSync(path.join(root, 'scripts', 'update.js'), path.join(packageDirectory, 'scripts', 'update.js'));
  fs.copyFileSync(path.join(root, 'scripts', 'installVscodeExtension.js'), path.join(packageDirectory, 'scripts', 'installVscodeExtension.js'));
  fs.writeFileSync(
    path.join(packageDirectory, 'package.json'),
    JSON.stringify({ name: 'wizz', version: '9.9.9-test' })
  );
  const tarballPath = path.join(destination, 'wizz-9.9.9-test.tgz');
  execFileSync('tar', ['-czf', tarballPath, '-C', destination, 'package']);
  return tarballPath;
}

function assertUsableInstallation(home) {
  const dataDirectory = installedDataDirectory(home);
  assert.equal(fs.existsSync(path.join(dataDirectory, 'scripts', 'cli.js')), true);
  assert.equal(fs.existsSync(path.join(dataDirectory, 'build.js')), true);
  assert.equal(fs.existsSync(path.join(dataDirectory, 'src', 'compiler', 'index.js')), true);

  const launcher = installedLauncher(home);
  assert.equal(fs.existsSync(launcher), true);
  const mode = fs.statSync(launcher).mode;
  assert.equal(mode & 0o111, 0o111, 'the launcher must be executable');

  const rejected = spawnSync(launcher, ['not-a-command'], { encoding: 'utf8' });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Usage:/);
}

test('installing from a release tarball extracts the package and wires the launcher', (t) => {
  if (skipInstallerTests) { t.skip('bash-based installer test'); return; }
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-install-tarball-'));
  const home = createHome();
  t.after(() => { fs.rmSync(workspace, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });

  const tarballPath = createReleaseTarball(workspace);
  const installed = spawnSync('bash', [installer, tarballPath], {
    encoding: 'utf8',
    env: installEnvironment(home)
  });
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /Installed Wizz 9\.9\.9-test to /);
  assertUsableInstallation(home);
});

test('installing with --local copies the working tree and reports the compiler version', (t) => {
  if (skipInstallerTests) { t.skip('bash-based installer test'); return; }
  const home = createHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const installed = spawnSync('bash', [installer, '--local'], {
    encoding: 'utf8',
    env: installEnvironment(home)
  });
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, new RegExp(`Installed Wizz ${VERSIONS.compiler} to `));
  assertUsableInstallation(home);
});

test('--help prints the usage and exits cleanly', (t) => {
  if (skipInstallerTests) { t.skip('bash-based installer test'); return; }
  const home = createHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const helped = spawnSync('bash', [installer, '--help'], {
    encoding: 'utf8',
    env: installEnvironment(home)
  });
  assert.equal(helped.status, 0);
  assert.match(helped.stdout, /Usage:/);
  assert.equal(fs.existsSync(installedDataDirectory(home)), false, '--help must not install anything');
});

test('a piped invocation (the curl | bash bootstrap) runs without a BASH_SOURCE', (t) => {
  if (skipInstallerTests) { t.skip('bash-based installer test'); return; }
  const home = createHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  // A script read from stdin has no BASH_SOURCE; under `set -u` the
  // first-time `curl ... | bash` bootstrap must not abort on it.
  const piped = spawnSync('bash', ['-s', '--', '--help'], {
    encoding: 'utf8',
    env: installEnvironment(home),
    input: fs.readFileSync(installer, 'utf8')
  });
  assert.equal(piped.status, 0, piped.stderr);
  assert.match(piped.stdout, /Usage:/);
  assert.doesNotMatch(piped.stderr, /unbound variable/);
  assert.equal(fs.existsSync(installedDataDirectory(home)), false);
});

test('an unknown flag prints the usage and refuses to install', (t) => {
  if (skipInstallerTests) { t.skip('bash-based installer test'); return; }
  const home = createHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const refused = spawnSync('bash', [installer, '--bogus'], {
    encoding: 'utf8',
    env: installEnvironment(home)
  });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Usage:/);
});

test('a missing tarball path fails with a located message', (t) => {
  if (skipInstallerTests) { t.skip('bash-based installer test'); return; }
  const home = createHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const missing = spawnSync('bash', [installer, path.join(home, 'absent.tgz')], {
    encoding: 'utf8',
    env: installEnvironment(home)
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Tarball not found/);
});

test('a foreign tarball without a Wizz package fails loudly', (t) => {
  if (skipInstallerTests) { t.skip('bash-based installer test'); return; }
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-install-foreign-'));
  const home = createHome();
  t.after(() => { fs.rmSync(workspace, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });

  // npm layout, wrong contents: a truncated or unrelated tarball must be
  // rejected instead of installed as garbage.
  fs.mkdirSync(path.join(workspace, 'package'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'package', 'README.md'), 'not wizz');
  const foreign = path.join(workspace, 'foreign.tgz');
  execFileSync('tar', ['-czf', foreign, '-C', workspace, 'package']);

  const rejected = spawnSync('bash', [installer, foreign], {
    encoding: 'utf8',
    env: installEnvironment(home)
  });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /does not contain a Wizz package/);
  assert.equal(fs.existsSync(installedDataDirectory(home)), false);
});

test('a 404 from the latest-release lookup fails with guidance, not a parser crash', (t) => {
  if (skipInstallerTests) { t.skip('bash-based installer test'); return; }
  // The failure path needs the GitHub API to answer a request at all; without
  // connectivity the friendly-message guarantee is untestable.
  const reachable = spawnSync('curl', ['-fsSL', '-m', '5', 'https://api.github.com'], { encoding: 'utf8' });
  if (reachable.status !== 0) { t.skip('the GitHub API is unreachable'); return; }
  const home = createHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  // A repository name that cannot exist reproduces the private-repo/404
  // failure the installer must survive: guidance on stderr, no JSON.parse
  // stack trace, and nothing installed.
  const refused = spawnSync('bash', [installer, '--latest'], {
    encoding: 'utf8',
    env: { ...installEnvironment(home), WIZZ_INSTALL_REPOSITORY: 'duncantidd/wizz-installer-test-absent-repo' }
  });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Could not resolve the latest Wizz release/);
  assert.match(refused.stderr, /private or have no published releases yet/);
  assert.doesNotMatch(refused.stderr, /SyntaxError|Unexpected end of JSON/);
  assert.equal(fs.existsSync(installedDataDirectory(home)), false);
});

test('a failing release-tarball download fails with guidance', (t) => {
  if (skipInstallerTests) { t.skip('bash-based installer test'); return; }
  const home = createHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  // The reserved .invalid TLD never resolves, so this fails deterministically
  // whether or not the machine is online.
  const refused = spawnSync('bash', [installer, 'https://wizz-installer-test.invalid/wizz.tgz'], {
    encoding: 'utf8',
    env: installEnvironment(home)
  });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Could not download the release tarball/);
  assert.equal(fs.existsSync(installedDataDirectory(home)), false);
});

// A plain-http URL must be refused before any request is made — the shell
// mirror of releaseAssets.js validatedDownloadUrl. No network needed: the
// .invalid host would fail anyway, but the refusal must come from the
// scheme check, not DNS.
test('a plain-http tarball URL is refused by the scheme check', (t) => {
  if (skipInstallerTests) { t.skip('bash-based installer test'); return; }
  const home = createHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const refused = spawnSync('bash', [installer, 'http://wizz-installer-test.invalid/wizz.tgz'], {
    encoding: 'utf8',
    env: installEnvironment(home)
  });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /only https:\/\/ URLs are allowed/);
  assert.equal(fs.existsSync(installedDataDirectory(home)), false);
});

// A local server stands in for the GitHub API (WIZZ_INSTALL_API_BASE, the
// same seam shape as WIZZ_INSTALL_REPOSITORY), exercising the whole
// --latest flow — digest verification included — offline.
function sha256Of(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

async function startApiServer({ tarballBytes, digest, assetUrl, redirectToLoopbackAlias = false } = {}) {
  const server = http.createServer((request, response) => {
    if (request.url.endsWith('/releases/latest')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        tag_name: 'v2.0.0',
        html_url: 'https://github.com/o/r/releases/tag/v2.0.0',
        assets: [{
          name: 'wizz-2.0.0.tgz',
          browser_download_url: assetUrl || `http://127.0.0.1:${server.address().port}/download/wizz-2.0.0.tgz`,
          ...(digest === 'absent' ? {} : { digest: digest === undefined ? sha256Of(tarballBytes) : digest })
        }]
      }));
      return;
    }
    if (redirectToLoopbackAlias && request.headers.host === `127.0.0.1:${server.address().port}`) {
      // Redirect the first download request to the same server labeled with
      // `localhost` instead of `127.0.0.1` (the Host header tells the two
      // apart, like a real CDN alias): the download itself succeeds (both
      // are loopback), so the refusal must come from the final-URL host
      // check, not from DNS or curl's transport failure.
      response.writeHead(302, { location: `http://localhost:${server.address().port}/download/wizz-2.0.0.tgz` });
      response.end();
      return;
    }
    response.end(tarballBytes);
  });
  const serverUrl = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
  return { server, serverUrl };
}

function latestEnvironment(home, serverUrl) {
  return {
    ...installEnvironment(home),
    WIZZ_INSTALL_REPOSITORY: 'o/r',
    WIZZ_INSTALL_API_BASE: serverUrl
  };
}

// The server-backed tests must spawn the installer ASYNCHRONOUSLY:
// spawnSync blocks the event loop, and the local API server lives in this
// same process — a blocked loop can never answer curl's request, so the
// test would deadlock. The synchronous spawnSync tests above install from
// local files and need no in-process server.
function runInstallerAsync(args, environment) {
  return new Promise((resolve) => {
    const child = spawn('bash', [installer, ...args], { env: environment });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.on('error', (error) => resolve({ status: -1, stdout, stderr: `${stderr}\n${error.message}` }));
  });
}

test('--latest installs a release whose digest matches the downloaded bytes', async (t) => {
  if (skipInstallerTests) { t.skip('bash-based installer test'); return; }
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-install-latest-'));
  const home = createHome();
  t.after(() => { fs.rmSync(workspace, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });

  const tarballPath = createReleaseTarball(workspace);
  const { server, serverUrl } = await startApiServer({ tarballBytes: fs.readFileSync(tarballPath) });
  t.after(() => server.close());

  const installed = await runInstallerAsync(['--latest'], latestEnvironment(home, serverUrl));
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /Installed Wizz 9\.9\.9-test to /);
  assertUsableInstallation(home);
});

test('--latest refuses a tarball whose bytes do not match the published digest', async (t) => {
  if (skipInstallerTests) { t.skip('bash-based installer test'); return; }
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-install-digest-'));
  const home = createHome();
  t.after(() => { fs.rmSync(workspace, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });

  const tarballPath = createReleaseTarball(workspace);
  const { server, serverUrl } = await startApiServer({
    tarballBytes: fs.readFileSync(tarballPath),
    digest: sha256Of(Buffer.from('tampered-bytes'))
  });
  t.after(() => server.close());

  const refused = await runInstallerAsync(['--latest'], latestEnvironment(home, serverUrl));
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /integrity check for the release tarball failed/);
  assert.equal(fs.existsSync(installedDataDirectory(home)), false);
});

test('--latest refuses a release that publishes no digest', async (t) => {
  if (skipInstallerTests) { t.skip('bash-based installer test'); return; }
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-install-nodigest-'));
  const home = createHome();
  t.after(() => { fs.rmSync(workspace, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });

  const tarballPath = createReleaseTarball(workspace);
  const { server, serverUrl } = await startApiServer({
    tarballBytes: fs.readFileSync(tarballPath),
    digest: 'absent'
  });
  t.after(() => server.close());

  const refused = await runInstallerAsync(['--latest'], latestEnvironment(home, serverUrl));
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /no sha256 digest for the tarball; refusing to install unverified code/);
  assert.equal(fs.existsSync(installedDataDirectory(home)), false);
});

test('--latest refuses an http asset URL on a foreign host', async (t) => {
  if (skipInstallerTests) { t.skip('bash-based installer test'); return; }
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-install-foreign-'));
  const home = createHome();
  t.after(() => { fs.rmSync(workspace, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });

  const tarballPath = createReleaseTarball(workspace);
  const { server, serverUrl } = await startApiServer({
    tarballBytes: fs.readFileSync(tarballPath),
    assetUrl: 'http://evil.example/wizz-2.0.0.tgz'
  });
  t.after(() => server.close());

  const refused = await runInstallerAsync(['--latest'], latestEnvironment(home, serverUrl));
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Refusing to download the release tarball/);
  assert.match(refused.stderr, /only https:\/\/ URLs are allowed/);
  assert.equal(fs.existsSync(installedDataDirectory(home)), false);
});

test('--latest refuses a redirect that downgrades to http on a foreign host', async (t) => {
  if (skipInstallerTests) { t.skip('bash-based installer test'); return; }
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-install-redirect-'));
  const home = createHome();
  t.after(() => { fs.rmSync(workspace, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });

  const tarballPath = createReleaseTarball(workspace);
  const { server, serverUrl } = await startApiServer({
    tarballBytes: fs.readFileSync(tarballPath),
    // The asset URL itself is allowed (same host as the API seam), but the
    // download endpoint redirects to the same server under a different host
    // label — so curl follows it and delivers the bytes, and the refusal
    // must come from the final-URL check, not from DNS.
    redirectToLoopbackAlias: true
  });
  t.after(() => server.close());

  const refused = await runInstallerAsync(['--latest'], latestEnvironment(home, serverUrl));
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Refusing to install a tarball served from/);
  assert.equal(fs.existsSync(installedDataDirectory(home)), false);
});

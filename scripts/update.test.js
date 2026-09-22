const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { compareVersions, readCompilerVersion, update } = require('./update');
const { TARBALL_ASSET_PATTERN } = require('./releaseAssets');

// A fake managed installation with the shape the installer produces: the
// version declaration in src/compiler/version.js and a scripts/cli.js the
// launcher would execute.
function createFakeInstall(parentDirectory, version) {
  const dataDirectory = path.join(parentDirectory, 'wizz');
  fs.mkdirSync(path.join(dataDirectory, 'src', 'compiler'), { recursive: true });
  fs.mkdirSync(path.join(dataDirectory, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(dataDirectory, 'src', 'compiler', 'version.js'),
    `const VERSIONS = {\n  compiler: '${version}',\n};\n`
  );
  fs.writeFileSync(path.join(dataDirectory, 'scripts', 'cli.js'), '// cli\n');
  // A marker that exists only in the old install, to prove replacement.
  fs.writeFileSync(path.join(dataDirectory, 'marker-old.txt'), 'old\n');
  return dataDirectory;
}

function standardPackageFiles(version) {
  return {
    'src/compiler/version.js': `const VERSIONS = {\n  compiler: '${version}',\n};\n`,
    'scripts/cli.js': '// cli\n',
    'marker-new.txt': 'new\n'
  };
}

// A real gzip tarball built with the system tar — the same contract the
// installer relies on (tar presence is an established distribution
// requirement, and GNU tar's extract mode refuses absolute and ../ members).
function createReleaseTarball(workspace, version, files = standardPackageFiles(version)) {
  const packageDirectory = path.join(workspace, 'package');
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(packageDirectory, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  const tarballPath = path.join(workspace, `wizz-${version}.tgz`);
  execFileSync('tar', ['-czf', tarballPath, '-C', workspace, 'package']);
  return tarballPath;
}

// Serves the latest-release JSON (with download links pointing at itself)
// plus the given asset bytes, recording every request path so tests can
// assert exactly which endpoints were touched.
async function startReleaseServer(assetsByName, { repositoryPath = '/repos/o/r/releases/latest' } = {}) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    if (request.url === repositoryPath) {
      const release = {
        tag_name: `v${TARBALL_ASSET_PATTERN.exec(Object.keys(assetsByName)[0])[1]}`,
        html_url: 'https://github.com/o/r/releases/tag/latest',
        assets: Object.keys(assetsByName).map((name) => ({
          name,
          browser_download_url: `http://127.0.0.1:${server.address().port}/download/${name}`
        }))
      };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(release));
      return;
    }
    const assetName = decodeURIComponent(request.url.replace(/^.*\//, ''));
    if (assetsByName[assetName]) {
      response.end(assetsByName[assetName]);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const serverUrl = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
  return { server, serverUrl, requests };
}

// Builds one standard scenario: an old installation, a release tarball, and
// a server carrying both.
async function startScenario({ fromVersion, toVersion, tarballFiles }) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-update-test-'));
  const dataDirectory = createFakeInstall(workspace, fromVersion);
  const tarballPath = createReleaseTarball(workspace, toVersion, tarballFiles);
  const { server, serverUrl, requests } = await startReleaseServer({
    [path.basename(tarballPath)]: fs.readFileSync(tarballPath)
  });
  return { workspace, dataDirectory, server, serverUrl, requests };
}

function assertNoUpdateLeftovers(workspace) {
  const leftovers = fs.readdirSync(workspace).filter((entry) => entry.startsWith('.wizz-update'));
  assert.deepEqual(leftovers, []);
}

test('update swaps the managed installation for the newer release', async (t) => {
  const { workspace, dataDirectory, server, serverUrl } = await startScenario({ fromVersion: '1.9.0', toVersion: '2.0.0' });
  t.after(() => server.close());
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

  const result = await update({ dataDirectory, repository: 'o/r', apiBase: serverUrl });

  assert.deepEqual(result, {
    status: 'updated',
    fromVersion: '1.9.0',
    toVersion: '2.0.0',
    dataDirectory
  });
  assert.equal(readCompilerVersion(dataDirectory), '2.0.0');
  assert.equal(fs.existsSync(path.join(dataDirectory, 'marker-old.txt')), false);
  assert.equal(fs.existsSync(path.join(dataDirectory, 'marker-new.txt')), true);
  assertNoUpdateLeftovers(workspace);
});

test('update short-circuits without downloading when the release matches the install', async (t) => {
  const { workspace, dataDirectory, server, serverUrl, requests } = await startScenario({ fromVersion: '2.0.0', toVersion: '2.0.0' });
  t.after(() => server.close());
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

  const result = await update({ dataDirectory, repository: 'o/r', apiBase: serverUrl });

  assert.deepEqual(result, { status: 'current', fromVersion: '2.0.0', toVersion: '2.0.0', dataDirectory });
  // Only the API resolution ran; no asset was downloaded.
  assert.equal(requests.length, 1);
  assert.equal(fs.existsSync(path.join(dataDirectory, 'marker-old.txt')), true);
  assertNoUpdateLeftovers(workspace);
});

test('update refuses to downgrade a locally newer installation', async (t) => {
  const { workspace, dataDirectory, server, serverUrl, requests } = await startScenario({ fromVersion: '2.0.0', toVersion: '1.9.0' });
  t.after(() => server.close());
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

  const result = await update({ dataDirectory, repository: 'o/r', apiBase: serverUrl });

  assert.equal(result.status, 'newer-local');
  assert.equal(result.fromVersion, '2.0.0');
  assert.equal(result.latestVersion, '1.9.0');
  assert.equal(requests.length, 1);
  assert.equal(readCompilerVersion(dataDirectory), '2.0.0');
  assertNoUpdateLeftovers(workspace);
});

test('update fails before any network call when no managed installation exists', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-update-test-'));
  const { server, serverUrl, requests } = await startReleaseServer({ 'wizz-2.0.0.tgz': Buffer.from('unused') });
  t.after(() => server.close());
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const dataDirectory = path.join(workspace, 'wizz');

  await assert.rejects(
    update({ dataDirectory, repository: 'o/r', apiBase: serverUrl }),
    (error) => {
      assert.match(error.message, /No managed Wizz installation found at /);
      assert.match(error.message, /Install Wizz first/);
      return true;
    }
  );
  // The failure is offline-deterministic: not a single request was made.
  assert.equal(requests.length, 0);
  assertNoUpdateLeftovers(workspace);
});

test('update reports a corrupt tarball and leaves the old installation intact', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-update-test-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const dataDirectory = createFakeInstall(workspace, '1.9.0');
  const { server, serverUrl, requests } = await startReleaseServer({ 'wizz-2.0.0.tgz': Buffer.from('this is not a tarball') });
  t.after(() => server.close());
  void requests;

  await assert.rejects(
    update({ dataDirectory, repository: 'o/r', apiBase: serverUrl }),
    /could not be extracted/
  );
  assert.equal(readCompilerVersion(dataDirectory), '1.9.0');
  assertNoUpdateLeftovers(workspace);
});

test('update refuses a tarball with no Wizz package inside', async (t) => {
  const { workspace, dataDirectory, server, serverUrl } = await startScenario({
    fromVersion: '1.9.0',
    toVersion: '2.0.0',
    tarballFiles: {
      'src/compiler/version.js': "const VERSIONS = { compiler: '2.0.0' };\n",
      'unrelated.txt': 'not wizz\n'
    }
  });
  t.after(() => server.close());
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

  await assert.rejects(
    update({ dataDirectory, repository: 'o/r', apiBase: serverUrl }),
    /does not contain a Wizz package \(missing package\/scripts\/cli\.js\)/
  );
  assert.equal(readCompilerVersion(dataDirectory), '1.9.0');
  assertNoUpdateLeftovers(workspace);
});

test('update refuses a package whose version declaration is unreadable', async (t) => {
  const { workspace, dataDirectory, server, serverUrl } = await startScenario({
    fromVersion: '1.9.0',
    toVersion: '2.0.0',
    tarballFiles: {
      'scripts/cli.js': '// cli\n',
      'src/compiler/version.js': 'const SOMETHING_ELSE = 1;\n'
    }
  });
  t.after(() => server.close());
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

  await assert.rejects(
    update({ dataDirectory, repository: 'o/r', apiBase: serverUrl }),
    /does not contain a Wizz package \(missing package\/src\/compiler\/version\.js\)/
  );
  assert.equal(readCompilerVersion(dataDirectory), '1.9.0');
  assertNoUpdateLeftovers(workspace);
});

test('update asks for tar when the extractor is missing', async (t) => {
  const { workspace, dataDirectory, server, serverUrl } = await startScenario({ fromVersion: '1.9.0', toVersion: '2.0.0' });
  t.after(() => server.close());
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

  await assert.rejects(
    update({
      dataDirectory,
      repository: 'o/r',
      apiBase: serverUrl,
      spawnImpl: () => ({ status: null, error: { code: 'ENOENT' } })
    }),
    /requires tar/
  );
  assert.equal(readCompilerVersion(dataDirectory), '1.9.0');
  assertNoUpdateLeftovers(workspace);
});

test('update restores the previous installation when the swap fails', async (t) => {
  const { workspace, dataDirectory, server, serverUrl } = await startScenario({ fromVersion: '1.9.0', toVersion: '2.0.0' });
  t.after(() => server.close());
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

  let calls = 0;
  const renameImpl = (from, to) => {
    calls += 1;
    if (calls === 2) {
      throw new Error('injected rename failure');
    }
    return fs.renameSync(from, to);
  };

  await assert.rejects(
    update({ dataDirectory, repository: 'o/r', apiBase: serverUrl, renameImpl }),
    /The update failed and the previous installation was restored/
  );
  // The old installation was genuinely moved back into place.
  assert.equal(readCompilerVersion(dataDirectory), '1.9.0');
  assert.equal(fs.existsSync(path.join(dataDirectory, 'marker-old.txt')), true);
  assertNoUpdateLeftovers(workspace);
});

test('update preserves the only copy of the old installation when the restore itself fails', async (t) => {
  const { workspace, dataDirectory, server, serverUrl } = await startScenario({ fromVersion: '1.9.0', toVersion: '2.0.0' });
  t.after(() => server.close());
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

  let calls = 0;
  const renameImpl = (from, to) => {
    calls += 1;
    if (calls >= 2) {
      throw new Error('injected rename failure');
    }
    return fs.renameSync(from, to);
  };

  await assert.rejects(
    update({ dataDirectory, repository: 'o/r', apiBase: serverUrl, renameImpl }),
    (error) => {
      assert.match(error.message, /could not be restored/);
      assert.match(error.message, /Re-run the installer/);
      return true;
    }
  );
  // The staging directory holding staging/old must survive: it is now the
  // only copy of the previous installation.
  const leftover = fs.readdirSync(workspace).find((entry) => entry.startsWith('.wizz-update.'));
  assert.notEqual(leftover, undefined);
  assert.equal(fs.existsSync(path.join(workspace, leftover, 'old', 'src', 'compiler', 'version.js')), true);
});

test('a failure before the swap leaves the installation and staging untouched', async (t) => {
  const { workspace, dataDirectory, server, serverUrl } = await startScenario({ fromVersion: '1.9.0', toVersion: '2.0.0' });
  t.after(() => server.close());
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

  await assert.rejects(
    update({
      dataDirectory,
      repository: 'o/r',
      apiBase: serverUrl,
      renameImpl: () => { throw new Error('injected rename failure'); }
    }),
    /injected rename failure/
  );
  assert.equal(readCompilerVersion(dataDirectory), '1.9.0');
  assertNoUpdateLeftovers(workspace);
});

test('update refuses to run while another update holds the lock', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-update-test-'));
  const dataDirectory = createFakeInstall(workspace, '1.9.0');
  const { server, serverUrl, requests } = await startReleaseServer({ 'wizz-2.0.0.tgz': Buffer.from('unused') });
  t.after(() => server.close());
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, '.wizz-update.lock'));

  await assert.rejects(
    update({ dataDirectory, repository: 'o/r', apiBase: serverUrl }),
    (error) => {
      assert.match(error.message, /Another wizz update appears to be in progress/);
      assert.match(error.message, /\.wizz-update\.lock/);
      return true;
    }
  );
  assert.equal(requests.length, 0);
});

test('update resolves the release from the configured repository', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-update-test-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const dataDirectory = createFakeInstall(workspace, '1.9.0');
  const tarballPath = createReleaseTarball(workspace, '2.0.0');
  const { server, serverUrl, requests } = await startReleaseServer(
    { [path.basename(tarballPath)]: fs.readFileSync(tarballPath) },
    { repositoryPath: '/repos/my-fork/wizz.js/releases/latest' }
  );
  t.after(() => server.close());

  await update({ dataDirectory, repository: 'my-fork/wizz.js', apiBase: serverUrl });

  // The override reached the API, and the release was actually applied.
  assert.equal(requests[0], '/repos/my-fork/wizz.js/releases/latest');
  assert.equal(requests.length, 2);
  assert.equal(readCompilerVersion(dataDirectory), '2.0.0');
});

test('readCompilerVersion reads the declaration without requiring the module', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-update-test-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

  const installed = createFakeInstall(workspace, '1.10.1');
  assert.equal(readCompilerVersion(installed), '1.10.1');
  // An absent or malformed declaration is "no installation", not a crash.
  assert.equal(readCompilerVersion(path.join(workspace, 'absent')), null);
  fs.mkdirSync(path.join(workspace, 'wizz2', 'src', 'compiler'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'wizz2', 'src', 'compiler', 'version.js'), 'const NOPE = 1;\n');
  assert.equal(readCompilerVersion(path.join(workspace, 'wizz2')), null);
});

test('compareVersions compares numerically, segment by segment', () => {
  assert.equal(compareVersions('1.10.1', '1.10.1'), 0);
  // The numeric trap: a lexicographic compare would order 1.9 above 1.10.
  assert.equal(compareVersions('1.9.0', '1.10.0'), -1);
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
  assert.equal(compareVersions('1.10', '1.9'), 1);
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1);
  // Differing lengths compare as if padded with zeros.
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.equal(compareVersions('1.2', '1.2.1'), -1);
});

test('compareVersions rejects versions it cannot compare numerically', () => {
  assert.throws(() => compareVersions('1.x.0', '1.0.0'), /not a numeric dotted version/);
  assert.throws(() => compareVersions('01.0.0', '1.0.0'), /not a numeric dotted version/);
  assert.throws(() => compareVersions('1..0', '1.0.0'), /not a numeric dotted version/);
  assert.throws(() => compareVersions(42, '1.0.0'), /must be a string/);
});
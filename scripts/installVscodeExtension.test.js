const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { installVscodeExtension } = require('./installVscodeExtension');

// The fake release server carries the extension asset (and optionally the
// framework tarball, which the extension flow ignores) and counts requests.
async function startReleaseServer({ withVsix = true, vsixBytes = Buffer.from('vsix-bytes'), withTarball = true } = {}) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    if (request.url.endsWith('/releases/latest')) {
      const assets = [];
      if (withTarball) {
        assets.push({ name: 'wizz-2.0.0.tgz', browser_download_url: `http://127.0.0.1:${server.address().port}/download/wizz-2.0.0.tgz` });
      }
      if (withVsix) {
        assets.push({ name: 'wizz-vscode-0.1.0.vsix', browser_download_url: `http://127.0.0.1:${server.address().port}/download/wizz-vscode-0.1.0.vsix` });
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ tag_name: 'v2.0.0', html_url: 'https://github.com/o/r/releases/tag/v2.0.0', assets }));
      return;
    }
    if (request.url.endsWith('.vsix')) {
      response.end(vsixBytes);
      return;
    }
    if (request.url.endsWith('.tgz')) {
      response.end(Buffer.from('tarball'));
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

// Serves a release whose asset download always fails, to exercise cleanup.
async function startUnreachableAssetServer() {
  const server = http.createServer((request, response) => {
    if (request.url.endsWith('/releases/latest')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        tag_name: 'v2.0.0',
        html_url: 'https://github.com/o/r/releases/tag/v2.0.0',
        assets: [
          // Resolve requires the tarball asset to exist; its download is
          // never reached in this scenario. https keeps the URLs past the
          // release-layer validation so the failure lands in the download.
          { name: 'wizz-2.0.0.tgz', browser_download_url: 'https://unreachable.invalid/wizz-2.0.0.tgz' },
          { name: 'wizz-vscode-0.1.0.vsix', browser_download_url: 'https://unreachable.invalid/wizz-vscode-0.1.0.vsix' }
        ]
      }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const serverUrl = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
  return { server, serverUrl };
}

test('a missing code command fails before any download', async (t) => {
  const { server, serverUrl, requests } = await startReleaseServer();
  t.after(() => server.close());

  await assert.rejects(
    installVscodeExtension({
      repository: 'o/r',
      apiBase: serverUrl,
      spawnImpl: () => ({ status: null, error: { code: 'ENOENT' } })
    }),
    (error) => {
      assert.match(error.message, /The VS Code 'code' command was not found on PATH\./);
      // The manual path is offered, with the release page and the command.
      assert.match(error.message, /https:\/\/github\.com\/o\/r\/releases/);
      assert.match(error.message, /code --install-extension wizz-vscode-<version>\.vsix/);
      return true;
    }
  );
  // Probe-first: the failure is deterministic and downloaded nothing.
  assert.equal(requests.length, 0);
});

test('a failing code probe is treated the same as a missing binary', async (t) => {
  const { server, serverUrl, requests } = await startReleaseServer();
  t.after(() => server.close());

  await assert.rejects(
    installVscodeExtension({
      repository: 'o/r',
      apiBase: serverUrl,
      spawnImpl: () => ({ status: 1, stderr: 'not a code' })
    }),
    /'code' command was not found/
  );
  assert.equal(requests.length, 0);
});

test('the happy path probes, downloads the vsix, installs, and cleans up', async (t) => {
  const { server, serverUrl, requests } = await startReleaseServer();
  t.after(() => server.close());

  const tempDirectories = [];
  let spawnCalls = 0;
  const spawnImpl = () => {
    spawnCalls += 1;
    return { status: 0 };
  };
  const tempDirectoryFactory = () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-vscode-test-'));
    tempDirectories.push(directory);
    return directory;
  };

  const result = await installVscodeExtension({
    repository: 'o/r',
    apiBase: serverUrl,
    spawnImpl,
    tempDirectoryFactory
  });

  // The reported version is the EXTENSION version from the vsix name, not
  // the framework version carried by the tarball asset.
  assert.deepEqual(result, { status: 'installed', version: '0.1.0', vsixName: 'wizz-vscode-0.1.0.vsix', codeCommand: 'code' });
  assert.equal(spawnCalls, 2);
  assert.ok(requests.includes('/repos/o/r/releases/latest'));
  assert.ok(requests.some((url) => url.endsWith('/download/wizz-vscode-0.1.0.vsix')));
  // The temp directory was removed afterwards.
  assert.deepEqual(tempDirectories.filter((directory) => fs.existsSync(directory)), []);
});

test('the install spawn receives the downloaded vsix path as its last argument', async (t) => {
  const { server, serverUrl } = await startReleaseServer();
  t.after(() => server.close());

  const calls = [];
  const spawnImpl = (file, args) => {
    calls.push({ file, args });
    return { status: 0 };
  };

  await installVscodeExtension({ repository: 'o/r', apiBase: serverUrl, spawnImpl });

  assert.equal(calls.length, 2);
  // Platform-neutral: the probe carries --version, the install carries the
  // extension file (on win32 the args ride inside a cmd.exe invocation).
  assert.equal(calls[0].args.includes('--version'), true);
  assert.equal(calls[1].args.includes('--install-extension'), true);
  assert.equal(calls[1].args[calls[1].args.length - 1].endsWith('wizz-vscode-0.1.0.vsix'), true);
  // The downloaded file sat in a fresh temp directory, not the repo.
  assert.equal(calls[1].args[calls[1].args.length - 1].includes(os.tmpdir()), true);
});

test('a failed code install surfaces the exit status and stderr', async (t) => {
  const { server, serverUrl } = await startReleaseServer();
  t.after(() => server.close());

  let spawnCalls = 0;
  const spawnImpl = () => {
    spawnCalls += 1;
    return spawnCalls === 1 ? { status: 0 } : { status: 3, stderr: 'boom: cannot install' };
  };

  await assert.rejects(
    installVscodeExtension({ repository: 'o/r', apiBase: serverUrl, spawnImpl }),
    (error) => {
      assert.match(error.message, /Installing the Wizz VS Code extension failed \(exit 3\)/);
      assert.match(error.message, /boom: cannot install/);
      return true;
    }
  );
});

test('a release without the extension asset is refused before downloading', async (t) => {
  const { server, serverUrl, requests } = await startReleaseServer({ withVsix: false });
  t.after(() => server.close());

  await assert.rejects(
    installVscodeExtension({
      repository: 'o/r',
      apiBase: serverUrl,
      spawnImpl: () => ({ status: 0 })
    }),
    (error) => {
      assert.match(error.message, /no wizz-vscode-<version>\.vsix asset/);
      assert.match(error.message, /download the extension manually/);
      return true;
    }
  );
  // Only the API call happened; no asset download was attempted.
  assert.equal(requests.length, 1);
});

test('a failed download removes the temporary directory', async (t) => {
  const { server, serverUrl } = await startUnreachableAssetServer();
  t.after(() => server.close());

  const tempDirectories = [];
  const tempDirectoryFactory = () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-vscode-test-'));
    tempDirectories.push(directory);
    return directory;
  };

  await assert.rejects(
    installVscodeExtension({
      repository: 'o/r',
      apiBase: serverUrl,
      // The probe would otherwise stop execution on machines (CI runners)
      // without a `code` command, and the test is about the download.
      spawnImpl: () => ({ status: 0 }),
      tempDirectoryFactory
    }),
    /Could not download/
  );
  assert.deepEqual(tempDirectories.filter((directory) => fs.existsSync(directory)), []);
});

// The PATH-stub technique: a fake `code` shell script on PATH records its
// invocations, exercising a real process spawn end-to-end. Skipped on
// win32, like the installer tests.
test('installs through a real code binary found on PATH', { skip: process.platform === 'win32' }, async (t) => {
  const binDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-code-bin-'));
  t.after(() => fs.rmSync(binDirectory, { recursive: true, force: true }));
  const invocationLog = path.join(binDirectory, 'invocations.log');
  fs.writeFileSync(
    path.join(binDirectory, 'code'),
    `#!/bin/sh\nprintf '%s\\n' "$@" >> "${invocationLog}"\n`,
    { mode: 0o755 }
  );

  const { server, serverUrl } = await startReleaseServer();
  t.after(() => server.close());

  // Real spawns, but with a PATH that finds the stub instead of the
  // developer's actual VS Code installation.
  const spawnImpl = (file, args, options) => spawnSync(file, args, {
    ...options,
    env: { ...process.env, PATH: `${binDirectory}:${process.env.PATH}` }
  });

  const result = await installVscodeExtension({ repository: 'o/r', apiBase: serverUrl, spawnImpl });

  assert.equal(result.status, 'installed');
  const invocations = fs.readFileSync(invocationLog, 'utf8');
  assert.match(invocations, /--version/);
  assert.match(invocations, /--install-extension/);
  assert.match(invocations, /wizz-vscode-0\.1\.0\.vsix/);
});
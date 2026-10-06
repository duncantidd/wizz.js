const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  DEFAULT_REPOSITORY,
  TARBALL_ASSET_PATTERN,
  VSIX_ASSET_PATTERN,
  MAX_REDIRECTS,
  resolveLatestRelease,
  downloadToFile,
  verifyFileDigest
} = require('./releaseAssets');

// A local HTTP server stands in for the GitHub API so every path — success,
// error bodies, and asset URLs — is exercised offline. The apiBase points at
// the server, which also licenses http:// asset URLs on the same host (the
// documented https-or-api-host rule).
async function startServer(handler) {
  const server = http.createServer(handler);
  const serverUrl = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
  return { server, serverUrl };
}

function respondJson(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
}

function sha256Of(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function releasePayload({ serverUrl, tarballName = 'wizz-2.0.0.tgz', vsixName = 'wizz-vscode-0.1.0.vsix', tarballUrl, vsixUrl, tarballDigest, vsixDigest } = {}) {
  const assets = [{
    name: tarballName || 'wizz-2.0.0.tgz',
    browser_download_url: tarballUrl || `https://objects.example/${tarballName || 'wizz-2.0.0.tgz'}`
  }];
  if (tarballDigest !== undefined) {
    assets[0].digest = tarballDigest;
  }
  if (vsixName !== null) {
    assets.push({
      name: vsixName || 'wizz-vscode-0.1.0.vsix',
      browser_download_url: vsixUrl || `https://objects.example/${vsixName || 'wizz-vscode-0.1.0.vsix'}`
    });
    if (vsixDigest !== undefined) {
      assets[1].digest = vsixDigest;
    }
  }
  return { tag_name: 'v2.0.0', html_url: 'https://github.com/o/r/releases/tag/v2.0.0', assets };
}

function createSandboxDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-release-assets-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('resolveLatestRelease returns both assets and derives the version from the tarball name', async (t) => {
  const requests = [];
  const { server, serverUrl } = await startServer((request, response) => {
    requests.push(request.url);
    respondJson(response, 200, releasePayload({}));
  });
  t.after(() => server.close());

  const release = await resolveLatestRelease({ repository: 'o/r', apiBase: serverUrl });

  assert.equal(release.version, '2.0.0');
  assert.equal(release.tag, 'v2.0.0');
  assert.equal(release.htmlUrl, 'https://github.com/o/r/releases/tag/v2.0.0');
  assert.equal(release.tarballName, 'wizz-2.0.0.tgz');
  assert.equal(release.tarballUrl, 'https://objects.example/wizz-2.0.0.tgz');
  assert.equal(release.vsixName, 'wizz-vscode-0.1.0.vsix');
  assert.equal(release.vsixUrl, 'https://objects.example/wizz-vscode-0.1.0.vsix');
  assert.deepEqual(requests, ['/repos/o/r/releases/latest']);
});

test('resolveLatestRelease refuses a release with no framework tarball', async (t) => {
  const { server, serverUrl } = await startServer((request, response) => {
    respondJson(response, 200, releasePayload({ tarballName: 'other-project-1.0.0.tgz' }));
  });
  t.after(() => server.close());

  await assert.rejects(
    resolveLatestRelease({ repository: 'o/r', apiBase: serverUrl }),
    /no wizz-<version>\.tgz asset/
  );
});

test('resolveLatestRelease tolerates a release without the extension asset', async (t) => {
  const { server, serverUrl } = await startServer((request, response) => {
    respondJson(response, 200, releasePayload({ vsixName: null }));
  });
  t.after(() => server.close());

  const release = await resolveLatestRelease({ repository: 'o/r', apiBase: serverUrl });
  assert.equal(release.version, '2.0.0');
  assert.equal(release.vsixName, null);
  assert.equal(release.vsixUrl, null);
});

test('resolveLatestRelease surfaces GitHub API error bodies verbatim', async (t) => {
  const { server, serverUrl } = await startServer((request, response) => {
    respondJson(response, 200, { message: 'API rate limit exceeded' });
  });
  t.after(() => server.close());

  await assert.rejects(
    resolveLatestRelease({ repository: 'o/r', apiBase: serverUrl }),
    /GitHub API error: API rate limit exceeded/
  );
});

test('resolveLatestRelease refuses a body that is not valid JSON', async (t) => {
  const { server, serverUrl } = await startServer((request, response) => {
    respondJson(response, 200, '<html>not json</html>');
  });
  t.after(() => server.close());

  await assert.rejects(
    resolveLatestRelease({ repository: 'o/r', apiBase: serverUrl }),
    /not valid JSON/
  );
});

test('resolveLatestRelease reports an unresolvable release with the installer guidance', async (t) => {
  const { server, serverUrl } = await startServer((request, response) => {
    respondJson(response, 404, { message: 'Not Found' });
  });
  t.after(() => server.close());

  await assert.rejects(
    resolveLatestRelease({ repository: 'o/r', apiBase: serverUrl }),
    (error) => {
      assert.match(error.message, /Could not resolve the latest Wizz release/);
      assert.match(error.message, /private or have no published releases yet/);
      return true;
    }
  );
});

test('resolveLatestRelease refuses http asset URLs on foreign hosts', async (t) => {
  const { server, serverUrl } = await startServer((request, response) => {
    respondJson(response, 200, releasePayload({ tarballUrl: 'http://evil.example/wizz-2.0.0.tgz' }));
  });
  t.after(() => server.close());

  await assert.rejects(
    resolveLatestRelease({ repository: 'o/r', apiBase: serverUrl }),
    /only https:\/\/ URLs are allowed/
  );
});

test('resolveLatestRelease accepts an http asset URL on the API host itself', async (t) => {
  const { server, serverUrl } = await startServer((request, response) => {
    respondJson(response, 200, releasePayload({ tarballUrl: `${serverUrl}/download/wizz-2.0.0.tgz` }));
  });
  t.after(() => server.close());

  const release = await resolveLatestRelease({ repository: 'o/r', apiBase: serverUrl });
  assert.equal(release.tarballUrl, `${serverUrl}/download/wizz-2.0.0.tgz`);
});

test('resolveLatestRelease validates the repository shape before any network call', async (t) => {
  const { server, serverUrl } = await startServer(() => {
    throw new Error('the server must never be reached for a malformed repository');
  });
  t.after(() => server.close());

  for (const repository of ['no-slash', 'o/r?x', 'o/r/releases', '']) {
    await assert.rejects(
      resolveLatestRelease({ repository, apiBase: serverUrl }),
      /owner\/name repository pair/
    );
  }
});

test('downloadToFile streams the asset bytes to the destination', async (t) => {
  const bytes = Buffer.from('wizz-release-tarball-bytes-0123456789');
  const { server, serverUrl } = await startServer((request, response) => {
    response.end(bytes);
  });
  t.after(() => server.close());
  const destination = path.join(createSandboxDirectory(t), 'wizz-2.0.0.tgz');

  const result = await downloadToFile(`${serverUrl}/download/wizz-2.0.0.tgz`, destination);

  assert.equal(result.bytes, bytes.length);
  assert.ok(fs.readFileSync(destination).equals(bytes));
});

test('downloadToFile reports the HTTP status of a failed asset request', async (t) => {
  const { server, serverUrl } = await startServer((request, response) => {
    respondJson(response, 500, { message: 'server error' });
  });
  t.after(() => server.close());
  const destination = path.join(createSandboxDirectory(t), 'wizz-2.0.0.tgz');

  await assert.rejects(
    downloadToFile(`${serverUrl}/download/wizz-2.0.0.tgz`, destination),
    /Could not download wizz-2\.0\.0\.tgz from .* \(HTTP 500\)/
  );
});

test('downloadToFile reports an interrupted transfer instead of a partial file success', async (t) => {
  const { server, serverUrl } = await startServer((request, response) => {
    response.writeHead(200, { 'content-length': '1024' });
    // Destroy only after the partial chunk is flushed, so the failure lands
    // in body consumption (the pipeline) rather than in the fetch handshake.
    response.write('partial', () => response.destroy());
  });
  t.after(() => server.close());
  const destination = path.join(createSandboxDirectory(t), 'wizz-2.0.0.tgz');

  await assert.rejects(
    downloadToFile(`${serverUrl}/download/wizz-2.0.0.tgz`, destination),
    /interrupted/
  );
});

test('downloadToFile reports an unreachable host through the download error', async (t) => {
  const destination = path.join(createSandboxDirectory(t), 'wizz-2.0.0.tgz');

  await assert.rejects(
    downloadToFile('http://127.0.0.1:1/wizz-2.0.0.tgz', destination),
    /Could not download wizz-2\.0\.0\.tgz/
  );
});

test('resolveLatestRelease surfaces the sha256 digests the release publishes', async (t) => {
  const bytes = Buffer.from('tarball-bytes');
  const vsixBytes = Buffer.from('vsix-bytes');
  const { server, serverUrl } = await startServer((request, response) => {
    respondJson(response, 200, releasePayload({ tarballDigest: sha256Of(bytes), vsixDigest: sha256Of(vsixBytes) }));
  });
  t.after(() => server.close());

  const release = await resolveLatestRelease({ repository: 'o/r', apiBase: serverUrl });
  assert.equal(release.tarballDigest, sha256Of(bytes));
  assert.equal(release.vsixDigest, sha256Of(vsixBytes));
});

test('resolveLatestRelease tolerates a release with no digest field (callers fail closed)', async (t) => {
  const { server, serverUrl } = await startServer((request, response) => {
    respondJson(response, 200, releasePayload({}));
  });
  t.after(() => server.close());

  const release = await resolveLatestRelease({ repository: 'o/r', apiBase: serverUrl });
  assert.equal(release.tarballDigest, null);
  assert.equal(release.vsixDigest, null);
});

test('resolveLatestRelease refuses a digest that is not GitHub published shape', async (t) => {
  for (const bogus of ['md5:abc', 'sha256:not-hex', 'sha256:' + 'g'.repeat(64), 'sha256:' + 'a'.repeat(63), 42]) {
    const { server, serverUrl } = await startServer((request, response) => {
      respondJson(response, 200, releasePayload({ tarballDigest: bogus }));
    });
    t.after(() => server.close());

    await assert.rejects(
      resolveLatestRelease({ repository: 'o/r', apiBase: serverUrl }),
      /unsupported asset digest/
    );
  }
});

test('verifyFileDigest accepts the matching file and refuses tampered bytes', async (t) => {
  const directory = createSandboxDirectory(t);
  const bytes = Buffer.from('wizz-release-tarball-bytes-0123456789');
  const intact = path.join(directory, 'intact.tgz');
  const tampered = path.join(directory, 'tampered.tgz');
  fs.writeFileSync(intact, bytes);
  fs.writeFileSync(tampered, Buffer.concat([bytes, Buffer.from(' and then some')]));

  await verifyFileDigest(intact, sha256Of(bytes));
  await assert.rejects(
    verifyFileDigest(tampered, sha256Of(bytes)),
    /integrity check for tampered\.tgz failed/
  );
});

test('verifyFileDigest refuses an unsupported digest before reading the file', async (t) => {
  const directory = createSandboxDirectory(t);
  const file = path.join(directory, 'wizz.tgz');
  fs.writeFileSync(file, 'anything');

  await assert.rejects(verifyFileDigest(file, ''), /unsupported digest/);
  await assert.rejects(verifyFileDigest(file, 'md5:deadbeef'), /unsupported digest/);
  await assert.rejects(verifyFileDigest(file, 'sha256:short'), /unsupported digest/);
});

test('verifyFileDigest streams a large file without loading it whole into memory', async (t) => {
  const directory = createSandboxDirectory(t);
  // A few MB of pseudo-random bytes: small enough to build fast, large
  // enough to prove chunked streaming hashes the whole file.
  const bytes = crypto.randomBytes(4 * 1024 * 1024);
  const file = path.join(directory, 'big.tgz');
  fs.writeFileSync(file, bytes);

  await verifyFileDigest(file, sha256Of(bytes));
  const flipped = Buffer.from(bytes);
  flipped[flipped.length - 1] ^= 0xff;
  fs.writeFileSync(file, flipped);
  await assert.rejects(verifyFileDigest(file, sha256Of(bytes)), /integrity check/);
});

test('downloadToFile follows a redirect chain on the allowed hosts', async (t) => {
  const bytes = Buffer.from('wizz-redirected-tarball-bytes');
  const { server, serverUrl } = await startServer((request, response) => {
    if (request.url === '/download/wizz-2.0.0.tgz') {
      response.writeHead(302, { location: '/objects/wizz-2.0.0.tgz' });
      response.end();
      return;
    }
    if (request.url === '/objects/wizz-2.0.0.tgz') {
      // A second hop with a relative location resolves against the current URL.
      response.writeHead(302, { location: 'final/wizz-2.0.0.tgz' });
      response.end();
      return;
    }
    response.end(bytes);
  });
  t.after(() => server.close());
  const destination = path.join(createSandboxDirectory(t), 'wizz-2.0.0.tgz');

  const result = await downloadToFile(`${serverUrl}/download/wizz-2.0.0.tgz`, destination);
  assert.equal(result.bytes, bytes.length);
  assert.ok(fs.readFileSync(destination).equals(bytes));
});

test('downloadToFile refuses a redirect that downgrades to http on a foreign host', async (t) => {
  const { server, serverUrl } = await startServer((request, response) => {
    // localhost is still loopback, so curl would happily fetch it — the
    // refusal must come from the host check, not from DNS.
    response.writeHead(302, { location: `http://localhost:${server.address().port}/evil.tgz` });
    response.end();
  });
  t.after(() => server.close());
  const destination = path.join(createSandboxDirectory(t), 'wizz-2.0.0.tgz');

  await assert.rejects(
    downloadToFile(`${serverUrl}/download/wizz-2.0.0.tgz`, destination),
    /Refusing to follow a redirect to .*: only https:\/\/ URLs are allowed/
  );
  assert.equal(fs.existsSync(destination), false);
});

test('downloadToFile caps the redirect chain', async (t) => {
  let hops = 0;
  const { server, serverUrl } = await startServer((request, response) => {
    hops += 1;
    response.writeHead(302, { location: `/hop${hops}` });
    response.end();
  });
  t.after(() => server.close());
  const destination = path.join(createSandboxDirectory(t), 'wizz-2.0.0.tgz');

  await assert.rejects(
    downloadToFile(`${serverUrl}/download/wizz-2.0.0.tgz`, destination),
    new RegExp(`more than ${MAX_REDIRECTS} redirects`)
  );
  // Exactly MAX_REDIRECTS + 1 requests were made before the refusal.
  assert.equal(hops, MAX_REDIRECTS + 1);
});

test('downloadToFile refuses a redirect with no location header', async (t) => {
  const { server, serverUrl } = await startServer((request, response) => {
    response.writeHead(302);
    response.end();
  });
  t.after(() => server.close());
  const destination = path.join(createSandboxDirectory(t), 'wizz-2.0.0.tgz');

  await assert.rejects(
    downloadToFile(`${serverUrl}/download/wizz-2.0.0.tgz`, destination),
    /redirected without a location header/
  );
});

test('downloadToFile keeps one total-time budget across the redirect chain', async (t) => {
  // The budget must cover the whole chain, not restart per hop: a fake that
  // always answers "redirect" with a small delay burns the short budget on
  // an early hop, and the next hop must find it exhausted (rather than get
  // a fresh allowance). The per-hop failure would instead surface as the
  // redirect-cap error, so the message distinguishes the two.
  const destination = path.join(createSandboxDirectory(t), 'wizz-2.0.0.tgz');
  const slowFake = async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { status: 302, headers: new Map([['location', '/next']]), body: null };
  };

  await assert.rejects(
    downloadToFile('https://objects.example/wizz-2.0.0.tgz', destination, {
      fetchImpl: slowFake,
      timeoutMs: 10
    }),
    /time budget/
  );
});

test('the asset patterns keep the framework and extension versions independent', () => {
  const tarball = TARBALL_ASSET_PATTERN.exec('wizz-1.10.1.tgz');
  const vsix = VSIX_ASSET_PATTERN.exec('wizz-vscode-0.1.0.vsix');
  assert.equal(tarball[1], '1.10.1');
  assert.equal(vsix[1], '0.1.0');
  // The installer's tgz regex and the vsix pattern can never cross-match.
  assert.equal(TARBALL_ASSET_PATTERN.test('wizz-vscode-0.1.0.vsix'), false);
  assert.equal(VSIX_ASSET_PATTERN.test('wizz-1.10.1.tgz'), false);
  assert.equal(DEFAULT_REPOSITORY, 'duncantidd/wizz.js');
});
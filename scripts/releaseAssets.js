'use strict';

// Shared GitHub release layer for the CLI's network commands (`wizz update`
// and `wizz install-vscode-extension`). Resolves the latest release of the
// wizz.js repository and downloads release assets. Zero dependencies: the
// global fetch (Node 18+) does the HTTP work the installer does with curl.
//
// One API call serves both commands: the release carries the framework
// tarball (wizz-<version>.tgz) and, independently versioned, the VS Code
// extension package (wizz-vscode-<version>.vsix).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const DEFAULT_REPOSITORY = 'duncantidd/wizz.js';
const DEFAULT_API_BASE = 'https://api.github.com';
// The extension version is independent of the framework version, so neither
// pattern may assume the two match. The tarball name is the authoritative
// framework version (its capture group feeds the update comparison); the
// vsix name carries the extension version.
const TARBALL_ASSET_PATTERN = /^wizz-(\d+\.\d+\.\d+)\.tgz$/;
const VSIX_ASSET_PATTERN = /^wizz-vscode-(\d+\.\d+\.\d+)\.vsix$/;
// The repository override must be an owner/name pair before it is ever
// composed into a URL, so a crafted value cannot add path or query segments.
const REPOSITORY_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const API_TIMEOUT_MS = 15000;
// A total-time budget for the download, not an idle timeout: a slow link
// gets a clear retryable failure rather than a hung process.
const DOWNLOAD_TIMEOUT_MS = 120000;
// The redirect chain a GitHub asset download may traverse (github.com →
// objects.githubusercontent.com is the expected shape). More hops than this
// is either a loop or an attempt to launder the destination, not a CDN.
const MAX_REDIRECTS = 5;
// GitHub publishes the sha256 of every release asset in the API response
// (`digest: "sha256:<hex>"`). That field is the integrity anchor for the
// download: the API is reached over TLS, so it is an independent-enough
// channel to catch tampering, truncation, and hostile redirects of the
// asset itself. A fully in-band attacker (one who controls the API
// response) can rewrite the digest too — closing that needs an out-of-band
// signature, which the zero-dependency rule defers until the project
// publishes one.
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/i;

// The single choke point for download-URL trust: a release asset must be
// served over https, or from the operator's own API host (the test seam
// that points both the API and the assets at one local server). A hostile
// API response can therefore never downgrade a download to http:// on a
// third-party host.
function validatedDownloadUrl(urlString, apiHost) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error(`The release carries an invalid asset URL: ${urlString}`);
  }
  if (url.protocol !== 'https:' && url.host !== apiHost) {
    throw new Error(`Refusing to download a release asset from ${urlString}: only https:// URLs are allowed.`);
  }
  return urlString;
}

// A digest arrives from the API response, so it is untrusted input too: it
// must be exactly GitHub's published shape before anything compares it.
// Null means the release predates the digest field; callers decide whether
// that is fatal (both in-tree callers fail closed).
function validatedDigest(asset) {
  const digest = asset && asset.digest;
  if (digest == null) {
    return null;
  }
  if (typeof digest !== 'string' || !DIGEST_PATTERN.test(digest)) {
    throw new Error(`The release carries an unsupported asset digest (${JSON.stringify(String(digest))}); expected "sha256:<64 hex characters>".`);
  }
  return digest.toLowerCase();
}

async function resolveLatestRelease({
  repository = DEFAULT_REPOSITORY,
  apiBase = DEFAULT_API_BASE,
  fetchImpl = fetch
} = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error(`"${repository}" is not an owner/name repository pair.`);
  }

  const endpoint = `${apiBase}/repos/${repository}/releases/latest`;
  let response;
  try {
    response = await fetchImpl(endpoint, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'wizz-cli' },
      signal: AbortSignal.timeout(API_TIMEOUT_MS)
    });
  } catch (error) {
    throw new Error(`Could not reach ${endpoint} (${error.message}).`);
  }
  if (!response.ok) {
    throw new Error(`Could not resolve the latest Wizz release from ${endpoint}. The repository may be private or have no published releases yet.`);
  }

  let payload;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    throw new Error('The GitHub API returned a response that is not valid JSON.');
  }
  // Rate limits and auth failures arrive as a 200-shaped JSON body with a
  // message field; surface the message rather than a confusing asset error.
  if (payload.message) {
    throw new Error(`GitHub API error: ${payload.message}`);
  }

  const assets = payload.assets || [];
  const tarball = assets.find((candidate) => TARBALL_ASSET_PATTERN.test(candidate.name));
  if (!tarball) {
    throw new Error('The latest release carries no wizz-<version>.tgz asset.');
  }
  // A release that predates the extension packaging has no vsix; that is not
  // a resolution error — each command decides whether the asset is required.
  const vsix = assets.find((candidate) => VSIX_ASSET_PATTERN.test(candidate.name));

  const apiHost = new URL(apiBase).host;
  return {
    version: TARBALL_ASSET_PATTERN.exec(tarball.name)[1],
    tag: payload.tag_name,
    htmlUrl: payload.html_url,
    tarballName: tarball.name,
    tarballUrl: validatedDownloadUrl(tarball.browser_download_url, apiHost),
    tarballDigest: validatedDigest(tarball),
    vsixName: vsix ? vsix.name : null,
    vsixUrl: vsix ? validatedDownloadUrl(vsix.browser_download_url, apiHost) : null,
    vsixDigest: vsix ? validatedDigest(vsix) : null
  };
}

// Streams a release asset to destinationPath. Callers download into a
// staging directory they own (mkdtemp) so a partial download never lands at
// a final path and is removed by the caller's cleanup.
// Unlike the installer's curl, undici ignores HTTP_PROXY/HTTPS_PROXY by
// default — an accepted behavioral difference, noted here for operators
// behind a proxy.
//
// Redirects are followed manually rather than by fetch's default redirector:
// the built-in behavior follows any number of hops to any host and is
// content to upgrade nothing about the scheme, so a hostile redirect chain
// could walk the tarball bytes through an http:// hop. Every hop is re-run
// through the same https-or-first-host rule the initial URL gets, hops are
// capped, and the whole transfer shares one total-time budget (per-hop
// signals would let a slow chain stretch the download indefinitely).
async function downloadToFile(url, destinationPath, { fetchImpl = fetch, timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
  let firstUrl;
  try {
    firstUrl = new URL(url);
  } catch {
    throw new Error(`Refusing to download from an invalid URL: ${url}`);
  }

  const deadline = Date.now() + timeoutMs;
  let currentUrl = url;
  let response;
  for (let hop = 0; ; hop += 1) {
    if (hop > MAX_REDIRECTS) {
      throw new Error(`The download of ${path.basename(destinationPath)} followed more than ${MAX_REDIRECTS} redirects; refusing to continue.`);
    }
    const hopUrl = new URL(currentUrl);
    if (hopUrl.protocol !== 'https:' && hopUrl.host !== firstUrl.host) {
      throw new Error(`Refusing to follow a redirect to ${currentUrl}: only https:// URLs are allowed.`);
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`The download of ${path.basename(destinationPath)} exceeded its ${timeoutMs}ms time budget.`);
    }
    try {
      response = await fetchImpl(currentUrl, {
        headers: { 'user-agent': 'wizz-cli' },
        // No automatic following: the loop above validates every hop.
        redirect: 'manual',
        signal: AbortSignal.timeout(remainingMs)
      });
    } catch (error) {
      throw new Error(`Could not download ${path.basename(destinationPath)} from ${currentUrl} (${error.message}).`);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new Error(`The download of ${path.basename(destinationPath)} was redirected without a location header.`);
      }
      // Resolve relative locations against the current hop, as a browser
      // would, then keep walking. A malformed location is a refusal, not a
      // raw TypeError leaking out of the URL constructor.
      let nextUrl;
      try {
        nextUrl = new URL(location, currentUrl);
      } catch {
        throw new Error(`The download of ${path.basename(destinationPath)} was redirected to an invalid URL: ${location}`);
      }
      currentUrl = nextUrl.toString();
      continue;
    }
    break;
  }

  if (!response.ok || !response.body) {
    throw new Error(`Could not download ${path.basename(destinationPath)} from ${currentUrl} (HTTP ${response.status}).`);
  }

  try {
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destinationPath));
  } catch (error) {
    throw new Error(`The download of ${path.basename(destinationPath)} was interrupted (${error.message}).`);
  }
  return { bytes: fs.statSync(destinationPath).size };
}

// Verifies a downloaded asset against the sha256 digest the release API
// published for it, before the caller lets its bytes anywhere near
// execution. The file is streamed so a large tarball never sits whole in
// memory, and the comparison uses timingSafeEqual on fixed-length buffers —
// the digest is a secret-adjacent value by convention, so the comparison
// costs nothing to do properly.
async function verifyFileDigest(filePath, digest) {
  const match = DIGEST_PATTERN.exec(digest || '');
  if (!match) {
    throw new Error(`Refusing to verify ${path.basename(filePath)} against an unsupported digest (${JSON.stringify(String(digest))}); expected "sha256:<64 hex characters>".`);
  }
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk);
  }
  const expected = Buffer.from(match[0].slice('sha256:'.length), 'hex');
  const actual = hash.digest();
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    throw new Error(`The integrity check for ${path.basename(filePath)} failed: the downloaded bytes do not match the digest the release published. The download may be tampered with, truncated, or stale; retry or download the release manually.`);
  }
  return true;
}

module.exports = {
  DEFAULT_REPOSITORY,
  DEFAULT_API_BASE,
  TARBALL_ASSET_PATTERN,
  VSIX_ASSET_PATTERN,
  API_TIMEOUT_MS,
  DOWNLOAD_TIMEOUT_MS,
  MAX_REDIRECTS,
  DIGEST_PATTERN,
  resolveLatestRelease,
  downloadToFile,
  verifyFileDigest
};
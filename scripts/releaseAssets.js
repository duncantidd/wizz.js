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
    vsixName: vsix ? vsix.name : null,
    vsixUrl: vsix ? validatedDownloadUrl(vsix.browser_download_url, apiHost) : null
  };
}

// Streams a release asset to destinationPath. Callers download into a
// staging directory they own (mkdtemp) so a partial download never lands at
// a final path and is removed by the caller's cleanup.
// Unlike the installer's curl, undici ignores HTTP_PROXY/HTTPS_PROXY by
// default — an accepted behavioral difference, noted here for operators
// behind a proxy.
async function downloadToFile(url, destinationPath, { fetchImpl = fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { 'user-agent': 'wizz-cli' },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
    });
  } catch (error) {
    throw new Error(`Could not download ${path.basename(destinationPath)} from ${url} (${error.message}).`);
  }
  if (!response.ok || !response.body) {
    throw new Error(`Could not download ${path.basename(destinationPath)} from ${url} (HTTP ${response.status}).`);
  }

  try {
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destinationPath));
  } catch (error) {
    throw new Error(`The download of ${path.basename(destinationPath)} was interrupted (${error.message}).`);
  }
  return { bytes: fs.statSync(destinationPath).size };
}

module.exports = {
  DEFAULT_REPOSITORY,
  DEFAULT_API_BASE,
  TARBALL_ASSET_PATTERN,
  VSIX_ASSET_PATTERN,
  API_TIMEOUT_MS,
  DOWNLOAD_TIMEOUT_MS,
  resolveLatestRelease,
  downloadToFile
};
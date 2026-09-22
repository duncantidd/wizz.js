'use strict';

// `wizz install-vscode-extension` — download the Wizz VS Code extension
// (.vsix) from the latest GitHub release and install it through the `code`
// command. The module is silent: it returns a result object or throws, and
// scripts/cli.js owns all printing (the house style shared with init.js).
//
// Ordering is deliberate: the `code` probe happens BEFORE any network work,
// so a machine without VS Code fails fast with manual-download instructions
// instead of after a wasted download.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  DEFAULT_REPOSITORY,
  VSIX_ASSET_PATTERN,
  resolveLatestRelease,
  downloadToFile
} = require('./releaseAssets');

// Node >= 18.20 refuses to spawn .cmd/.bat shims without a shell
// (CVE-2024-27980), and shell:true is off the table here. On Windows the
// probe and install therefore go through cmd.exe itself, spawned with an
// argument array; the single command string is assembled from the constant
// command name plus paths this module created itself. Embedded quotes are
// stripped rather than half-escaped — cmd has no safe escape for them and
// the paths never contain user input.
function codeInvocation(command, args) {
  if (process.platform !== 'win32') {
    return { file: command, args };
  }
  const rendered = [command, ...args].map((value) => `"${String(value).replace(/"/g, '')}"`).join(' ');
  return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', rendered] };
}

function stderrTail(spawnResult) {
  const detail = (spawnResult.stderr || spawnResult.error?.message || '').trim();
  if (detail.length <= 2000) {
    return detail;
  }
  return `…${detail.slice(-2000)}`;
}

async function installVscodeExtension({
  repository = DEFAULT_REPOSITORY,
  apiBase,
  fetchImpl,
  spawnImpl = spawnSync,
  // Test seam: records and returns a directory the caller controls.
  tempDirectoryFactory = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-vscode-'))
} = {}) {
  // Probe first, download nothing: a missing `code` is answered with the
  // manual path, not a silent half-install.
  const probePlan = codeInvocation('code', ['--version']);
  const probe = spawnImpl(probePlan.file, probePlan.args, { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    throw new Error(`The VS Code 'code' command was not found on PATH. Install VS Code or add its bin directory to PATH, or download wizz-vscode-<version>.vsix manually from https://github.com/${repository}/releases and run: code --install-extension wizz-vscode-<version>.vsix`);
  }

  const release = await resolveLatestRelease({ repository, apiBase, fetchImpl });
  if (!release.vsixUrl || !release.vsixName) {
    throw new Error(`The latest release carries no wizz-vscode-<version>.vsix asset; download the extension manually from ${release.htmlUrl}.`);
  }

  // Re-installing the same version is allowed and idempotent; querying the
  // installed extension set would require parsing `code --list-extensions`
  // output, which is not worth the fragility here (conservative assumption).
  const tempDirectory = tempDirectoryFactory();
  try {
    const vsixPath = path.join(tempDirectory, release.vsixName);
    await downloadToFile(release.vsixUrl, vsixPath, { fetchImpl });

    const installPlan = codeInvocation('code', ['--install-extension', vsixPath]);
    const install = spawnImpl(installPlan.file, installPlan.args, { encoding: 'utf8' });
    if (install.error || install.status !== 0) {
      const exitDescription = install.error ? install.error.code : install.status;
      throw new Error(`Installing the Wizz VS Code extension failed (exit ${exitDescription}):\n${stderrTail(install)}`);
    }

    return {
      status: 'installed',
      version: VSIX_ASSET_PATTERN.exec(release.vsixName)[1],
      vsixName: release.vsixName,
      codeCommand: 'code'
    };
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
}

module.exports = { installVscodeExtension };
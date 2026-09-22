'use strict';

// `wizz update` — self-update the managed installation (the data directory
// the installer created) from the latest GitHub release. The command module
// is silent: it resolves and returns a result object, and scripts/cli.js
// owns all printing (the house style shared with init.js).
//
// The swap mirrors scripts/install-cli.sh's staging-directory layout, with
// one improvement: the old installation is renamed aside rather than
// deleted, so a failed swap rolls back instead of leaving nothing behind.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { resolveLatestRelease, downloadToFile } = require('./releaseAssets');

// The current version is read from the installation's version.js source —
// never with require(), which would cache modules across sandboxes and
// poison repeated in-process calls. This also keeps --local installs (which
// carry no package.json) and tarball installs on one uniform path.
const VERSION_DECLARATION_PATTERN = /compiler:\s*'(\d+\.\d+\.\d+)'/;

function readCompilerVersion(dataDirectory) {
  let contents;
  try {
    contents = fs.readFileSync(path.join(dataDirectory, 'src', 'compiler', 'version.js'), 'utf8');
  } catch {
    return null;
  }
  const match = VERSION_DECLARATION_PATTERN.exec(contents);
  return match ? match[1] : null;
}

function parseVersion(version) {
  if (typeof version !== 'string') {
    throw new Error(`A version must be a string; received ${typeof version}.`);
  }
  return version.split('.').map((segment) => {
    const value = Number(segment);
    // String(value) !== segment rejects padded ("01") and blank segments so
    // two spellings of one version can never compare unequal.
    if (!Number.isInteger(value) || value < 0 || String(value) !== segment) {
      throw new Error(`"${version}" is not a numeric dotted version.`);
    }
    return value;
  });
}

// Numeric per-segment comparison: 1.10 sorts after 1.9 (a lexicographic
// compare would flip them). Missing segments compare as zero, so 1.2 equals
// 1.2.0.
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftSegment = left[index] || 0;
    const rightSegment = right[index] || 0;
    if (leftSegment !== rightSegment) {
      return leftSegment < rightSegment ? -1 : 1;
    }
  }
  return 0;
}

async function update({
  dataDirectory,
  repository,
  apiBase,
  fetchImpl,
  // Test seams: injected failures exercise the rollback and extraction
  // paths without staging real filesystem or tar faults.
  spawnImpl = spawnSync,
  renameImpl = (from, to) => fs.renameSync(from, to)
} = {}) {
  if (!dataDirectory) {
    throw new Error('The update command requires the managed installation directory.');
  }
  const currentVersion = readCompilerVersion(dataDirectory);
  if (currentVersion === null) {
    throw new Error(`No managed Wizz installation found at ${dataDirectory}. Install Wizz first (scripts/install-cli.sh), or set XDG_DATA_HOME if the installation lives elsewhere.`);
  }

  const dataParent = path.dirname(dataDirectory);
  const lockPath = path.join(dataParent, '.wizz-update.lock');
  // Advisory lock, apt/dpkg posture: no stale-stealing. A SIGKILL leaves the
  // lock behind, and the error message gives the one-line fix.
  try {
    fs.mkdirSync(lockPath);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`Another wizz update appears to be in progress; if not, remove ${lockPath} and retry.`);
    }
    throw error;
  }

  // The version check above and the download below race in principle, but
  // the lock serializes updaters and the window is the download itself —
  // re-verification after download is noise, not safety.
  let staging;
  // A failed restore leaves staging/old as the only copy of the previous
  // installation; the finally below must then NOT delete the staging
  // directory, or the old installation would be destroyed with it.
  let stagingHoldsTheOnlyCopy = false;
  try {
    // A sibling of the data directory: same filesystem, so the swap is a
    // plain rename.
    staging = fs.mkdtempSync(path.join(dataParent, '.wizz-update.XXXXXX'));

    const release = await resolveLatestRelease({ repository, apiBase, fetchImpl });
    const comparison = compareVersions(release.version, currentVersion);
    if (comparison === 0) {
      return { status: 'current', fromVersion: currentVersion, toVersion: currentVersion, dataDirectory };
    }
    if (comparison === -1) {
      // A working tree installed with --local can be ahead of the releases;
      // never downgrade it.
      return { status: 'newer-local', fromVersion: currentVersion, toVersion: currentVersion, latestVersion: release.version, dataDirectory };
    }

    const tarballPath = path.join(staging, release.tarballName);
    await downloadToFile(release.tarballUrl, tarballPath, { fetchImpl });

    const extraction = spawnImpl('tar', ['-xzf', tarballPath, '-C', staging], { encoding: 'utf8' });
    if (extraction.error && extraction.error.code === 'ENOENT') {
      throw new Error('Extracting the release tarball requires tar. Install tar and run wizz update again.');
    }
    if (extraction.status !== 0) {
      throw new Error(`The release tarball could not be extracted (tar exit ${extraction.status}).`);
    }

    const packageDirectory = path.join(staging, 'package');
    // A truncated or foreign tarball must fail loudly, not replace a working
    // installation with garbage — the same refusal the installer makes.
    if (!fs.existsSync(path.join(packageDirectory, 'scripts', 'cli.js'))) {
      throw new Error('The downloaded release tarball does not contain a Wizz package (missing package/scripts/cli.js).');
    }
    const toVersion = readCompilerVersion(packageDirectory);
    if (toVersion === null) {
      throw new Error('The downloaded release tarball does not contain a Wizz package (missing package/src/compiler/version.js).');
    }

    // Swap with rollback: move the current installation aside, move the new
    // one in, and put the old one back if the second move fails. The
    // launcher needs no rewrite — its shim hard-codes this data-directory
    // path, which is stable across the swap.
    const backup = path.join(staging, 'old');
    renameImpl(dataDirectory, backup);
    try {
      renameImpl(packageDirectory, dataDirectory);
    } catch (error) {
      try {
        renameImpl(backup, dataDirectory);
      } catch {
        stagingHoldsTheOnlyCopy = true;
        throw new Error(`The update failed (${error.message}) and the previous installation could not be restored; a copy remains at ${backup}. Re-run the installer (scripts/install-cli.sh).`);
      }
      throw new Error(`The update failed and the previous installation was restored (${error.message}).`);
    }
    try {
      fs.rmSync(backup, { recursive: true, force: true });
    } catch {
      // A leftover backup does not make the update a failure: the new
      // installation is already in place.
    }

    return { status: 'updated', fromVersion: currentVersion, toVersion, dataDirectory };
  } finally {
    if (staging && !stagingHoldsTheOnlyCopy) {
      try {
        fs.rmSync(staging, { recursive: true, force: true });
      } catch {
        // Best effort: a stuck staging directory must not mask the result.
      }
    }
    try {
      fs.rmdirSync(lockPath);
    } catch {
      // The lock is advisory; a missed release must not mask the real error.
    }
  }
}

module.exports = { readCompilerVersion, compareVersions, update };
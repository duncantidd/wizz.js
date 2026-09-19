const fs = require('node:fs');
const path = require('node:path');

// The canonical starter templates `wizz init` scaffolds.
const TEMPLATES = require('./initTemplates.js');

/**
 * Scaffolds the starter project into `targetDirectory` and returns the
 * created template paths, relative to the target, in scaffold order.
 *
 * The refusals are deliberately conservative:
 * - a missing target directory (at any depth) is created; an existing empty
 *   directory is scaffolded as-is;
 * - an existing non-empty directory is refused unless `--force` was passed;
 * - even with `--force`, an existing template file is never overwritten —
 *   every template path is pre-checked, and any conflict refuses the whole
 *   scaffold before a single file is written (all-or-nothing).
 * @param {string} targetDirectory - Directory to scaffold into.
 * @param {Object} [options] - Init options.
 * @param {boolean} [options.force=false] - Allow scaffolding into a
 *   non-empty directory. Existing files still refuse the scaffold.
 * @returns {string[]} The created template paths in scaffold order.
 * @throws {Error} When the target is unusable or a template file already
 *   exists — before any file is written.
 */
function initProject(targetDirectory, options = {}) {
  if (typeof targetDirectory !== 'string' || targetDirectory === '') {
    throw new TypeError('The init target directory must be a non-empty string.');
  }

  const resolvedTarget = path.resolve(targetDirectory);
  const force = options.force === true;

  if (fs.existsSync(resolvedTarget)) {
    if (!fs.statSync(resolvedTarget).isDirectory()) {
      throw new Error(`The target path exists and is not a directory: ${resolvedTarget}`);
    }
    if (!force && fs.readdirSync(resolvedTarget).length > 0) {
      throw new Error(
        `Directory is not empty: ${resolvedTarget}. Pass --force to scaffold into it (existing files are never overwritten).`
      );
    }
  } else {
    fs.mkdirSync(resolvedTarget, { recursive: true });
  }

  const conflicts = Object.keys(TEMPLATES).filter(
    (templatePath) => fs.existsSync(path.join(resolvedTarget, templatePath))
  );
  if (conflicts.length > 0) {
    throw new Error(`Refusing to overwrite existing file(s): ${conflicts.join(', ')}.`);
  }

  const created = [];
  for (const [templatePath, contents] of Object.entries(TEMPLATES)) {
    const targetPath = path.join(resolvedTarget, templatePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, contents, 'utf8');
    created.push(templatePath);
  }

  return created;
}

module.exports = { initProject };

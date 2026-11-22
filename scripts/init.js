const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

// The canonical starter templates `wizz init` scaffolds, as named file sets.
const { TEMPLATE_SETS, DEFAULT_TEMPLATE } = require('./initTemplates.js');

const TEMPLATE_PROMPT = 'Bootstrap with sample code? [Y/n] ';

/**
 * Resolves a template name to its file set, refusing anything that is not an
 * own entry of the table (`TEMPLATE_SETS` has a null prototype, so names such
 * as `__proto__` or `constructor` cannot resolve to an inherited object).
 * @param {string} template - Template name.
 * @returns {Object<string, string>} The template's files, path → contents.
 */
function resolveTemplate(template) {
  if (typeof template !== 'string' || !Object.prototype.hasOwnProperty.call(TEMPLATE_SETS, template)) {
    throw new TypeError(
      `Unknown init template: ${String(template)}. Expected one of: ${Object.keys(TEMPLATE_SETS).join(', ')}.`
    );
  }
  return TEMPLATE_SETS[template];
}

/**
 * Checks that `targetDirectory` can receive a scaffold, without writing
 * anything. Runs before the interactive prompt so an unusable target is
 * reported before the user is asked a question, and again inside
 * initProject (the directory could change while the prompt is open).
 * @param {string} targetDirectory - Directory to scaffold into.
 * @param {Object} [options] - Init options.
 * @param {boolean} [options.force=false] - Allow a non-empty directory.
 * @returns {string} The resolved target directory.
 * @throws {Error} When the target is a file or a non-empty directory
 *   without `force`.
 */
function checkInitTarget(targetDirectory, options = {}) {
  if (typeof targetDirectory !== 'string' || targetDirectory === '') {
    throw new TypeError('The init target directory must be a non-empty string.');
  }

  const resolvedTarget = path.resolve(targetDirectory);
  if (fs.existsSync(resolvedTarget)) {
    if (!fs.statSync(resolvedTarget).isDirectory()) {
      throw new Error(`The target path exists and is not a directory: ${resolvedTarget}`);
    }
    if (options.force !== true && fs.readdirSync(resolvedTarget).length > 0) {
      throw new Error(
        `Directory is not empty: ${resolvedTarget}. Pass --force to scaffold into it (existing files are never overwritten).`
      );
    }
  }
  return resolvedTarget;
}

/**
 * Scaffolds a starter project into `targetDirectory` and returns the
 * created template paths, relative to the target, in scaffold order.
 *
 * The refusals are deliberately conservative:
 * - a missing target directory (at any depth) is created; an existing empty
 *   directory is scaffolded as-is;
 * - an existing non-empty directory is refused unless `--force` was passed;
 * - even with `--force`, an existing template file is never overwritten —
 *   every path of the selected template is pre-checked, and any conflict
 *   refuses the whole scaffold before a single file is written
 *   (all-or-nothing).
 * @param {string} targetDirectory - Directory to scaffold into.
 * @param {Object} [options] - Init options.
 * @param {boolean} [options.force=false] - Allow scaffolding into a
 *   non-empty directory. Existing files still refuse the scaffold.
 * @param {string} [options.template='sample'] - Template set to write:
 *   `sample` (the showcase project) or `bare` (the minimal canonical shape).
 * @returns {string[]} The created template paths in scaffold order.
 * @throws {Error} When the target is unusable, the template is unknown, or a
 *   template file already exists — before any file is written.
 */
function initProject(targetDirectory, options = {}) {
  const files = resolveTemplate(options.template === undefined ? DEFAULT_TEMPLATE : options.template);
  const resolvedTarget = checkInitTarget(targetDirectory, options);

  const conflicts = Object.keys(files).filter(
    (templatePath) => fs.existsSync(path.join(resolvedTarget, templatePath))
  );
  if (conflicts.length > 0) {
    throw new Error(`Refusing to overwrite existing file(s): ${conflicts.join(', ')}.`);
  }

  fs.mkdirSync(resolvedTarget, { recursive: true });
  const created = [];
  for (const [templatePath, contents] of Object.entries(files)) {
    const targetPath = path.join(resolvedTarget, templatePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, contents, 'utf8');
    created.push(templatePath);
  }

  return created;
}

/**
 * Maps one prompt answer to a template name, or null when the answer must be
 * asked again. Enter, `y`, and `yes` choose the sample; `n` and `no` choose
 * bare. Case is ignored and surrounding whitespace trimmed (a stray space
 * before Enter is not a reason to re-ask).
 * @param {string} answer - The raw line the user typed.
 * @returns {('sample'|'bare'|null)} The chosen template, or null to re-ask.
 */
function interpretTemplateAnswer(answer) {
  const normalized = String(answer).trim().toLowerCase();
  if (normalized === '' || normalized === 'y' || normalized === 'yes') return 'sample';
  if (normalized === 'n' || normalized === 'no') return 'bare';
  return null;
}

/**
 * Creates the error a prompt abort produces. `reason` is `interrupt`
 * (Ctrl+C) or `eof` (input closed); the CLI maps them to exit codes.
 */
function initAbortedError(reason) {
  const error = new Error('Init aborted: no files were written.');
  error.code = 'WIZZ_INIT_ABORTED';
  error.reason = reason;
  return error;
}

/**
 * Asks the sample-or-bare question until it gets a valid answer.
 *
 * `ask(question)` is the injectable prompt: it resolves with the line typed,
 * resolves with `null` when input ends (EOF), and rejects with an error whose
 * `code` is `WIZZ_INIT_ABORTED` on Ctrl+C. Both aborts reject this promise
 * with a `WIZZ_INIT_ABORTED` error, so the caller writes nothing.
 * @param {function(string): Promise<(string|null)>} ask - Prompt function.
 * @returns {Promise<('sample'|'bare')>} The chosen template.
 */
async function promptForTemplate(ask) {
  if (typeof ask !== 'function') {
    throw new TypeError('The init prompt requires an ask function.');
  }
  for (;;) {
    const answer = await ask(TEMPLATE_PROMPT);
    if (answer === null || answer === undefined) throw initAbortedError('eof');
    const template = interpretTemplateAnswer(answer);
    if (template !== null) return template;
  }
}

/**
 * Builds the default `ask` on Node's built-in readline: one interface shared
 * by every re-ask (so typed-ahead lines are not lost between questions),
 * reading `input` and writing the prompt to `output` — stderr by default, so
 * stdout carries only the "Created ..." report. Call `close()` once the
 * prompt is settled.
 * @param {Object} [streams] - Stream overrides (tests).
 * @param {NodeJS.ReadableStream} [streams.input=process.stdin]
 * @param {NodeJS.WritableStream} [streams.output=process.stderr]
 * @returns {{ ask: function(string): Promise<(string|null)>, close: function(): void }}
 */
function createReadlineAsk({ input = process.stdin, output = process.stderr } = {}) {
  const lines = readline.createInterface({ input, output });
  let closed = false;
  let pending = null;
  // Lines that arrive while no question is pending (typed or piped ahead, or
  // several in one chunk) are queued for the next ask instead of dropped —
  // readline's own question() only routes a line to an open question.
  const queued = [];

  lines.on('line', (line) => {
    if (pending) {
      const waiter = pending;
      pending = null;
      waiter.resolve(line);
    } else {
      queued.push(line);
    }
  });
  lines.on('SIGINT', () => {
    // Leave the shell prompt on a fresh line after the ^C echo.
    output.write('\n');
    const waiter = pending;
    pending = null;
    close();
    if (waiter) waiter.reject(initAbortedError('interrupt'));
  });
  lines.on('close', () => {
    closed = true;
    const waiter = pending;
    pending = null;
    if (waiter) waiter.resolve(null);
  });

  function close() {
    if (!closed) {
      closed = true;
      lines.close();
    }
  }

  function ask(question) {
    if (queued.length > 0) {
      output.write(question);
      return Promise.resolve(queued.shift());
    }
    if (closed) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      pending = { resolve, reject };
      lines.setPrompt(question);
      lines.prompt();
    });
  }

  return { ask, close };
}

module.exports = {
  TEMPLATE_PROMPT,
  checkInitTarget,
  createReadlineAsk,
  initProject,
  interpretTemplateAnswer,
  promptForTemplate
};

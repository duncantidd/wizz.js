const LOCATION_PATTERN = /\bat (\d+):(\d+)/g;
const FIRST_LOCATION_PATTERN = /\bat (\d+):(\d+)/;

function createCodeFrame(source, filePath, line, column) {
  if (typeof source !== 'string' || line < 1 || column < 1) {
    return null;
  }

  const sourceLine = source.split(/\r?\n/)[line - 1];
  if (sourceLine === undefined) {
    return null;
  }

  const lineNumber = String(line);
  const gutter = ' '.repeat(lineNumber.length);
  const pointer = `${gutter} | ${' '.repeat(column - 1)}^`;

  return {
    sourceExcerpt: sourceLine,
    codeFrame: `${filePath}:${line}:${column}\n${lineNumber} | ${sourceLine}\n${pointer}`
  };
}

/**
 * Builds the structured record the `diagnostics: 'collect'` compile mode
 * returns instead of throwing. One record per failed compile: the catalog
 * code (null when the failure is not a coded compiler diagnostic, such as an
 * entry-point misuse), the error severity, a single-line file-qualified
 * message, and the location fields. Throws stay available for human output;
 * records are the machine-readable surface.
 * @param {Error} error - The error thrown by a compiler stage.
 * @param {string} [filePath] - The component file path supplied by the caller.
 * @param {string} [source] - The component source supplied by the caller.
 * @returns {Object} `{ code, severity, message, file, line, column }`.
 */
function buildDiagnosticRecord(error, filePath, source) {
  // Augmenting without a code frame keeps the record's message single-line
  // and JSON-friendly; the thrown error keeps its frame for human output.
  augmentErrorWithFile(error, filePath, source, { includeCodeFrame: false });
  return {
    code: typeof error.code === 'string' ? error.code : null,
    severity: 'error',
    message: error.message,
    file: error.filePath || null,
    line: error.line === undefined ? null : error.line,
    column: error.column === undefined ? null : error.column
  };
}

/**
 * Augments a compiler error with the component file being compiled.
 * Source locations in the message become file-qualified (`at App.wizz:1:6`),
 * messages without a location are prefixed with the file path alone, and a
 * source excerpt plus code frame are included when source text is available.
 * The error instance, its constructor, and its stack are preserved, and the
 * diagnostic data is also exposed programmatically: `error.filePath` when a
 * file path is available, and structured `error.line`/`error.column` fields
 * stamped from the message's `at L:C` locator even without one.
 * @param {Error} error - The error thrown by a compiler stage.
 * @param {string} filePath - The component file path supplied by the caller.
 * @param {string} source - The component source supplied by the caller.
 * @param {Object} [options] - Augmentation options.
 * @param {boolean} [options.includeCodeFrame=true] - When false, the code
 *   frame (and source excerpt) is omitted and the message stays single-line;
 *   structured record building uses this to keep records JSON-friendly.
 * @returns {Error} The same error, augmented when a file path is available.
 */
function augmentErrorWithFile(error, filePath, source, options = {}) {
  if (!(error instanceof Error)) {
    return error;
  }

  // Stamp the structured location before any file qualification: the
  // qualified message no longer contains the bare `at L:C` form the locator
  // matches, and the `error.filePath` guard makes re-augmentation a no-op,
  // so the first stamp always wins.
  const location = error.message.match(FIRST_LOCATION_PATTERN);
  if (location && error.line === undefined && error.column === undefined) {
    error.line = Number(location[1]);
    error.column = Number(location[2]);
  }

  if (!filePath || typeof filePath !== 'string' || error.filePath) {
    return error;
  }

  error.filePath = filePath;

  const qualifiedMessage = error.message.replace(LOCATION_PATTERN, `at ${filePath}:$1:$2`);
  const message = qualifiedMessage === error.message
    ? `${filePath}: ${error.message}`
    : qualifiedMessage;

  if (location && options.includeCodeFrame !== false) {
    const codeFrame = createCodeFrame(source, filePath, Number(location[1]), Number(location[2]));
    if (codeFrame) {
      error.sourceExcerpt = codeFrame.sourceExcerpt;
      error.codeFrame = codeFrame.codeFrame;
      error.message = `${message}\n\n${codeFrame.codeFrame}`;
      return error;
    }
  }

  error.message = message;

  return error;
}

module.exports = { augmentErrorWithFile, buildDiagnosticRecord };

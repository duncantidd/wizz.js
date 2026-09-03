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
 * Augments a compiler error with the component file being compiled.
 * Source locations in the message become file-qualified (`at App.wizz:1:6`),
 * messages without a location are prefixed with the file path alone, and a
 * source excerpt plus code frame are included when source text is available.
 * The error instance, its constructor, and its stack are preserved, and the
 * diagnostic data is also exposed programmatically.
 * @param {Error} error - The error thrown by a compiler stage.
 * @param {string} filePath - The component file path supplied by the caller.
 * @param {string} source - The component source supplied by the caller.
 * @returns {Error} The same error, augmented when a file path is available.
 */
function augmentErrorWithFile(error, filePath, source) {
  if (!filePath || typeof filePath !== 'string' || !(error instanceof Error) || error.filePath) {
    return error;
  }

  error.filePath = filePath;

  const location = error.message.match(FIRST_LOCATION_PATTERN);
  const qualifiedMessage = error.message.replace(LOCATION_PATTERN, `at ${filePath}:$1:$2`);
  const message = qualifiedMessage === error.message
    ? `${filePath}: ${error.message}`
    : qualifiedMessage;

  if (location) {
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

module.exports = { augmentErrorWithFile };

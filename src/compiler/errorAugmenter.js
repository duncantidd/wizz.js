const LOCATION_PATTERN = /\bat (\d+):(\d+)/g;

/**
 * Augments a compiler error with the component file being compiled.
 * Source locations in the message become file-qualified (`at App.wizz:1:6`),
 * and messages without a location are prefixed with the file path alone.
 * The error instance, its constructor, and its stack are preserved, and the
 * file path is also exposed programmatically as `error.filePath`.
 * @param {Error} error - The error thrown by a compiler stage.
 * @param {string} filePath - The component file path supplied by the caller.
 * @returns {Error} The same error, augmented when a file path is available.
 */
function augmentErrorWithFile(error, filePath) {
  if (!filePath || typeof filePath !== 'string' || !(error instanceof Error) || error.filePath) {
    return error;
  }

  error.filePath = filePath;

  const qualifiedMessage = error.message.replace(LOCATION_PATTERN, `at ${filePath}:$1:$2`);
  error.message = qualifiedMessage === error.message
    ? `${filePath}: ${error.message}`
    : qualifiedMessage;

  return error;
}

module.exports = { augmentErrorWithFile };

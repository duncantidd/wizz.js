const { parseComponent } = require('./parser/index.js');
const { analyzeDependencies } = require('./analyzer/dependencyAnalyzer.js');
const { assignNodeIds } = require('./analyzer/idAssigner.js');
const { generateComponent } = require('./generator/componentGenerator.js');
const { augmentErrorWithFile } = require('./errorAugmenter.js');

/**
 * Compiles a raw component source string into a mountable ES module.
 * Runs the complete pipeline in order: parsing, dependency analysis,
 * ID assignment, and generation.
 * @param {string} source - The raw string content of the component file.
 * @param {Object} [options] - Compilation options.
 * @param {string} [options.filePath] - Path of the component file the source
 *   was read from. When supplied, compiler errors identify the file as well
 *   as their source location, and carry it as `error.filePath`.
 * @returns {{ source: string, payload: Object }} The generated module source
 *   and the final analyzed handoff payload it was produced from.
 */
function compile(source, options = {}) {
  const filePath = options && typeof options === 'object' ? options.filePath : undefined;

  try {
    const payload = assignNodeIds(analyzeDependencies(parseComponent(source)));

    return {
      source: generateComponent(payload),
      payload
    };
  } catch (error) {
    throw augmentErrorWithFile(error, filePath);
  }
}

module.exports = { compile, augmentErrorWithFile };

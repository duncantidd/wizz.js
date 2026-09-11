const { parseComponent } = require('./parser/index.js');
const { analyzeDependencies } = require('./analyzer/dependencyAnalyzer.js');
const { assignNodeIds } = require('./analyzer/idAssigner.js');
const { generateComponent } = require('./generator/componentGenerator.js');
const { generateServerComponent } = require('./generator/serverGenerator.js');
const { augmentErrorWithFile } = require('./errorAugmenter.js');
const { createSourceMap } = require('./sourceMapGenerator.js');
const { VERSIONS } = require('./version.js');

/**
 * Compiles a raw component source string into a mountable ES module.
 * Runs the complete pipeline in order: parsing, dependency analysis,
 * ID assignment, and generation.
 * @param {string} source - The raw string content of the component file.
 * @param {Object} [options] - Compilation options.
 * @param {string} [options.filePath] - Path of the component file the source
 *   was read from. When supplied, compiler errors identify the file as well
 *   as their source location, and carry it as `error.filePath`.
 * @param {boolean} [options.hydratable] - When true, the generated module
 *   additionally exports `hydrateComponent(target, props, state)` and
 *   `hydrateRoot(rootNode, props, state)`, which adopt server-rendered markup
 *   instead of recreating it. Hydratable modules are restricted to the
 *   server-renderable component surface; component tags require the import to
 *   be vouched for via `componentServerRenderable`.
 * @param {Object<string, boolean>} [options.componentServerRenderable] -
 *   Import names vouched for as having server-renderable builds. Required
 *   (with `hydratable`) for component tags to pass the gate; a missing or
 *   false entry rejects that tag with a located error.
 * @param {Object<string, string>} [options.componentIneligibilityReasons] -
 *   Import names mapped to the child's own gate failure, chained into the
 *   thrown diagnostic ("Underlying reason: …").
 * @returns {{ source: string, payload: Object, sourceMap: Object|null, version: Object }}
 *   The generated module source, final analyzed handoff payload, optional
 *   source map, and frozen compatibility versions (`compiler`, `syntax`,
 *   `output`) the component was compiled with.
 */
function compile(source, options = {}) {
  const optionObject = options && typeof options === 'object' ? options : {};
  const filePath = optionObject.filePath;
  const hydratable = optionObject.hydratable === true;
  const gateOptions = {
    componentServerRenderable: optionObject.componentServerRenderable,
    componentIneligibilityReasons: optionObject.componentIneligibilityReasons
  };

  try {
    const payload = assignNodeIds(analyzeDependencies(parseComponent(source)));
    const generatedSource = generateComponent(payload, { hydratable, ...gateOptions });

    return {
      source: generatedSource,
      payload,
      sourceMap: createSourceMap(source, generatedSource, filePath, payload.rawScript),
      version: VERSIONS
    };
  } catch (error) {
    throw augmentErrorWithFile(error, filePath, source);
  }
}

/**
 * Compiles a raw component source string into a self-contained server module
 * that renders HTML strings without any DOM dependency. The module exports
 * `renderComponent(props)` returning `{ html, state }` and
 * `serializeInitialState(state)` producing the delivery script tag content.
 *
 * The server target accepts only the server-renderable surface: static
 * markup, text interpolations, dynamic attributes, `{#if}` blocks, `{#each}`
 * lists (mirroring the client generator's body restrictions), and component
 * tags whose imports are vouched for via `componentServerRenderable`.
 * Anything outside that surface fails the compile with a located error.
 *
 * No source map is produced: server output is an HTML string evaluated at
 * request time, not a DOM artifact whose positions map back to the template.
 * @param {string} source - The raw string content of the component file.
 * @param {Object} [options] - Compilation options.
 * @param {string} [options.filePath] - Path of the component file the source
 *   was read from. When supplied, compiler errors identify the file as well
 *   as their source location, and carry it as `error.filePath`.
 * @param {Object<string, boolean>} [options.componentServerRenderable] -
 *   Import names vouched for as having server-renderable builds. Required for
 *   component tags to pass the gate; a missing or false entry rejects that
 *   tag with a located error.
 * @param {Object<string, string>} [options.componentIneligibilityReasons] -
 *   Import names mapped to the child's own gate failure, chained into the
 *   thrown diagnostic ("Underlying reason: …").
 * @returns {{ source: string, payload: Object, sourceMap: null, version: Object }}
 *   The generated server module source, final analyzed handoff payload, and
 *   frozen compatibility versions.
 */
function compileServer(source, options = {}) {
  const optionObject = options && typeof options === 'object' ? options : {};
  const filePath = optionObject.filePath;
  const gateOptions = {
    componentServerRenderable: optionObject.componentServerRenderable,
    componentIneligibilityReasons: optionObject.componentIneligibilityReasons
  };

  try {
    const payload = assignNodeIds(analyzeDependencies(parseComponent(source)));
    const generatedSource = generateServerComponent(payload, gateOptions);

    return {
      source: generatedSource,
      payload,
      sourceMap: null,
      version: VERSIONS
    };
  } catch (error) {
    throw augmentErrorWithFile(error, filePath, source);
  }
}

module.exports = { compile, compileServer, augmentErrorWithFile, VERSIONS };

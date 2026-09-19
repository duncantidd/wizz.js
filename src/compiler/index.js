const { parseComponent } = require('./parser/index.js');
const { analyzeDependencies } = require('./analyzer/dependencyAnalyzer.js');
const { assignNodeIds } = require('./analyzer/idAssigner.js');
const { generateComponent } = require('./generator/componentGenerator.js');
const { generateServerComponent } = require('./generator/serverGenerator.js');
const { augmentErrorWithFile, buildDiagnosticRecord } = require('./errorAugmenter.js');
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
 * @param {string} [options.diagnostics] - Set to `'collect'` to receive a
 *   structured diagnostic instead of a thrown error: a failed compile
 *   returns `{ diagnostics: [record] }`, and a successful compile adds
 *   `diagnostics: []` to its result. A record is
 *   `{ code, severity, message, file, line, column }` — the stable catalog
 *   code (null when the failure is not a coded compiler diagnostic), the
 *   `'error'` severity, a single-line file-qualified message, and the
 *   source location. Collect mode never throws for compile failures; any
 *   other value is rejected before compiling.
 * @returns {{ source: string, payload: Object, sourceMap: Object|null, version: Object, diagnostics?: Array }}
 *   The generated module source, final analyzed handoff payload, optional
 *   source map, and frozen compatibility versions (`compiler`, `syntax`,
 *   `output`) the component was compiled with — plus `diagnostics` when
 *   collect mode is requested.
 */
function compile(source, options = {}) {
  const optionObject = options && typeof options === 'object' ? options : {};
  const filePath = optionObject.filePath;
  const hydratable = optionObject.hydratable === true;
  const collectDiagnostics = collectOption(optionObject);
  const gateOptions = {
    componentServerRenderable: optionObject.componentServerRenderable,
    componentIneligibilityReasons: optionObject.componentIneligibilityReasons,
    // Forwarded for generated diagnostics (head locations), not the gate.
    filePath
  };

  try {
    const payload = assignNodeIds(analyzeDependencies(parseComponent(source)));
    const generatedSource = generateComponent(payload, { hydratable, ...gateOptions });

    const result = {
      source: generatedSource,
      payload,
      sourceMap: createSourceMap(source, generatedSource, filePath, payload.rawScript),
      version: VERSIONS
    };
    if (collectDiagnostics) result.diagnostics = [];
    return result;
  } catch (error) {
    if (collectDiagnostics) {
      return { diagnostics: [buildDiagnosticRecord(error, filePath, source)] };
    }
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
 * @param {string} [options.diagnostics] - Set to `'collect'` to receive a
 *   structured diagnostic instead of a thrown error, exactly as with
 *   `compile()`: a failed compile returns `{ diagnostics: [record] }`, and
 *   a successful compile adds `diagnostics: []` to its result.
 * @returns {{ source: string, payload: Object, sourceMap: null, version: Object, diagnostics?: Array }}
 *   The generated server module source, final analyzed handoff payload, and
 *   frozen compatibility versions — plus `diagnostics` when collect mode is
 *   requested.
 */
function compileServer(source, options = {}) {
  const optionObject = options && typeof options === 'object' ? options : {};
  const filePath = optionObject.filePath;
  const collectDiagnostics = collectOption(optionObject);
  const gateOptions = {
    componentServerRenderable: optionObject.componentServerRenderable,
    componentIneligibilityReasons: optionObject.componentIneligibilityReasons,
    // Forwarded for generated diagnostics (head locations), not the gate.
    filePath,
    // Decorates child `.server.js` import specifiers so a development
    // server's in-process module cache re-evaluates the child graph after a
    // rebuild (empty for production builds, which emit clean specifiers).
    moduleQuery: optionObject.moduleQuery
  };

  try {
    const payload = assignNodeIds(analyzeDependencies(parseComponent(source)));
    const generatedSource = generateServerComponent(payload, gateOptions);

    const result = {
      source: generatedSource,
      payload,
      sourceMap: null,
      version: VERSIONS
    };
    if (collectDiagnostics) result.diagnostics = [];
    return result;
  } catch (error) {
    if (collectDiagnostics) {
      return { diagnostics: [buildDiagnosticRecord(error, filePath, source)] };
    }
    throw augmentErrorWithFile(error, filePath, source);
  }
}

/**
 * Validates the `diagnostics` option and reports whether collect mode is on.
 * The only supported value is 'collect'; anything else — including values of
 * the wrong type — is a caller bug, rejected with a TypeError before any
 * compilation runs (a programmatic guard, deliberately uncoded: the catalog
 * is for author-facing diagnostics).
 * @param {Object} optionObject - The normalized options object.
 * @returns {boolean} True when collect mode is requested.
 * @throws {TypeError} When the option is set to anything but 'collect'.
 */
function collectOption(optionObject) {
  const value = optionObject.diagnostics;
  if (value === undefined) return false;
  if (value === 'collect') return true;
  throw new TypeError(`The diagnostics option accepts only 'collect', received ${typeof value}.`);
}

module.exports = { compile, compileServer, augmentErrorWithFile, VERSIONS };

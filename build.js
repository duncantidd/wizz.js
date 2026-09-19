// build.js
const fs = require('node:fs');
const path = require('node:path');

// Single public compiler entry point: parsing, analysis, ID assignment, generation.
const { compile, compileServer } = require('./src/compiler');
const { scopeCss } = require('./src/compiler/analyzer/cssScanner');

const STYLESHEET_FILENAME = 'app.css';
const STYLESHEET_HREF_PATTERN = /href\s*=\s*(["'])\/app\.css\1/;

// The envelope `wizz build --json` prints. Versioned so tooling can pin the
// shape it parses: new fields may be added within format version 1, but
// existing fields keep their meaning until the version string changes.
const BUILD_DIAGNOSTICS_FORMAT = 'wizz-build-diagnostics@1';

function parseBuildArguments(argv) {
  if (!Array.isArray(argv)) {
    throw new TypeError('Build arguments must be an array.');
  }

  const json = argv.includes('--json');
  const directories = argv.filter((argument) => argument !== '--json');

  if (directories.length !== 2) {
    throw new Error('Usage: node build.js <input-directory> <output-directory> [--json]');
  }

  const [inputDirectory, outputDirectory] = directories;
  return { inputDirectory, outputDirectory, json };
}

function toPosixPath(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function discoverWizzFiles(inputDirectory) {
  const wizzFiles = [];

  function visit(directory) {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile() && path.extname(entry.name) === '.wizz') {
        wizzFiles.push(entryPath);
      }
    }
  }

  visit(inputDirectory);
  return wizzFiles;
}

function getOutputPath(inputDirectory, outputDirectory, inputPath) {
  const relativePath = path.relative(inputDirectory, inputPath);

  if (relativePath === '' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new Error(`Input file must be inside the input directory: ${inputPath}`);
  }

  if (path.extname(relativePath) !== '.wizz') {
    throw new Error(`Input file must have a .wizz extension: ${inputPath}`);
  }

  return path.join(outputDirectory, relativePath.replace(/\.wizz$/, '.js'));
}

function writeGeneratedModule(outputPath, generatedModule, sourceMap) {
  if (sourceMap) {
    const sourceMapPath = `${outputPath}.map`;
    sourceMap.file = path.basename(outputPath);
    fs.writeFileSync(sourceMapPath, JSON.stringify(sourceMap), 'utf-8');
    fs.writeFileSync(
      outputPath,
      `${generatedModule}\n//# sourceMappingURL=${path.basename(sourceMapPath)}`,
      'utf-8'
    );
    return;
  }

  fs.writeFileSync(outputPath, generatedModule, 'utf-8');
}

function firstErrorLine(error) {
  return String(error.message).split('\n', 1)[0];
}

/**
 * Compiles and writes the client module for one .wizz file and returns the
 * artifacts the eligibility graph needs (raw source, analyzed payload).
 * Server and hydratable builds are written separately by writeServerBuilds
 * once import-graph eligibility is known, because whether a file may
 * server-render depends on the files it imports, not on its own template.
 *
 * With `options.diagnostics === 'collect'`, a compile failure is returned as
 * `{ diagnostics: [record] }` instead of thrown — the JSON build mode uses
 * this to aggregate per-file diagnostics — and a success carries
 * `diagnostics: []` alongside the artifacts. `options.filePath` overrides
 * the label compiler errors carry (the JSON mode passes the input-relative
 * path so records stay position-independent).
 */
function compileWizzFile(inputPath, outputPath, options = {}) {
  const rawWizzCode = fs.readFileSync(inputPath, 'utf-8');
  const collect = options.diagnostics === 'collect';
  const result = compile(rawWizzCode, {
    filePath: options.filePath || inputPath,
    ...(collect ? { diagnostics: 'collect' } : {})
  });

  if (collect && result.diagnostics.length > 0) {
    return { diagnostics: result.diagnostics };
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  writeGeneratedModule(outputPath, result.source, result.sourceMap);

  return { rawWizzCode, payload: result.payload, diagnostics: collect ? [] : undefined };
}

/**
 * Resolves a component import source (e.g. "./Counter.wizz") against the
 * importing file. Returns null for anything that is not a .wizz import
 * resolvable to a discovered project file — such imports are not components
 * of this build and are simply never vouched for.
 */
function resolveImportPath(inputPath, importSource, discoveredFiles) {
  if (typeof importSource !== 'string' || !importSource.endsWith('.wizz')) return null;
  const resolved = path.resolve(path.dirname(inputPath), importSource);
  return discoveredFiles.has(resolved) ? resolved : null;
}

/**
 * Computes server-rendering eligibility bottom-up over the import graph with
 * memoization: a file is eligible when its own server and hydratable targets
 * compile — with each rendered import vouched for by that child's own
 * eligibility — and every transitive .wizz import is eligible. This is what
 * lets a static component pulled into an eligible page ship a server build,
 * and what keeps a page whose child fails the gate client-only with the
 * child's own gate failure chained as the underlying reason.
 *
 * The graph is assumed to be a DAG (cyclic component imports have no
 * meaningful render order); a cycle is reported as ineligibility for every
 * file involved rather than recursing forever.
 */
function computeServerEligibility(inputFiles, compiledByInputPath, failureReasonsByInputPath, options = {}) {
  const discoveredFiles = new Set(inputFiles);
  const eligibilityByInputPath = new Map();
  const serverBuildsByInputPath = new Map();
  const visiting = new Set();
  const CYCLE_REASON = 'its import graph contains a cycle.';

  function compute(inputPath) {
    if (eligibilityByInputPath.has(inputPath)) return eligibilityByInputPath.get(inputPath);
    if (visiting.has(inputPath)) return { eligible: false, reason: CYCLE_REASON };
    // A file whose client build failed has no payload to walk and no reason
    // to re-report here; its own build failure was already reported.
    if (!compiledByInputPath.has(inputPath)) {
      return { eligible: false, reason: failureReasonsByInputPath.get(inputPath) || 'its client build failed' };
    }

    visiting.add(inputPath);
    try {
      const { rawWizzCode, payload } = compiledByInputPath.get(inputPath);
      const componentServerRenderable = {};
      const componentIneligibilityReasons = {};

      for (const { name, source } of payload.imports || []) {
        const childPath = resolveImportPath(inputPath, source, discoveredFiles);
        if (!childPath) continue;
        const childResult = compute(childPath);
        if (childResult.eligible) {
          componentServerRenderable[name] = true;
        } else {
          componentIneligibilityReasons[name] = childResult.reason;
        }
      }

      const gateOptions = { componentServerRenderable, componentIneligibilityReasons };
      const serverResult = compileServer(rawWizzCode, {
        filePath: inputPath,
        ...gateOptions,
        // Decorates child import specifiers so a development server's module
        // cache re-evaluates the child graph after a rebuild; empty for
        // production builds.
        moduleQuery: options.moduleQuery
      });
      const hydratableResult = compile(rawWizzCode, { filePath: inputPath, hydratable: true, ...gateOptions });

      serverBuildsByInputPath.set(inputPath, { serverResult, hydratableResult });
      const result = { eligible: true, reason: null };
      eligibilityByInputPath.set(inputPath, result);
      return result;
    } catch (error) {
      const result = { eligible: false, reason: firstErrorLine(error) };
      eligibilityByInputPath.set(inputPath, result);
      return result;
    } finally {
      visiting.delete(inputPath);
    }
  }

  for (const inputPath of inputFiles) compute(inputPath);

  return { eligibilityByInputPath, serverBuildsByInputPath };
}

/**
 * Writes the server and hydratable builds for one eligible file from the
 * artifacts cached during the eligibility walk, so nothing is compiled twice.
 */
function writeEligibleServerBuilds(inputPath, outputPath, serverBuilds) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  // Server output carries no source map (HTML string rendering, not
  // positional DOM artifacts); the hydratable build mirrors the client
  // build's source-map presence.
  writeGeneratedModule(outputPath.replace(/\.js$/, '.server.js'), serverBuilds.serverResult.source, null);
  writeGeneratedModule(outputPath.replace(/\.js$/, '.hydrate.js'), serverBuilds.hydratableResult.source, serverBuilds.hydratableResult.sourceMap);
}

function copyRuntimeModules(outputDirectory) {
  const runtimeSourceDirectory = path.join(__dirname, 'src', 'runtime');
  const runtimeOutputDirectory = path.join(outputDirectory, 'runtime');

  fs.cpSync(runtimeSourceDirectory, runtimeOutputDirectory, { recursive: true });
}

/**
 * Collects every compiled component's scoped CSS in discovery order (the
 * client payloads are cached in the order discoverWizzFiles found them, so
 * the extracted stylesheet is byte-stable across identical builds). Scoping
 * runs through the same scopeCss the generators use, so the extracted
 * stylesheet always agrees with the markup it scopes.
 */
function extractComponentStyles(inputDirectory, compiledByInputPath) {
  const styles = [];

  for (const [inputPath, compiled] of compiledByInputPath) {
    if (!compiled.payload.style) continue;
    styles.push({
      filePath: path.relative(inputDirectory, inputPath).split(path.sep).join('/'),
      css: scopeCss(compiled.payload.style.css, compiled.payload.style.scope)
    });
  }

  return styles;
}

function writeExtractedStyles(outputDirectory, styles) {
  if (styles.length === 0) return false;

  // A per-file header comment keeps the extracted stylesheet debuggable;
  // CSS comments are inert, so delivery semantics are unaffected.
  const stylesheet = styles
    .map(({ filePath, css }) => `/* ${filePath} */\n${css}`)
    .join('\n\n');
  fs.writeFileSync(path.join(outputDirectory, STYLESHEET_FILENAME), `${stylesheet}\n`, 'utf8');
  return true;
}

/**
 * Locates the project's document shell. Projects either keep index.html
 * beside their components (the input directory itself) or at the project
 * root with components in a subdirectory (the conventional `wizz build src
 * dist` layout), so both locations are probed before giving up.
 */
function findDocumentShell(inputDirectory) {
  const inputShell = path.join(inputDirectory, 'index.html');
  if (fs.existsSync(inputShell)) return inputShell;
  const parentShell = path.join(inputDirectory, '..', 'index.html');
  if (fs.existsSync(parentShell)) return parentShell;
  return null;
}

/**
 * Copies the project's document shell into the output directory, injecting
 * the app.css link before </head> when component styles were extracted. A
 * shell that already links /app.css is left untouched (no double link), and
 * a project without a shell keeps today's behavior — the dev server reports
 * the missing shell at serve time.
 */
function copyDocumentShell(inputDirectory, outputDirectory, hasStyles, logger = console) {
  const shellPath = findDocumentShell(inputDirectory);
  if (shellPath === null) {
    if (hasStyles) {
      logger.log(`Note: component styles were extracted to ${STYLESHEET_FILENAME}, but no index.html document shell was found (looked in the input directory and its parent) to link it from.`);
    }
    return false;
  }

  let shell = fs.readFileSync(shellPath, 'utf8');
  if (hasStyles && !STYLESHEET_HREF_PATTERN.test(shell)) {
    if (!/<\/head/i.test(shell)) {
      logger.log(`Note: the document shell has no <head> element, so the extracted ${STYLESHEET_FILENAME} is not linked.`);
    } else {
      // Function-form replacement: the shell may contain `$` sequences
      // (`$&`, `$'`, `$$`) that string-form replacement would expand.
      shell = shell.replace(/([ \t]*)<\/head(\s*)?>/i, (match, indent) => (
        `${indent}<link rel="stylesheet" href="/${STYLESHEET_FILENAME}">\n${indent}</head>`
      ));
    }
  }

  fs.writeFileSync(path.join(outputDirectory, 'index.html'), shell, 'utf8');
  return true;
}

function getRoutePath(inputDirectory, inputPath) {
  const relativePath = path.relative(inputDirectory, inputPath);
  const segments = relativePath.split(path.sep);

  if (segments.length === 1 && segments[0] === 'App.wizz') return '/';
  if (segments[0] !== 'pages' || path.extname(relativePath) !== '.wizz') return null;

  const pageSegments = segments.slice(1, -1);
  const pageName = path.basename(inputPath, '.wizz');
  if (pageName !== 'index') pageSegments.push(pageName);

  return `/${pageSegments.join('/').toLowerCase()}`.replace(/\/$/, '') || '/';
}

function validateRouteEntries(routeEntries) {
  const routes = new Map();

  for (const routeEntry of routeEntries) {
    if (routeEntry.routePath === '/runtime' || routeEntry.routePath.startsWith('/runtime/')) {
      const error = new Error(`Route '${routeEntry.routePath}' is reserved for Wizz runtime files: ${routeEntry.filePath}`);
      error.filePath = routeEntry.inputPath;
      throw error;
    }

    const existingEntry = routes.get(routeEntry.routePath);
    if (existingEntry) {
      const error = new Error(
        `Ambiguous route '${routeEntry.routePath}' is claimed by ${existingEntry.filePath} and ${routeEntry.filePath}`
      );
      error.filePath = routeEntry.inputPath;
      throw error;
    }
    routes.set(routeEntry.routePath, routeEntry);
  }
}

function emitRouteManifest(inputDirectory, outputDirectory, inputFiles, serverRenderableByInputPath = new Map()) {
  const routeFiles = inputFiles.filter((inputPath) => getRoutePath(inputDirectory, inputPath));
  const routeEntries = routeFiles.map((inputPath) => {
    const outputPath = getOutputPath(inputDirectory, outputDirectory, inputPath);
    return {
      inputPath,
      filePath: path.relative(inputDirectory, inputPath).split(path.sep).join('/'),
      modulePath: path.relative(path.join(outputDirectory, 'runtime'), outputPath).split(path.sep).join('/'),
      routePath: getRoutePath(inputDirectory, inputPath)
    };
  });
  validateRouteEntries(routeEntries);
  const pageModules = routeEntries.map(({ filePath, modulePath, routePath, inputPath }) => {
    // Eligibility is a build-time artifact: the manifest field is the single
    // authority on whether a route server-renders, so the dev server never
    // probes the filesystem for stale server modules from earlier builds.
    const serverRenderable = serverRenderableByInputPath.get(inputPath) === true;
    return {
      filePath,
      modulePath,
      routePath,
      serverModulePath: serverRenderable ? modulePath.replace(/\.js$/, '.server.js') : null,
      hydratableModulePath: serverRenderable ? modulePath.replace(/\.js$/, '.hydrate.js') : null
    };
  });
  const manifestPath = path.join(outputDirectory, 'runtime', 'routes.js');

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(
    manifestPath,
    `// Generated by Wizz. Edits will be overwritten.\nexport const pageModules = ${JSON.stringify(pageModules, null, 2)};\n`,
    'utf8'
  );
}

function buildProject(inputDirectory, outputDirectory, logger = console, options = {}) {
  // JSON mode aggregates per-file diagnostics and a files manifest instead of
  // prose logging; a build-level failure (bad directories, route collision)
  // is returned as an envelope record rather than thrown. Everything else —
  // artifact writing, eligibility, exit-code semantics — is identical.
  const jsonMode = options.json === true;
  const jsonDiagnostics = [];
  const jsonFiles = [];
  let resolvedInputDirectory = null;
  let failedCount = 0;
  let compiledFileCount = 0;

  try {
    const resolvedOutputDirectory = path.resolve(outputDirectory);
    resolvedInputDirectory = path.resolve(inputDirectory);

    if (!fs.existsSync(resolvedInputDirectory) || !fs.statSync(resolvedInputDirectory).isDirectory()) {
      throw new Error(`Input directory does not exist or is not a directory: ${resolvedInputDirectory}`);
    }

    if (resolvedInputDirectory === resolvedOutputDirectory) {
      throw new Error('Input and output directories must be different.');
    }

    const inputFiles = discoverWizzFiles(resolvedInputDirectory);

    // Pass 1 — client builds. Every .wizz file gets its browser module; a
    // client-side failure is reported and recorded so importing files can chain
    // it as their own ineligibility reason.
    const compiledByInputPath = new Map();
    const failureReasonsByInputPath = new Map();
    for (const inputPath of inputFiles) {
      const outputPath = getOutputPath(resolvedInputDirectory, resolvedOutputDirectory, inputPath);

      try {
        if (jsonMode) {
          // Records carry input-relative paths so JSON consumers get
          // position-independent locations.
          const outcome = compileWizzFile(inputPath, outputPath, {
            diagnostics: 'collect',
            filePath: toPosixPath(path.relative(resolvedInputDirectory, inputPath))
          });
          if (outcome.diagnostics.length > 0) {
            failedCount++;
            failureReasonsByInputPath.set(inputPath, outcome.diagnostics[0].message);
            jsonDiagnostics.push(...outcome.diagnostics);
            continue;
          }
          compiledByInputPath.set(inputPath, outcome);
          compiledFileCount++;
        } else {
          compiledByInputPath.set(inputPath, compileWizzFile(inputPath, outputPath));
          compiledFileCount++;
          logger.log(`Compiled ${inputPath} -> ${outputPath}`);
        }
      } catch (error) {
        failedCount++;
        failureReasonsByInputPath.set(inputPath, firstErrorLine(error));
        if (jsonMode) {
          // Not a compiler diagnostic (a filesystem failure, an unexpected
          // throw): an uncoded record keeps the envelope total — every
          // failed file shows up in diagnostics.
          jsonDiagnostics.push({
            code: null,
            severity: 'error',
            message: firstErrorLine(error),
            file: toPosixPath(path.relative(resolvedInputDirectory, inputPath)),
            line: null,
            column: null
          });
        } else {
          logger.error(`Compilation failed for ${inputPath}: ${error.message}`);
        }
      }
    }

    // Pass 2 — eligibility over the import graph, computed bottom-up with the
    // client payloads. Both server targets are compiled here (once per file)
    // and cached for writing, so an eligible page never ships a server module
    // without its hydratable client build.
    const { eligibilityByInputPath, serverBuildsByInputPath } = computeServerEligibility(
      inputFiles,
      compiledByInputPath,
      failureReasonsByInputPath,
      // Threaded through so the development server can decorate child import
      // specifiers per rebuild; production builds leave it empty.
      { moduleQuery: options.moduleQuery }
    );

    // Pass 3 — server artifacts for eligible files (pages AND components: a
    // page's server module imports its components' server modules), and
    // ineligibility notes for everything else.
    const serverRenderableByInputPath = new Map();
    for (const inputPath of inputFiles) {
      if (!compiledByInputPath.has(inputPath)) continue;

      const outputPath = getOutputPath(resolvedInputDirectory, resolvedOutputDirectory, inputPath);
      const eligibility = eligibilityByInputPath.get(inputPath);

      if (eligibility.eligible) {
        writeEligibleServerBuilds(inputPath, outputPath, serverBuildsByInputPath.get(inputPath));
        serverRenderableByInputPath.set(inputPath, true);
      } else {
        serverRenderableByInputPath.set(inputPath, false);
        logger.log(`Note: server rendering skipped for ${inputPath} — ${eligibility.reason} Serving the client build only.`);
      }
    }

    copyRuntimeModules(resolvedOutputDirectory);
    emitRouteManifest(resolvedInputDirectory, resolvedOutputDirectory, inputFiles, serverRenderableByInputPath);

    // Pass 4 — style extraction and shell copy: production builds get one
    // app.css carrying every component's scoped rules, linked from the copied
    // shell so first paint is styled with zero runtime work. The dev server's
    // per-document <style> injection keeps working unchanged on top of this.
    const extractedStyles = extractComponentStyles(resolvedInputDirectory, compiledByInputPath);
    writeExtractedStyles(resolvedOutputDirectory, extractedStyles);
    copyDocumentShell(resolvedInputDirectory, resolvedOutputDirectory, extractedStyles.length > 0, logger);

    // The output directory holds ES modules and their assets, so pin the module
    // type beside the emitted artifacts: Node-side imports — the dev server's
    // SSR imports, and application servers following the SSR recipe — must work
    // on every supported runtime, and Node 18 has no module-syntax detection to
    // fall back on. A package.json the output already carries is respected: it
    // may be the embedding project's deliberate choice.
    const moduleTypeMarkerPath = path.join(resolvedOutputDirectory, 'package.json');
    if (!fs.existsSync(moduleTypeMarkerPath)) {
      fs.writeFileSync(moduleTypeMarkerPath, '{"type":"module"}\n', 'utf8');
    }

    if (jsonMode) {
      // The files manifest mirrors the route discovery order, so it is
      // byte-stable across identical builds. Files whose client build failed
      // never server-render.
      for (const inputPath of inputFiles) {
        jsonFiles.push({
          file: toPosixPath(path.relative(resolvedInputDirectory, inputPath)),
          serverRenderable: serverRenderableByInputPath.get(inputPath) === true
        });
      }
    }

    return {
      compiledCount: inputFiles.length - failedCount,
      failedCount,
      ...(jsonMode ? { ok: failedCount === 0, diagnostics: jsonDiagnostics, files: jsonFiles } : {})
    };
  } catch (error) {
    if (!jsonMode) throw error;

    // A build-level failure (bad directories, a route collision, an
    // unexpected filesystem error) is returned as an envelope record with a
    // null code instead of thrown, so `--json` output stays machine-parsable
    // on every failure path.
    let file = null;
    if (error && error.filePath && resolvedInputDirectory) {
      file = toPosixPath(path.relative(resolvedInputDirectory, error.filePath)) || null;
    }

    return {
      compiledCount: compiledFileCount,
      failedCount,
      ok: false,
      diagnostics: [{
        code: null,
        severity: 'error',
        message: firstErrorLine(error),
        file,
        line: null,
        column: null
      }],
      files: jsonFiles
    };
  }
}

function main(argv, logger = console) {
  const { inputDirectory, outputDirectory, json } = parseBuildArguments(argv);
  // In JSON mode stdout carries only the envelope, so the per-file prose the
  // build logs is suppressed at this CLI boundary.
  const result = buildProject(
    inputDirectory,
    outputDirectory,
    json ? { log() {}, error() {} } : logger,
    json ? { json: true } : {}
  );

  if (json) {
    console.log(JSON.stringify({
      format: BUILD_DIAGNOSTICS_FORMAT,
      ok: result.ok,
      diagnostics: result.diagnostics,
      files: result.files
    }, null, 2));
  }

  return result.failedCount === 0 && result.ok !== false ? 0 : 1;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  BUILD_DIAGNOSTICS_FORMAT,
  buildProject,
  compileWizzFile,
  computeServerEligibility,
  copyDocumentShell,
  extractComponentStyles,
  findDocumentShell,
  writeExtractedStyles,
  copyRuntimeModules,
  discoverWizzFiles,
  emitRouteManifest,
  getRoutePath,
  validateRouteEntries,
  getOutputPath,
  main,
  parseBuildArguments
};

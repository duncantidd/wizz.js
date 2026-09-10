// build.js
const fs = require('node:fs');
const path = require('node:path');

// Single public compiler entry point: parsing, analysis, ID assignment, generation.
const { compile, compileServer } = require('./src/compiler');

function parseBuildArguments(argv) {
  if (!Array.isArray(argv)) {
    throw new TypeError('Build arguments must be an array.');
  }

  if (argv.length !== 2) {
    throw new Error('Usage: node build.js <input-directory> <output-directory>');
  }

  const [inputDirectory, outputDirectory] = argv;
  return { inputDirectory, outputDirectory };
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

function compileWizzFile(inputPath, outputPath, options = {}) {
  const rawWizzCode = fs.readFileSync(inputPath, 'utf-8');
  const { source: generatedModule, sourceMap } = compile(rawWizzCode, { filePath: inputPath });

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  writeGeneratedModule(outputPath, generatedModule, sourceMap);

  if (!options.isRoutePage) {
    return { serverRenderable: false, ineligibilityReason: null };
  }

  // A route page server-renders only when it compiles through the server
  // target. Both server targets are compiled before either file is written,
  // so a page never ships a server module without its hydratable client
  // build. After a successful client compile, a server-target failure is by
  // construction the server-renderability gate (both targets share the same
  // parse/analyze pipeline), so it is treated as ineligibility rather than a
  // build failure; the reason is surfaced to the caller for logging.
  try {
    const serverResult = compileServer(rawWizzCode, { filePath: inputPath });
    const hydratableResult = compile(rawWizzCode, { filePath: inputPath, hydratable: true });

    // Server output carries no source map (HTML string rendering, not
    // positional DOM artifacts).
    writeGeneratedModule(outputPath.replace(/\.js$/, '.server.js'), serverResult.source, null);
    writeGeneratedModule(outputPath.replace(/\.js$/, '.hydrate.js'), hydratableResult.source, hydratableResult.sourceMap);

    return { serverRenderable: true, ineligibilityReason: null };
  } catch (error) {
    return {
      serverRenderable: false,
      ineligibilityReason: String(error.message).split('\n', 1)[0]
    };
  }
}

function copyRuntimeModules(outputDirectory) {
  const runtimeSourceDirectory = path.join(__dirname, 'src', 'runtime');
  const runtimeOutputDirectory = path.join(outputDirectory, 'runtime');

  fs.cpSync(runtimeSourceDirectory, runtimeOutputDirectory, { recursive: true });
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

function buildProject(inputDirectory, outputDirectory, logger = console) {
  const resolvedInputDirectory = path.resolve(inputDirectory);
  const resolvedOutputDirectory = path.resolve(outputDirectory);

  if (!fs.existsSync(resolvedInputDirectory) || !fs.statSync(resolvedInputDirectory).isDirectory()) {
    throw new Error(`Input directory does not exist or is not a directory: ${resolvedInputDirectory}`);
  }

  if (resolvedInputDirectory === resolvedOutputDirectory) {
    throw new Error('Input and output directories must be different.');
  }

  const inputFiles = discoverWizzFiles(resolvedInputDirectory);
  let failedCount = 0;
  const serverRenderableByInputPath = new Map();

  for (const inputPath of inputFiles) {
    const outputPath = getOutputPath(resolvedInputDirectory, resolvedOutputDirectory, inputPath);
    const isRoutePage = getRoutePath(resolvedInputDirectory, inputPath) !== null;

    try {
      const result = compileWizzFile(inputPath, outputPath, { isRoutePage });
      logger.log(`Compiled ${inputPath} -> ${outputPath}`);
      serverRenderableByInputPath.set(inputPath, result.serverRenderable);

      if (result.ineligibilityReason) {
        logger.log(`Note: server rendering skipped for ${inputPath} — ${result.ineligibilityReason} Serving the client build only.`);
      }
    } catch (error) {
      failedCount++;
      logger.error(`Compilation failed for ${inputPath}: ${error.message}`);
    }
  }

  copyRuntimeModules(resolvedOutputDirectory);
  emitRouteManifest(resolvedInputDirectory, resolvedOutputDirectory, inputFiles, serverRenderableByInputPath);

  return {
    compiledCount: inputFiles.length - failedCount,
    failedCount
  };
}

function main(argv, logger = console) {
  const { inputDirectory, outputDirectory } = parseBuildArguments(argv);
  const result = buildProject(inputDirectory, outputDirectory, logger);

  return result.failedCount === 0 ? 0 : 1;
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
  buildProject,
  compileWizzFile,
  copyRuntimeModules,
  discoverWizzFiles,
  emitRouteManifest,
  getRoutePath,
  validateRouteEntries,
  getOutputPath,
  main,
  parseBuildArguments
};
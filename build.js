// build.js
const fs = require('node:fs');
const path = require('node:path');

// Single public compiler entry point: parsing, analysis, ID assignment, generation.
const { compile } = require('./src/compiler');

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

function compileWizzFile(inputPath, outputPath) {
  const rawWizzCode = fs.readFileSync(inputPath, 'utf-8');
  const { source: generatedModule, sourceMap } = compile(rawWizzCode, { filePath: inputPath });

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
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

function copyRuntimeModules(outputDirectory) {
  const runtimeSourceDirectory = path.join(__dirname, 'src', 'runtime');
  const runtimeOutputDirectory = path.join(outputDirectory, 'runtime');

  fs.cpSync(runtimeSourceDirectory, runtimeOutputDirectory, { recursive: true });
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

  for (const inputPath of inputFiles) {
    const outputPath = getOutputPath(resolvedInputDirectory, resolvedOutputDirectory, inputPath);

    try {
      compileWizzFile(inputPath, outputPath);
      logger.log(`Compiled ${inputPath} -> ${outputPath}`);
    } catch (error) {
      failedCount++;
      logger.error(`Compilation failed for ${inputPath}: ${error.message}`);
    }
  }

  copyRuntimeModules(resolvedOutputDirectory);

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
  getOutputPath,
  main,
  parseBuildArguments
};
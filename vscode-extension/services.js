const path = require('node:path');

const LOCATION_PATTERN = /(?:^|\s)((?:(?:[A-Za-z]:)?[\\/][^:\n]*|[^\s:]+)\.wizz):(\d+):(\d+)(?:\b|$)/;
const IMPORT_PATTERN = /^\s*import\s+[A-Za-z_$][\w$]*\s+from\s+['"]([^'"]+\.wizz)['"]\s*;/;

function parseCompilerDiagnostics(output) {
  const lines = String(output).split(/\r?\n/);
  const starts = lines.reduce((indexes, line, index) => {
    if (line.startsWith('Compilation failed for ') && line.match(LOCATION_PATTERN)) indexes.push(index);
    return indexes;
  }, []);

  if (starts.length === 0) {
    const index = lines.findIndex((line) => line.match(LOCATION_PATTERN));
    if (index !== -1) starts.push(index);
  }

  return starts.map((start, index) => {
    const line = lines[start];
    const match = line.match(LOCATION_PATTERN);
    const end = starts[index + 1] === undefined ? lines.length : starts[index + 1];
    const message = lines.slice(start, end)
      .join('\n')
      .replace(/^Compilation failed for [^:]+:\s*/, '')
      .trim();

    return {
      filePath: match[1],
      line: Number(match[2]),
      column: Number(match[3]),
      message
    };
  });
}

function parseCompilerDiagnostic(output) {
  return parseCompilerDiagnostics(output)[0] || null;
}

function findComponentImport(line, sourceFilePath) {
  const match = line.match(IMPORT_PATTERN);
  if (!match) return null;

  return path.resolve(path.dirname(sourceFilePath), match[1]);
}

function getPageRoute(workspacePath, pagePath) {
  const relativePath = path.relative(path.join(workspacePath, 'src'), pagePath).split(path.sep);
  if (relativePath.length === 1 && relativePath[0] === 'App.wizz') return '/';
  if (relativePath[0] !== 'pages' || path.extname(pagePath) !== '.wizz') return null;

  const routeSegments = relativePath.slice(1, -1);
  const pageName = path.basename(pagePath, '.wizz');
  if (pageName !== 'index') routeSegments.push(pageName);
  return `/${routeSegments.join('/').toLowerCase()}`.replace(/\/$/, '') || '/';
}

function createBuildArguments(command, workspacePath) {
  if (command !== 'build' && command !== 'dev') {
    throw new Error(`Unsupported Wizz command: ${command}`);
  }

  return {
    command,
    arguments: command === 'build' ? [] : [],
    cwd: workspacePath
  };
}

module.exports = {
  createBuildArguments,
  findComponentImport,
  getPageRoute,
  parseCompilerDiagnostic,
  parseCompilerDiagnostics
};
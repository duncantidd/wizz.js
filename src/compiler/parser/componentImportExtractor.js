const IMPORT_PATTERN = /^\s*import\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s+(['"])([^'"]+\.wizz)\2\s*;?\s*$/gm;

function extractComponentImports(scriptContent) {
  if (!scriptContent || typeof scriptContent !== 'string') {
    return { imports: [], script: scriptContent || '' };
  }

  const imports = [];
  const script = scriptContent.replace(IMPORT_PATTERN, (statement, name, quote, source) => {
    imports.push({ name, source });
    return '';
  });

  return { imports, script };
}

module.exports = { extractComponentImports };
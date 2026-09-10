const BASE64_VLQ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function encodeVlq(value) {
  let encoded = '';
  let vlq = value < 0 ? ((-value) << 1) | 1 : value << 1;

  do {
    let digit = vlq & 31;
    vlq >>>= 5;
    if (vlq > 0) digit |= 32;
    encoded += BASE64_VLQ[digit];
  } while (vlq > 0);

  return encoded;
}

function getLineAndColumn(source, offset) {
  const precedingSource = source.slice(0, offset);
  const lines = precedingSource.split(/\r?\n/);

  return {
    line: lines.length - 1,
    column: lines.at(-1).length
  };
}

function createSourceMap(componentSource, generatedSource, filePath, rawScript) {
  if (
    typeof componentSource !== 'string' ||
    typeof generatedSource !== 'string' ||
    typeof filePath !== 'string' ||
    !filePath ||
    typeof rawScript !== 'string' ||
    !rawScript
  ) {
    return null;
  }

  const scriptTagStart = componentSource.indexOf('<script');
  const scriptOffset = componentSource.indexOf('>', scriptTagStart) + 1;
  const generatedScriptMarker = '// --- Developer Logic ---';
  const markerOffset = generatedSource.indexOf(generatedScriptMarker);
  if (scriptTagStart === -1 || scriptOffset === 0 || markerOffset === -1) return null;

  const originalStart = getLineAndColumn(componentSource, scriptOffset);
  const generatedMarker = getLineAndColumn(generatedSource, markerOffset);
  const scriptLines = rawScript.split('\n');
  const generatedStartLine = generatedMarker.line + 1;
  const mappings = Array.from({ length: generatedStartLine + scriptLines.length }, () => '');
  let previousSource = 0;
  let previousOriginalLine = 0;
  let previousOriginalColumn = 0;

  scriptLines.forEach((scriptLine, index) => {
    const generatedColumn = 2;
    const originalColumn = index === 0 ? originalStart.column : 0;
    const originalLine = originalStart.line + index;
    mappings[generatedStartLine + index] = [
      encodeVlq(generatedColumn),
      encodeVlq(0 - previousSource),
      encodeVlq(originalLine - previousOriginalLine),
      encodeVlq(originalColumn - previousOriginalColumn)
    ].join('');
    previousSource = 0;
    previousOriginalLine = originalLine;
    previousOriginalColumn = originalColumn;
  });

  return {
    version: 3,
    sources: [filePath],
    sourcesContent: [componentSource],
    names: [],
    mappings: mappings.join(';')
  };
}

module.exports = { createSourceMap, encodeVlq };
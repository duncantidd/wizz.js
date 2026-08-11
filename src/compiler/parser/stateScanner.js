/**
 * Scans a raw JavaScript string for top-level state and function declarations.
 * @param {string} scriptContent - The raw JS string extracted from the <script> tag.
 * @returns {Array<Object>} An array of state declaration nodes.
 */
function scanState(scriptContent) {
  if (!scriptContent || typeof scriptContent !== 'string') {
    return [];
  }

  const declarations = [];

  // Regex to match: let or const -> space -> identifier -> optional space -> '=' -> value -> ';'
  // The [\s\S]*? ensures we capture multi-line values (like objects or arrays) until the semi-colon.
  const variableRegex = /\b(let|const)\s+([a-zA-Z_$][0-9a-zA-Z_$]*)\s*=\s*([\s\S]*?);/g;
  
  // Regex to match: function -> space -> identifier -> '('
  const functionRegex = /\bfunction\s+([a-zA-Z_$][0-9a-zA-Z_$]*)\s*\(/g;

  let match;

  // 1. Scan for Variables (State and Constants)
  while ((match = variableRegex.exec(scriptContent)) !== null) {
    declarations.push({
      type: 'VariableDeclaration',
      kind: match[1], // 'let' or 'const'
      name: match[2], // e.g., 'count'
      initialValue: match[3].trim(), // e.g., '0' or '{ active: true }'
      isReactive: match[1] === 'let' // Only 'let' variables trigger DOM updates
    });
  }

  // 2. Scan for Functions (Methods/Event Handlers)
  while ((match = functionRegex.exec(scriptContent)) !== null) {
    declarations.push({
      type: 'FunctionDeclaration',
      name: match[1] // e.g., 'handleClick'
    });
  }

  return declarations;
}

module.exports = { scanState };
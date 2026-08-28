const { tokenize } = require('./tokenizer.js');
const { parseTemplate } = require('./templateParser.js');
const { integrateExpressions } = require('./integrator.js');
const { extractScriptBlock } = require('./extractor.js');
const { extractComponentImports } = require('./componentImportExtractor.js');
const { scanState } = require('./stateScanner.js');

/**
 * Parses a raw framework component file into a unified AST and Logic payload.
 * @param {string} source - The raw string content of the component file.
 * @returns {Object} The Final Compiler Handoff Object.
 */
function parseComponent(source) {
  if (typeof source !== 'string') {
    throw new TypeError('Component source must be a string.');
  }

  // 1. Tokenize the raw string 
  const tokens = tokenize(source);

  // 2. Build the structural Template AST 
  const rawTemplateAST = parseTemplate(tokens);

  // 3. Integrate the Pratt Expression ASTs into the template 
  const integratedTemplateAST = integrateExpressions(rawTemplateAST);

  // 4. Extract the <script> block and remove its node from the visual DOM tree 
  const scriptContent = extractScriptBlock(integratedTemplateAST);
  const { imports, script } = extractComponentImports(scriptContent);

  // 5. Scan the extracted script for state and logic 
  const scriptDeclarations = scanState(script);

  // 6. Return the Final Handoff Object 
  return {
    template: integratedTemplateAST,
    script: scriptDeclarations,
    rawScript: script || '',
    imports
  };
}

module.exports = { parseComponent };
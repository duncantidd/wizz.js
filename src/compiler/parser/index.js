const { tokenize } = require('./tokenizer.js');
const { parseTemplate } = require('./templateParser.js');
const { integrateExpressions } = require('./integrator.js');
const { extractScriptBlock, extractHeadBlock } = require('./extractor.js');
const { extractComponentImports } = require('./componentImportExtractor.js');
const { extractProps } = require('./propExtractor.js');
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

  // 4b. Extract the top-level <wizz:head> block (if any) into its own payload
  // field. Body-emitting stages see a template with the head already pruned.
  const headBlock = extractHeadBlock(integratedTemplateAST);

  // 5. Extract `export let` prop declarations before scanning state so the
  // statements are removed from the script and recorded for the generator.
  const { props, script: scriptWithoutProps } = extractProps(script);

  // 6. Scan the extracted script for state and logic
  const scriptDeclarations = scanState(scriptWithoutProps);

  // A prop and a component-scope declaration sharing a name is a generated
  // redeclaration error. It is deliberately not rejected here: scanState is a
  // global scanner that also matches legal block-scoped shadows, so a check
  // on its output would reject valid scripts.

  // Props participate in reactivity exactly like `let` state; `isProp` marks
  // them as parent-owned inputs so the generator can emit read-only bindings
  // fed through the props argument instead of author declarations.
  const propDeclarations = props.map((prop) => ({
    type: 'VariableDeclaration',
    kind: 'let',
    name: prop.name,
    initialValue: null,
    isReactive: true,
    isProp: true
  }));

  // 7. Return the Final Handoff Object
  return {
    template: integratedTemplateAST,
    head: headBlock,
    script: [...propDeclarations, ...scriptDeclarations],
    rawScript: scriptWithoutProps || '',
    imports,
    props
  };
}

module.exports = { parseComponent };
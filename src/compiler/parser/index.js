const { tokenize } = require('./tokenizer.js');
const { parseTemplate } = require('./templateParser.js');
const { integrateExpressions } = require('./integrator.js');
const { extractScriptBlock, extractHeadBlock, extractStyleBlock } = require('./extractor.js');
const { extractComponentImports } = require('./componentImportExtractor.js');
const { extractProps } = require('./propExtractor.js');
const { scanState } = require('./stateScanner.js');

// Deterministic scope value for styled components: two classic string hashes
// (FNV-1a and djb2) accumulated over the full component source, mixed and
// rendered in base36. Server and client builds compile the same source, so
// both derive the same scope without sharing any compile options; the scope
// changes only when the source does. A 32-bit final mix gives a collision
// margin (~1 in 4 billion per pair) far beyond any real project's component
// count; the `s` prefix keeps the value letter-led in selectors and markup.
function computeStyleScope(source) {
  let fnv = 0x811c9dc5;
  let djb2 = 5381;
  for (let i = 0; i < source.length; i++) {
    const code = source.charCodeAt(i);
    fnv ^= code;
    fnv = Math.imul(fnv, 0x01000193);
    djb2 = Math.imul(djb2, 33) + code;
  }
  return `s${(Math.imul(fnv ^ djb2, 0x27d4eb2d) >>> 0).toString(36)}`;
}

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

  // 4c. Extract the top-level <wizz:style> block (if any). Style content is
  // opaque author CSS — never body markup — so the template handed onward is
  // pruned of it too. The scope is hashed from the full component source so
  // every build of the same file agrees on it.
  const styleBlock = extractStyleBlock(integratedTemplateAST);
  const style = styleBlock === null
    ? null
    : { css: styleBlock.value.trim(), scope: computeStyleScope(source), loc: styleBlock.loc };

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
    style,
    script: [...propDeclarations, ...scriptDeclarations],
    rawScript: scriptWithoutProps || '',
    imports,
    props
  };
}

module.exports = { parseComponent };
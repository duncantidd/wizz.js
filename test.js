const { tokenize } = require("./src/compiler/parser/tokenizer.js");
const { parseTemplate } = require("./src/compiler/parser/templateParser.js");
const { integrateExpressions } = require("./src/compiler/parser/integrator.js");
const { extractScriptBlock } = require("./src/compiler/parser/extractor.js");

const header = '<script>console.log("Hello, {user.name}!");</script><div class="hero"><h1>Hello, {user.name}!</h1></div>';

// 1. Tokenize the raw HTML string
const tokens = tokenize(header);

// 2. Build the structural Template AST
const templateAST = parseTemplate(tokens);

// 3. Integrate the parsed JS expressions into the Template AST
const finalUnifiedAST = integrateExpressions(templateAST);

// 4. Extract the script block from the final unified AST
const scriptContent = extractScriptBlock(finalUnifiedAST);

console.log(JSON.stringify(finalUnifiedAST, null, 2));
console.log("Extracted script content:", scriptContent);
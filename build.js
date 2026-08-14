// build.js
const fs = require('node:fs');
const path = require('node:path');

// Import your pipeline tools
const { parseComponent } = require('./src/compiler/parser/index.js');
const { analyzeDependencies } = require('./src/compiler/analyzer/dependencyAnalyzer.js');
const { assignNodeIds } = require('./src/compiler/analyzer/idAssigner.js');
const { generateComponent } = require('./src/compiler/generator/componentGenerator.js');

function compileWizzFile(inputPath, outputPath) {
  console.log(`\n🧙‍♂️ Compiling ${inputPath}...`);
  
  // 1. Read the raw .wizz file
  const rawWizzCode = fs.readFileSync(inputPath, 'utf-8');

  try {
    // 2. Run it through the pipeline you built
    const parserPayload = parseComponent(rawWizzCode);
    const analyzedPayload = analyzeDependencies(parserPayload);
    const finalPayload = assignNodeIds(analyzedPayload);
    const vanillaJsOutput = generateComponent(finalPayload);

    // 3. Write the compiled JavaScript to the output destination
    fs.writeFileSync(outputPath, vanillaJsOutput, 'utf-8');
    console.log(`✅ Successfully compiled to ${outputPath}`);
    
  } catch (error) {
    console.error(`❌ Compilation failed for ${inputPath}:`, error.message);
  }
}

// Example Usage: Compile App.wizz into App.js
const input = path.join(__dirname, 'App.wizz');
const output = path.join(__dirname, 'App.js');

compileWizzFile(input, output);
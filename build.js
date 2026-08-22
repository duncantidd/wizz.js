// build.js
const fs = require('node:fs');
const path = require('node:path');

// Single public compiler entry point: parsing, analysis, ID assignment, generation.
const { compile } = require('./src/compiler');

function compileWizzFile(inputPath, outputPath) {
  console.log(`\n🧙‍♂️ Compiling ${inputPath}...`);

  // 1. Read the raw .wizz file
  const rawWizzCode = fs.readFileSync(inputPath, 'utf-8');

  try {
    // 2. Run it through the compiler; errors name the file and source location
    const { source: vanillaJsOutput } = compile(rawWizzCode, { filePath: inputPath });

    // 3. Write the compiled JavaScript to the output destination
    fs.writeFileSync(outputPath, vanillaJsOutput, 'utf-8');
    console.log(`✅ Successfully compiled to ${outputPath}`);

  } catch (error) {
    console.error(`❌ Compilation failed:`, error.message);
  }
}

// Example Usage: Compile App.wizz into App.js
const input = path.join(__dirname, 'App.wizz');
const output = path.join(__dirname, 'App.js');

compileWizzFile(input, output);
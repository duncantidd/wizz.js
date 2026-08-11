const { parseComponent } = require('./src/compiler/parser/index.js');
const { analyzeDependencies } = require('./src/compiler/analyzer/dependencyAnalyzer.js');
const { assignNodeIds } = require('./src/compiler/analyzer/idAssigner.js');
const { generateComponent } = require('./src/compiler/generator/componentGenerator.js');

// 1. The Input
const rawWizzCode = `
<script>
  let count = 0;
  function increment() {
    count += 1;
  }
</script>
<main>
  <h1>Count: {count}</h1>
</main>
`;

// 2. The Pipeline
const parserPayload = parseComponent(rawWizzCode);
const analyzedPayload = analyzeDependencies(parserPayload);
const finalPayload = assignNodeIds(analyzedPayload);
const vanillaJsOutput = generateComponent(finalPayload);

// 3. The Output
console.log(vanillaJsOutput);
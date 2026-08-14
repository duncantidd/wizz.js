const { parseComponent } = require('./src/compiler/parser');
const { analyzeDependencies } = require('./src/compiler/analyzer/dependencyAnalyzer');
const { assignNodeIds } = require('./src/compiler/analyzer/idAssigner');
const { generateComponent } = require('./src/compiler/generator/componentGenerator');

const source = `
<script>
  let count = 0;
</script>
<main><p>Count: {count}</p></main>
`;

const parsed = parseComponent(source);
const analyzed = analyzeDependencies(parsed);
const identified = assignNodeIds(analyzed);
const output = generateComponent(identified);

console.log(output);
const { compile } = require('./src/compiler');

const source = `
<script>
  let count = 0;
</script>
<main><p>Count: {count}</p></main>
`;

// One call runs parsing, analysis, ID assignment, and generation.
const { source: generatedModule } = compile(source);

console.log(generatedModule);

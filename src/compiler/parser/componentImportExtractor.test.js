const assert = require('node:assert/strict');
const test = require('node:test');
const { extractComponentImports } = require('./componentImportExtractor');

test('extracts default .wizz imports while preserving component logic', () => {
  const result = extractComponentImports(`
    import Counter from './components/Counter.wizz';
    import Card from "./Card.wizz";
    let count = 0;
  `);

  assert.deepEqual(result.imports, [
    { name: 'Counter', source: './components/Counter.wizz' },
    { name: 'Card', source: './Card.wizz' }
  ]);
  assert.match(result.script, /let count = 0;/);
  assert.doesNotMatch(result.script, /import/);
});

test('leaves unsupported JavaScript imports in the component script', () => {
  const result = extractComponentImports("import { helper } from './helper.js';");

  assert.deepEqual(result.imports, []);
  assert.equal(result.script, "import { helper } from './helper.js';");
});
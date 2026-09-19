const assert = require('node:assert/strict');
const test = require('node:test');
const { scanState } = require('../parser/stateScanner');
const { rewritePersistInitializers } = require('./persistInitializer');

const clientReplacement = (declaration) =>
  `__wizzPersistRead(${JSON.stringify(declaration.storageKey)}, (${declaration.defaultValue}))`;
const serverReplacement = (declaration) => `(${declaration.defaultValue})`;

test('replaces persistent initializers by their recorded spans', () => {
  const rawScript = "let theme = persist('theme', 'light');\nlet count = 0;";
  const declarations = scanState(rawScript);

  const client = rewritePersistInitializers(rawScript, declarations, clientReplacement);
  assert.equal(client, 'let theme = __wizzPersistRead("theme", (\'light\'));\nlet count = 0;');

  const server = rewritePersistInitializers(rawScript, declarations, serverReplacement);
  assert.equal(server, "let theme = ('light');\nlet count = 0;");
});

test('rewrites multiple persistent declarations including later lines', () => {
  const rawScript = "let count = 0;\nlet theme = persist('theme', 'light');\nlet volume = persist('vol', 5);";
  const declarations = scanState(rawScript);

  const server = rewritePersistInitializers(rawScript, declarations, serverReplacement);
  assert.equal(server, 'let count = 0;\nlet theme = (\'light\');\nlet volume = (5);');
});

test('spans defeat look-alike persist text in comments and strings', () => {
  const rawScript = [
    "// persist('decoy', 'decoy') in a comment",
    "const note = \"persist('decoy2', 0)\";",
    "let theme = persist('theme', 'light');"
  ].join('\n');
  const declarations = scanState(rawScript);

  const server = rewritePersistInitializers(rawScript, declarations, serverReplacement);
  assert.equal(
    server,
    [
      "// persist('decoy', 'decoy') in a comment",
      'const note = "persist(\'decoy2\', 0)";',
      "let theme = ('light');"
    ].join('\n')
  );
});

test('returns the script untouched when nothing is persistent', () => {
  const rawScript = 'let count = 0;';
  assert.equal(rewritePersistInitializers(rawScript, scanState(rawScript), serverReplacement), rawScript);
  assert.equal(rewritePersistInitializers(rawScript, [], serverReplacement), rawScript);
  assert.equal(rewritePersistInitializers('', [], serverReplacement), '');
});

test('throws when a recorded span no longer points at a persist marker', () => {
  // Simulates compiler-internal drift: a span from a different script.
  const declarations = scanState("let theme = persist('theme', 'light');");
  assert.throws(
    () => rewritePersistInitializers('let other = 1;', declarations, serverReplacement),
    /Persistent initializer span no longer points at a persist\(\) marker/
  );
});

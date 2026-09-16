const assert = require('node:assert/strict');
const test = require('node:test');
const { scanState } = require('./stateScanner');

test('scans let and const declarations with their initial values', () => {
	const script = [
		'let count = 0;',
		"const label = 'Total';",
		'let user = {',
		"  name: 'John',",
		'  active: true',
		'};'
	].join('\n');

	assert.deepEqual(scanState(script), [
		{
			type: 'VariableDeclaration',
			kind: 'let',
			name: 'count',
			initialValue: '0',
			isReactive: true
		},
		{
			type: 'VariableDeclaration',
			kind: 'const',
			name: 'label',
			initialValue: "'Total'",
			isReactive: false
		},
		{
			type: 'VariableDeclaration',
			kind: 'let',
			name: 'user',
			initialValue: "{\n  name: 'John',\n  active: true\n}",
			isReactive: true
		}
	]);
});

test('scans named function declarations after variables', () => {
	const script = `
		function increment() {
			return count + 1;
		}
		let count = 0;
		function reset ( ) {}
	`;

	assert.deepEqual(scanState(script), [
		{
			type: 'VariableDeclaration',
			kind: 'let',
			name: 'count',
			initialValue: '0',
			isReactive: true
		},
		{
			type: 'FunctionDeclaration',
			name: 'increment'
		},
		{
			type: 'FunctionDeclaration',
			name: 'reset'
		}
	]);
});

test('returns no declarations for empty or non-string script content', () => {
	assert.deepEqual(scanState(), []);
	assert.deepEqual(scanState(''), []);
	assert.deepEqual(scanState(null), []);
	assert.deepEqual(scanState({}), []);
});

// --- Persistent state markers (milestone 17) ---

test('marks persist() initializers as persistent with their storage key and default', () => {
	const script = "let theme = persist('theme', 'light');";
	assert.deepEqual(scanState(script), [
		{
			type: 'VariableDeclaration',
			kind: 'let',
			name: 'theme',
			initialValue: "persist('theme', 'light')",
			isReactive: true,
			isPersistent: true,
			storageKey: 'theme',
			defaultValue: "'light'",
			initialValueStart: 12,
			initialValueEnd: 37
		}
	]);
});

test('parses defaults with commas, nested calls, and comment noise', () => {
	const script = "let cfg = persist('cfg', { a: 1, b: 'x,y' });";
	const [declaration] = scanState(script);
	assert.equal(declaration.storageKey, 'cfg');
	assert.equal(declaration.defaultValue, "{ a: 1, b: 'x,y' }");

	const [call] = scanState("let n = persist('n', clamp(1, 2, 3));");
	assert.equal(call.defaultValue, 'clamp(1, 2, 3)');

	const [commented] = scanState("let k = persist('k', /* half */ 42 /* done */);");
	assert.equal(commented.defaultValue, '/* half */ 42 /* done */');

	const [number] = scanState('let v = persist("v", 0);');
	assert.equal(number.storageKey, 'v');
	assert.equal(number.defaultValue, '0');
});

test('cooks escape sequences in the storage key', () => {
	const [declaration] = scanState("let a = persist('it\\'s', 1);");
	assert.equal(declaration.storageKey, "it's");

	const [newline] = scanState('let b = persist("a\\nb", 1);');
	assert.equal(newline.storageKey, 'a\nb');
});

test('records spans that survive duplicate look-alike text elsewhere in the script', () => {
	// The same marker text appears in a comment BEFORE the declaration; the
	// recorded span must point at the real initializer, not the comment.
	const script = [
		"// persist('theme', 'light') is the marker syntax",
		"let theme = persist('theme', 'light');"
	].join('\n');
	const [declaration] = scanState(script);
	assert.equal(declaration.isPersistent, true);
	const span = script.slice(declaration.initialValueStart, declaration.initialValueEnd);
	assert.equal(span, "persist('theme', 'light')");
});

test('rejects persist() on a const declaration', () => {
	assert.throws(
		() => scanState("const c = persist('k', 1);"),
		/persist\(\) requires a reactive 'let' declaration; 'c' is const at \d+:\d+\./
	);
});

test('rejects persist() with a missing default', () => {
	assert.throws(
		() => scanState("let a = persist('k');"),
		/persist\(\) requires a storage key and a default value at \d+:\d+\./
	);
});

test('rejects persist() with a non-string key', () => {
	assert.throws(
		() => scanState("let a = persist(123, 'x');"),
		/persist\(\) requires a string-literal storage key at \d+:\d+\./
	);
	assert.throws(
		() => scanState("let a = persist(key, 'x');"),
		/persist\(\) requires a string-literal storage key at \d+:\d+\./
	);
});

test('rejects persist() with too many arguments', () => {
	assert.throws(
		() => scanState("let a = persist('k', 'x', 'y');"),
		/persist\(\) takes exactly two arguments at \d+:\d+\./
	);
});

test('rejects persist() with no arguments', () => {
	assert.throws(
		() => scanState('let a = persist();'),
		/persist\(\) requires a storage key and a default value at \d+:\d+\./
	);
});

test('rejects unclosed and trailing-statements persist() markers', () => {
	// The scanner's variable regex needs a terminating semicolon, so an
	// unclosed marker only reaches validation when the semicolon sits outside
	// the unbalanced parentheses.
	assert.throws(
		() => scanState("let a = persist('k', 'x';"),
		/persist\(\) initializer is missing its closing parenthesis at \d+:\d+\./
	);
	assert.throws(
		() => scanState("let a = persist('k', 'x') + 1;"),
		/persist\(\) takes no statements after its closing parenthesis at \d+:\d+\./
	);
});

test('rejects template-literal interpolation inside a persist() default', () => {
	assert.throws(
		() => scanState('let a = persist(\'k\', `x${1}`);'),
		/persist\(\) default expressions do not support template-literal interpolation at \d+:\d+\./
	);
});

test('rejects unsupported escapes in a persist() key', () => {
	assert.throws(
		() => scanState("let a = persist('k\\x41', 1);"),
		/persist\(\) requires a string-literal storage key at \d+:\d+\./
	);
});

test('leaves plain declarations byte-shaped exactly as before', () => {
	assert.deepEqual(scanState('let count = 0;'), [
		{
			type: 'VariableDeclaration',
			kind: 'let',
			name: 'count',
			initialValue: '0',
			isReactive: true
		}
	]);
});

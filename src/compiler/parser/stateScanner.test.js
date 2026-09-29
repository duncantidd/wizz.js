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

test('rejects persist() markers inside function bodies and blocks', () => {
	// The generators hoist state references to the component's mount scope,
	// so a marker inside a callback used to emit machinery that read and
	// wrote a variable existing only in the callback's own scope — the first
	// template evaluation died with "rawClicks is not defined". Any component
	// this rejects never worked, so the located error replaces the runtime
	// failure.
	assert.throws(
		() => scanState([
			'onMount(() => {',
			"  let rawClicks = persist('count', 0);",
			'});'
		].join('\n')),
		/persist\(\) must initialize a top-level let declaration; 'rawClicks' is declared inside a block or function body at 2:\d+\./
	);
	assert.throws(
		() => scanState("{ let theme = persist('theme', 'light'); }"),
		/persist\(\) must initialize a top-level let declaration; 'theme' is declared inside a block or function body at 1:\d+\./
	);
});

test('top-level markers stay recognized after plain nested declarations', () => {
	const [nested, count] = scanState([
		'function setup() { let local = 1; return local; }',
		"let count = persist('count', 0);"
	].join('\n'));
	assert.equal(nested.isPersistent, undefined);
	assert.equal(count.isPersistent, true);
	assert.equal(count.storageKey, 'count');
});

test('an author-defined persist binding disables marker recognition entirely', () => {
	// The marker owns the name only because the framework does; an author who
	// binds it themselves gets their own function back, compiled exactly as
	// components were before the marker syntax existed.
	const functionDefined = scanState([
		'function persist(key, initial) { return initial; }',
		"let theme = persist('theme', 'light');"
	].join('\n'));
	const themeFromFunction = functionDefined.find(declaration => declaration.name === 'theme');
	assert.equal(themeFromFunction.isPersistent, undefined);
	assert.equal(themeFromFunction.isReactive, true);

	const variableDefined = scanState([
		'let persist = (key, initial) => initial;',
		"let theme = persist('theme', 'light');"
	].join('\n'));
	const themeFromVariable = variableDefined.find(declaration => declaration.name === 'theme');
	assert.equal(themeFromVariable.isPersistent, undefined);
});

test('rejects persist() nested inside another persist() default', () => {
	// The splicer replaces only the outer initializer span, so an inner call
	// would survive verbatim and die with "persist is not defined" at
	// runtime.
	assert.throws(
		() => scanState("let a = persist('a', persist('b', 1));"),
		/persist\(\) cannot be nested inside another persist\(\) default at \d+:\d+\./
	);
	// Look-alike text inside a string default is not a nested marker.
	const [decl] = scanState('let a = persist(\'a\', "call persist(b, 2) here");');
	assert.equal(decl.isPersistent, true);
	assert.equal(decl.defaultValue, '"call persist(b, 2) here"');
});

test('regex literals do not corrupt the top-level check', () => {
	// The mode walk must treat a regex literal as a literal: its quote- and
	// comment-like contents would otherwise leave phantom modes open and a
	// top-level marker would be misread as nested.
	const theme = scanState([
		'const pattern = /persist\\(/;',
		"const comment = /'/;",
		"let theme = persist('theme', 'light');"
	].join('\n')).find(declaration => declaration.name === 'theme');
	assert.equal(theme.isPersistent, true);
	assert.equal(theme.storageKey, 'theme');
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

test('ignores declaration-shaped text inside string literals', () => {
	// A docs-style component whose script carries code samples as strings:
	// the sample's `let` declarations must not become phantom reactive state
	// (the generators would emit machinery referencing a variable that only
	// exists inside a quote, dying with a ReferenceError on first execution).
	const script = [
		'const sample = "let clicks = 0; let other = 2;";',
		"const template = 'let theme = persist(\\'theme\\', \\'light\\');';",
		'let real = 1;'
	].join('\n');

	assert.deepEqual(scanState(script), [
		{
			type: 'VariableDeclaration',
			kind: 'const',
			name: 'sample',
			initialValue: '"let clicks = 0; let other = 2;"',
			isReactive: false
		},
		{
			type: 'VariableDeclaration',
			kind: 'const',
			name: 'template',
			initialValue: "'let theme = persist(\\'theme\\', \\'light\\');'",
			isReactive: false
		},
		{
			type: 'VariableDeclaration',
			kind: 'let',
			name: 'real',
			initialValue: '1',
			isReactive: true
		}
	]);
});

test('ignores declaration-shaped text inside comments, template literals, and regex patterns', () => {
	const script = [
		'// let commented = 1;',
		'/* let blocked = 2; */',
		'const doc = `use let faked = 3; carefully`;',
		'const matcher = /let patterned = 4;/;',
		'let real = 5;'
	].join('\n');

	const names = scanState(script).map(declaration => declaration.name);
	assert.deepEqual(names, ['doc', 'matcher', 'real']);
	const real = scanState(script).find(declaration => declaration.name === 'real');
	assert.equal(real.isReactive, true);
});

test('ignores function declarations shaped as text inside strings', () => {
	const script = [
		'const sample = "function fake() { return 1; }";',
		'function real() {}'
	].join('\n');

	assert.deepEqual(scanState(script), [
		{
			type: 'VariableDeclaration',
			kind: 'const',
			name: 'sample',
			initialValue: '"function fake() { return 1; }"',
			isReactive: false
		},
		{
			type: 'FunctionDeclaration',
			name: 'real'
		}
	]);
});

test('a persist marker inside a string is not recognized as state', () => {
	const script = [
		'const sample = "let theme = persist(\'theme\', \'light\');";',
		'let count = 0;'
	].join('\n');

	const declarations = scanState(script);
	assert.equal(declarations.length, 2);
	assert.equal(declarations[0].isPersistent, undefined);
	assert.equal(declarations[1].isPersistent, undefined);
});

test('an author-defined persist binding shaped as text does not disable marker recognition', () => {
	const script = [
		'const docs = "function persist(key, value) { return value; }";',
		"let theme = persist('theme', 'light');"
	].join('\n');

	const [docs, theme] = scanState(script);
	assert.equal(docs.isPersistent, undefined);
	assert.equal(theme.isPersistent, true);
	assert.equal(theme.storageKey, 'theme');
});

test('initializer values containing semicolons inside strings keep their full value', () => {
	// The plain-text scan stopped at the FIRST semicolon, truncating the
	// initializer mid-string; the lexical walk finds the statement's true end.
	const script = 'let greeting = "hello; world";';
	const [declaration] = scanState(script);
	assert.equal(declaration.initialValue, '"hello; world"');
});

test('a persist() default containing a semicolon inside its string parses', () => {
	const script = "let theme = persist('theme', 'a; b');";
	const [declaration] = scanState(script);
	assert.equal(declaration.isPersistent, true);
	assert.equal(declaration.storageKey, 'theme');
	assert.equal(declaration.defaultValue, "'a; b'");
	const span = script.slice(declaration.initialValueStart, declaration.initialValueEnd);
	assert.equal(span, "persist('theme', 'a; b')");
});

test('for-header declarations keep their historical scan shape', () => {
	// A for-loop's `let i = 0` sits in code context (inside the header's
	// brackets) and has always been scanned; the lexical walk ends its
	// initializer at the header's own semicolon, as the plain-text scan did.
	const script = 'for (let i = 0; i < items.length; i += 1) { total += i; }';
	const [declaration] = scanState(script);
	assert.equal(declaration.name, 'i');
	assert.equal(declaration.initialValue, '0');
});

test('a regex initializer containing a semicolon keeps its full value', () => {
	const script = "const pattern = /a;b/;";
	const [declaration] = scanState(script);
	assert.equal(declaration.initialValue, '/a;b/');
});

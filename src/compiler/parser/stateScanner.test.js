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

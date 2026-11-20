const assert = require('node:assert/strict');
const test = require('node:test');
const { parseComponent } = require('./index');

// Issue #73: bind:value / bind:checked desugar into a dynamic attribute plus
// an inline handler that assigns the bound name.

const SCRIPT = "<script>\nlet name = 'Ada';\nlet age = 30;\nlet done = false;\nconst fixed = 1;\nexport let title = 'T';\n</script>";
const parse = (template, script = SCRIPT) => parseComponent(`${script}${template}`);
const firstElement = (payload) => payload.template.children.find((node) => node.type === 'Element');
const codeOf = (template, script) => {
  try {
    parse(template, script);
    return null;
  } catch (error) {
    return error.code;
  }
};

test('bind:value on a text input becomes value plus an input handler', () => {
  const input = firstElement(parse('<input class="a" bind:value={name} />'));
  assert.deepEqual(input.attributes, [
    { name: 'class', value: 'a' },
    { name: 'value', value: 'name', dynamic: true, expressionAST: { type: 'Identifier', name: 'name' }, bind: 'value' },
    { name: 'on:input', value: '(__wizzEvent) => { name = __wizzEvent.target.value; }', bindFor: 'value' }
  ]);
});

test('numeric inputs coerce, with an empty field stored as null', () => {
  for (const type of ['number', 'range', ' NUMBER ']) {
    const [valueAttribute, handler] = firstElement(parse(`<input type="${type}" bind:value={age} />`)).attributes.slice(1);
    assert.equal(valueAttribute.bind, 'number', type);
    assert.equal(handler.name, 'on:input');
    assert.equal(handler.value, "(__wizzEvent) => { age = __wizzEvent.target.value === '' ? null : +__wizzEvent.target.value; }");
  }
});

test('textarea binds on input, select on change, checkbox checked on change', () => {
  assert.equal(firstElement(parse('<textarea bind:value={name}></textarea>')).attributes[1].name, 'on:input');
  assert.equal(firstElement(parse('<select bind:value={name}><option>a</option></select>')).attributes[1].name, 'on:change');
  const checkbox = firstElement(parse('<input type="checkbox" bind:checked={done} />'));
  assert.deepEqual(checkbox.attributes.slice(1), [
    { name: 'checked', value: 'done', dynamic: true, expressionAST: { type: 'Identifier', name: 'done' }, bind: 'checked' },
    { name: 'on:change', value: '(__wizzEvent) => { done = __wizzEvent.target.checked; }', bindFor: 'checked' }
  ]);
});

test('bindings are desugared inside both if branches, nested ones included', () => {
  const payload = parse('<main>{#if done}<input bind:value={name} />{:else}<div>{#if done}<textarea bind:value={name}></textarea>{/if}</div>{/if}</main>',
    "<script>let name = ''; let done = true;</script>");
  const [block] = firstElement(payload).children;
  assert.equal(block.consequent[0].attributes[1].name, 'on:input');
  assert.equal(block.alternate[0].children[0].consequent[0].attributes[1].name, 'on:input');
});

test('bindings inside each bodies are WIZZ-P062, since item bodies would not follow the state', () => {
  // An item re-renders only when its collection changes, so the
  // state-to-control half of a binding would silently go stale, and an item
  // shadowing a same-named let would make the handler assign the item.
  for (const template of [
    '<ul>{#each items as item}<li><input bind:value={name} /></li>{/each}</ul>',
    '<ul>{#each items as name}<li><input bind:value={name} /></li>{/each}</ul>'
  ]) {
    assert.throws(() => parse(template, "<script>let name = ''; let items = [];</script>"),
      (error) => error.code === 'WIZZ-P062' && /inside \{#each\} bodies are not supported yet/.test(error.message), template);
  }
});

test('persistent state can be bound', () => {
  const input = firstElement(parse('<input bind:value={draft} />', "<script>let draft = persist('draft', '');</script>"));
  assert.equal(input.attributes[1].value, '(__wizzEvent) => { draft = __wizzEvent.target.value; }');
});

test('author on: handlers for the same event stay beside the binding', () => {
  const input = firstElement(parse('<input on:input={log} bind:value={name} />'));
  assert.deepEqual(input.attributes.map((attribute) => attribute.name), ['on:input', 'value', 'on:input']);
});

test('unsupported properties, elements, and input types are WIZZ-P062', () => {
  for (const template of [
    '<input bind:group={name} />',
    '<input bind:this={name} />',
    '<div bind:value={name}></div>',
    '<input type="checkbox" bind:value={name} />',
    '<input type="radio" bind:value={name} />',
    '<input type="file" bind:value={name} />',
    '<input bind:checked={done} />',
    '<input type="text" bind:checked={done} />',
    '<select bind:checked={done}></select>',
    '<input type={kind} bind:value={name} />'
  ]) {
    assert.equal(codeOf(template, `${SCRIPT.replace('</script>', "let kind = 'text';\n</script>")}`), 'WIZZ-P062', template);
  }
  assert.throws(() => parse('<main><input type={kind} bind:value={name} /></main>', "<script>let name = ''; let kind = 'text';</script>"),
    /Unsupported binding 'bind:value' on <input> at 1:\d+: a bound <input> needs a static type/);
});

test('bindings on imported component tags are WIZZ-P062', () => {
  const script = "<script>\nimport Field from './Field.wizz';\nlet name = '';\n</script>";
  assert.throws(() => parse('<main><Field bind:value={name} /></main>', script), (error) => error.code === 'WIZZ-P062' && /component props are one-way/.test(error.message));
});

test('targets must be a reactive let named directly: WIZZ-P063', () => {
  const cases = [
    ['<input bind:value="name" />', /needs a brace-delimited variable/],
    ['<input bind:value />', /needs a brace-delimited variable/],
    ['<input bind:value={user.name} />', /must name a variable; 'user\.name' is an expression/],
    ["<input bind:value={name + ''} />", /is an expression/],
    ['<input bind:value={fixed} />', /'fixed' is a const/],
    ['<input bind:value={missing} />', /'missing' is not declared there/],
    ['<input bind:value={title} />', /targets the prop 'title', and props are read-only/]
  ];
  for (const [template, message] of cases) {
    assert.throws(() => parse(template, SCRIPT.replace('</script>', 'let user = {};\n</script>')), (error) => error.code === 'WIZZ-P063' && message.test(error.message), template);
  }
});

test('a binding and an explicit attribute for the same property conflict: WIZZ-P064', () => {
  for (const template of [
    '<input value={name} bind:value={name} />',
    '<input value="x" bind:value={name} />',
    '<input bind:value={name} bind:value={age} />',
    '<input type="checkbox" checked bind:checked={done} />'
  ]) {
    assert.equal(codeOf(template), 'WIZZ-P064', template);
  }
});

test('templates without bindings are untouched', () => {
  const input = firstElement(parse('<input value={name} on:input={(e) => (name = e.target.value)} />'));
  assert.deepEqual(input.attributes.map((attribute) => attribute.name), ['value', 'on:input']);
  assert.equal('bind' in input.attributes[0], false);
});

test('bindings inside <wizz:head> are WIZZ-P062, not literal head attributes', () => {
  for (const template of [
    '<wizz:head><meta name="x" bind:value={name} /></wizz:head><p>{name}</p>',
    '<wizz:head><title bind:value={name}>T</title></wizz:head><p>{name}</p>',
    '<wizz:head><link rel="x" bind:checked={done} /></wizz:head><p>{name}</p>'
  ]) {
    assert.throws(() => parse(template), (error) => error.code === 'WIZZ-P062' && /bindings work on <input>, <textarea>, and <select>/.test(error.message), template);
  }
  // A head without bindings is untouched.
  const payload = parse('<wizz:head><meta name="x" content={name} /></wizz:head><p>{name}</p>');
  assert.deepEqual(payload.head.children[0].attributes.map((attribute) => attribute.name), ['name', 'content']);
});

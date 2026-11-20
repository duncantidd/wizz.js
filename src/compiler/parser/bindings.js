const { CODES, compilerDiagnostic } = require('../diagnostics.js');

// Two-way binding (issue #73): `bind:value={name}` and `bind:checked={done}`
// are sugar, rewritten here into exactly what an author writes by hand — a
// dynamic `value`/`checked` attribute plus an inline `on:` handler that
// assigns the bound name. Every later stage already handles both halves:
// the generator's inline-handler interception queues the update (and routes
// persistent state through its storage write), each-block items, branches,
// and hydration attach the listener in their own scopes, the server skips
// `on:` and renders the attribute, and the dependency analyzer tracks the
// attribute. Desugaring in the parser keeps that one implementation.
//
// Deliberately out of scope (each a located compile error, never a silent
// no-op): `bind:group`, `bind:this` and other properties, member or
// item-field targets (`bind:value={user.name}`), bindings on imported
// component tags, a dynamic `type` on a bound input (the binding's
// string-or-number semantics are decided at compile time), and bindings
// inside `{#each}` bodies: an item body re-renders only when its collection
// changes, so the state-to-control half would silently go stale.

const SUPPORTED = new Set(['value', 'checked']);
const NUMERIC_TYPES = new Set(['number', 'range']);
// Input types whose `value` is not what the user edits: checkboxes and radios
// toggle `checked`, and a file input's value is read-only.
const NON_VALUE_TYPES = new Set(['checkbox', 'radio', 'file']);

// The handler's event parameter carries the reserved `__wizz` prefix, so it
// can never shadow the bound name or any other author identifier.
const EVENT = '__wizzEvent';

function at(node) {
  const start = node.loc?.start;
  return start ? ` at ${start.line}:${start.column}` : '';
}

function findAttribute(node, name) {
  return (node.attributes || []).find((attribute) => attribute.name.toLowerCase() === name);
}

/**
 * Resolves what a binding on this element means, or throws.
 * @returns {{ property: string, event: string, numeric: boolean }}
 */
function bindingShape(node, attribute, property) {
  const where = `'${attribute.name}' on <${node.name}>${at(node)}`;
  const tag = node.name.toLowerCase();
  if (!SUPPORTED.has(property)) {
    throw compilerDiagnostic(CODES.parser.unsupportedBinding, `Unsupported binding ${where}: only bind:value and bind:checked exist.`);
  }
  if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') {
    throw compilerDiagnostic(CODES.parser.unsupportedBinding, `Unsupported binding ${where}: bindings work on <input>, <textarea>, and <select>.`);
  }

  let type = 'text';
  if (tag === 'input') {
    const typeAttribute = findAttribute(node, 'type');
    if (typeAttribute?.dynamic) {
      throw compilerDiagnostic(CODES.parser.unsupportedBinding, `Unsupported binding ${where}: a bound <input> needs a static type, because the binding's string or number value is decided at compile time.`);
    }
    if (typeAttribute && typeof typeAttribute.value === 'string') type = typeAttribute.value.trim().toLowerCase() || 'text';
  }

  if (property === 'checked') {
    if (tag !== 'input' || type !== 'checkbox') {
      throw compilerDiagnostic(CODES.parser.unsupportedBinding, `Unsupported binding ${where}: bind:checked needs <input type="checkbox">.`);
    }
    return { property, event: 'change', numeric: false };
  }

  if (tag === 'input' && NON_VALUE_TYPES.has(type)) {
    const hint = type === 'checkbox' ? ' Use bind:checked.' : type === 'radio' ? ' Radio groups are not bindable yet; use on:change.' : ' A file input\'s value is read-only.';
    throw compilerDiagnostic(CODES.parser.unsupportedBinding, `Unsupported binding ${where}: <input type="${type}"> has no editable value.${hint}`);
  }
  // A select reports a new value on change; text-like inputs and ranges on
  // every input event.
  return { property, event: tag === 'select' ? 'change' : 'input', numeric: tag === 'input' && NUMERIC_TYPES.has(type) };
}

function assertTarget(node, attribute, declarations) {
  const where = `'${attribute.name}' on <${node.name}>${at(node)}`;
  if (!attribute.dynamic || typeof attribute.value !== 'string') {
    throw compilerDiagnostic(CODES.parser.invalidBindingTarget, `Binding ${where} needs a brace-delimited variable, such as ${attribute.name}={name}.`);
  }
  const ast = attribute.expressionAST;
  if (ast?.type !== 'Identifier') {
    throw compilerDiagnostic(CODES.parser.invalidBindingTarget, `Binding ${where} must name a variable; '${attribute.value.trim()}' is an expression. Bind a top-level let and derive the rest from it.`);
  }
  const declaration = declarations.get(ast.name);
  if (declaration?.isProp) {
    throw compilerDiagnostic(CODES.parser.invalidBindingTarget, `Binding ${where} targets the prop '${ast.name}', and props are read-only. Copy it into a local let and bind that.`);
  }
  if (!declaration?.isReactive) {
    throw compilerDiagnostic(CODES.parser.invalidBindingTarget, `Binding ${where} must name a reactive let declared in the script; '${ast.name}' is ${declaration ? 'a const' : 'not declared there'}.`);
  }
  return ast.name;
}

function handlerSource(name, { property, numeric }) {
  const read = property === 'checked'
    ? `${EVENT}.target.checked`
    : numeric
      ? `${EVENT}.target.value === '' ? null : +${EVENT}.target.value`
      : `${EVENT}.target.value`;
  return `(${EVENT}) => { ${name} = ${read}; }`;
}

function desugarElement(node, declarations, componentNames, insideEach) {
  const attributes = node.attributes || [];
  if (!attributes.some((attribute) => attribute.name.startsWith('bind:'))) return;

  if (insideEach) {
    const attribute = attributes.find((candidate) => candidate.name.startsWith('bind:'));
    throw compilerDiagnostic(CODES.parser.unsupportedBinding, `Unsupported binding '${attribute.name}' on <${node.name}>${at(node)}: bindings inside {#each} bodies are not supported yet, because an item re-renders only when its collection changes. Use value={...} with an on:input handler.`);
  }

  if (componentNames.has(node.name)) {
    const attribute = attributes.find((candidate) => candidate.name.startsWith('bind:'));
    throw compilerDiagnostic(CODES.parser.unsupportedBinding, `Unsupported binding '${attribute.name}' on <${node.name}>${at(node)}: component props are one-way. Pass the value as a prop and a callback for changes.`);
  }

  const rewritten = [];
  const bound = new Set();
  for (const attribute of attributes) {
    if (!attribute.name.startsWith('bind:')) {
      rewritten.push(attribute);
      continue;
    }
    const property = attribute.name.slice('bind:'.length);
    const shape = bindingShape(node, attribute, property);
    const name = assertTarget(node, attribute, declarations);
    if (bound.has(property) || findAttribute(node, property)) {
      throw compilerDiagnostic(CODES.parser.conflictingBinding, `'${attribute.name}' on <${node.name}>${at(node)} conflicts with another '${property}' on the same element; the binding already sets it.`);
    }
    bound.add(property);
    rewritten.push(
      {
        name: property,
        value: attribute.value,
        dynamic: true,
        expressionAST: attribute.expressionAST,
        bind: shape.numeric ? 'number' : property
      },
      { name: `on:${shape.event}`, value: handlerSource(name, shape), bindFor: property }
    );
  }
  node.attributes = rewritten;
}

/**
 * Rewrites every `bind:` directive in the template into its attribute and
 * listener halves, in place.
 * @param {object} template - The integrated template AST.
 * @param {{ script: Array, imports: Array }} context - Script declarations
 *   (props included) and component imports.
 * @returns {object} The same template.
 */
function desugarBindings(template, { script = [], imports = [] } = {}) {
  const declarations = new Map();
  for (const declaration of script) {
    // A prop wins over a same-named scanned declaration: the prop is what
    // the component scope binds.
    if (declaration.type === 'VariableDeclaration' && (!declarations.has(declaration.name) || declaration.isProp)) {
      declarations.set(declaration.name, declaration);
    }
  }
  const componentNames = new Set(imports.map(({ name }) => name));

  // Each entry records whether an {#each} block encloses it.
  const stack = [[template, false]];
  while (stack.length) {
    const [node, insideEach] = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (node.type === 'Element') desugarElement(node, declarations, componentNames, insideEach);
    const inner = insideEach || node.type === 'EachBlock';
    for (const key of ['children', 'consequent', 'alternate']) {
      if (Array.isArray(node[key])) for (const child of node[key]) stack.push([child, inner]);
    }
  }
  return template;
}

module.exports = { desugarBindings };

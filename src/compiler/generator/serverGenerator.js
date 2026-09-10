// src/compiler/generator/serverGenerator.js
const { CodeBuilder } = require('./codeBuilder');
const { findReactiveMutations } = require('./assignmentInterceptor');
const { VERSIONS } = require('../version.js');

// Elements the HTML parser treats as empty. The server target omits their end
// tag, and the renderable gate refuses to give them children because real
// browsers re-parent such content and would break hydration alignment.
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

// Defined flush-left and emitted verbatim via Function.prototype.toString so
// the compile-time escaping applied to static template content and the
// runtime escaping applied to expression output are provably the same
// implementation. The `__wizz` prefix is reserved for the framework; author
// identifiers (props, state, functions) cannot collide with these names.
function __wizzEscapeText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function __wizzEscapeAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function __wizzSerializeInitialState(state) {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    throw new TypeError('serializeInitialState expects a state object.');
  }
  return '<script type="application/wizz-state">' + JSON.stringify(state).replace(/</g, '\\u003c') + '</script>';
}

/**
 * Reports whether the analyzed template contains only the surface the server
 * target renders: elements, text, interpolations, and dynamic attributes.
 * Conditionals, each blocks, imported component tags, void elements carrying
 * children, malformed event directives, and unsafe reactive state names are
 * rejected before any generation so both compile targets fail identically.
 * @param {Object} astPayload - The analyzed handoff payload.
 * @throws {SyntaxError} When the template exceeds the server-renderable surface.
 */
function assertServerRenderable(astPayload) {
  const templateAST = astPayload.template;
  const importedNames = new Set((astPayload.imports || []).map((component) => component.name));

  // Reactive state names feed the serialized state snapshot and the generated
  // bindings; the `__wizz` prefix and `__proto__` are reserved or unsafe.
  // Declarations carry no source location, so these errors are path-prefixed
  // by the file-aware error augmenter without a code frame.
  for (const declaration of astPayload.script || []) {
    if (declaration.type === 'VariableDeclaration' && declaration.isReactive
      && (declaration.name === '__proto__' || declaration.name.startsWith('__wizz'))) {
      throw new SyntaxError(`Reactive state name '${declaration.name}' is not allowed in server-rendered components.`);
    }
  }

  const assertElement = (node) => {
    if (importedNames.has(node.name)) {
      throw new SyntaxError(`Server rendering does not support component tags; <${node.name}> cannot be rendered server-side at ${node.loc.start.line}:${node.loc.start.column}.`);
    }
    if (VOID_ELEMENTS.has(node.name.toLowerCase()) && node.children && node.children.length > 0) {
      throw new SyntaxError(`Void element <${node.name}> cannot have children at ${node.loc.start.line}:${node.loc.start.column}.`);
    }
    for (const attribute of node.attributes || []) {
      // The server target skips event directives, but their validation must
      // match the browser target exactly so a component never renders
      // server-side and then fails to compile for the client.
      if (!attribute.name.startsWith('on:')) continue;
      const eventName = attribute.name.slice(3);
      const handlerExpression = attribute.value?.trim();
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(eventName)) {
        throw new SyntaxError(`Invalid event directive '${attribute.name}'.`);
      }
      if (!handlerExpression) {
        throw new SyntaxError(`Event directive '${attribute.name}' requires a handler expression.`);
      }
    }
  };

  const walk = (node) => {
    if (node.type === 'IfBlock') {
      throw new SyntaxError(`Server rendering does not support {#if} conditional blocks at ${node.loc.start.line}:${node.loc.start.column}.`);
    }
    if (node.type === 'EachBlock') {
      throw new SyntaxError(`Server rendering does not support {#each} blocks at ${node.loc.start.line}:${node.loc.start.column}.`);
    }
    if (node.type === 'Element') {
      assertElement(node);
      (node.children || []).forEach(walk);
    }
  };

  (templateAST.children || []).forEach(walk);

  const rootNode = (templateAST.children || []).find(node => node.type === 'Element');
  if (!rootNode) {
    throw new SyntaxError('Component template must contain a root element.');
  }
}

/**
 * Generates the self-contained server module for a component: a pure
 * string-rendering target that never touches DOM APIs.
 * @param {Object} astPayload - The final analyzed handoff payload.
 * @returns {string} The generated JavaScript module (ESM source).
 */
function generateServerComponent(astPayload) {
  assertServerRenderable(astPayload);

  const builder = new CodeBuilder();
  const props = astPayload.props || [];
  const templateAST = astPayload.template;
  const rootNode = templateAST.children.find(node => node.type === 'Element');
  const stateVars = (astPayload.script || [])
    .filter(declaration => declaration.type === 'VariableDeclaration' && declaration.isReactive && !declaration.isProp);

  // Prop bindings are parent-owned and read-only, with the same error
  // contract as the browser module.
  if (props.length > 0 && astPayload.rawScript) {
    const propMutations = findReactiveMutations(astPayload.rawScript, props.map((prop) => prop.name));
    if (propMutations.length > 0) {
      const first = propMutations[0];
      throw new SyntaxError(`Props are read-only: '${first.name}' cannot be assigned inside the component at ${first.line}:${first.column}.`);
    }
  }

  builder.add(`// Generated by Wizz ${VERSIONS.compiler} (component syntax ${VERSIONS.syntax}, server output ${VERSIONS.output}). Edits will be overwritten.`);
  builder.add('');
  builder.add('// Server rendering target. renderComponent(props) executes the component\'s trusted');
  builder.add('// top-level script and template to produce an HTML string plus a JSON-safe');
  builder.add('// snapshot of the reactive state. It never touches DOM APIs.');
  builder.add('');

  // The escaping helpers are emitted from their in-generator definitions so
  // static and dynamic escaping share one implementation.
  builder.add(__wizzEscapeText.toString());
  builder.add('');
  builder.add(__wizzEscapeAttribute.toString());
  builder.add('');
  builder.add(__wizzSerializeInitialState.toString());
  builder.add('export { __wizzSerializeInitialState as serializeInitialState };');
  builder.add('');

  builder.add('export function renderComponent(props = {}) {')
        .indent();

  // --- Props: same binding contract as the browser module. ---
  builder.add('// --- Props ---');
  props.forEach(({ name, defaultValue }) => {
    builder.add(defaultValue === null
      ? `let ${name} = props.${name};`
      : `let ${name} = props.${name} !== undefined ? props.${name} : (${defaultValue});`);
  });
  if (props.length > 0) builder.add('');

  // --- Developer logic: trusted execution, verbatim. Reactive assignment
  // --- interception is intentionally not applied; there is no reactive
  // --- update loop server-side.
  builder.add('// --- Developer Logic ---');
  if (astPayload.rawScript) {
    astPayload.rawScript.split('\n').forEach(line => builder.add(line));
  }

  // --- Lifecycle hooks are part of the author surface; the server collects
  // --- them as no-ops so hook registrations never throw and never run.
  builder.add('// --- Lifecycle hooks (registered, never invoked server-side) ---');
  builder.add('function onMount(hook) {}');
  builder.add('function onDestroy(hook) {}');
  builder.add('');

  builder.add('// --- Template ---');
  builder.add("const __wizzParts = [];");

  const isTextLike = (node) => node.type === 'Text' || node.type === 'Expression';

  function emitChildren(builder, children) {
    let previousWasTextLike = false;
    for (const child of children) {
      // Adjacent text-like children would merge into one DOM text node when
      // the browser parses the delivered markup, breaking the positional
      // childNodes targeting used by reactive updates. An empty comment
      // forces the parser to split them; comments cannot appear in Wizz
      // templates, so the marker is unambiguous.
      if (isTextLike(child) && previousWasTextLike) {
        builder.add("__wizzParts.push('<!-- -->');");
      }
      emitNode(builder, child);
      previousWasTextLike = isTextLike(child);
    }
  }

  function emitNode(builder, node) {
    if (node.type === 'Text') {
      builder.add(`__wizzParts.push(${JSON.stringify(__wizzEscapeText(node.value))});`);
      return;
    }
    if (node.type === 'Expression') {
      builder.add(`__wizzParts.push(__wizzEscapeText(String(${node.value})));`);
      return;
    }
    if (node.type === 'Element') {
      emitElement(builder, node);
      return;
    }
    // The renderable gate rejects every other node type before generation.
    throw new SyntaxError(`Server rendering does not support ${node.type} nodes at ${node.loc?.start?.line ?? '?'}:${node.loc?.start?.column ?? '?'}.`);
  }

  function emitElement(builder, node) {
    const isVoid = VOID_ELEMENTS.has(node.name.toLowerCase());
    let pending = `<${node.name}`;
    const flush = () => {
      if (pending !== '') {
        builder.add(`__wizzParts.push(${JSON.stringify(pending)});`);
        pending = '';
      }
    };

    for (const attribute of node.attributes || []) {
      // Event directives are client-only; hydration attaches the handlers.
      if (attribute.name.startsWith('on:')) continue;
      if (attribute.dynamic) {
        if (attribute.name === 'checked' || attribute.name === 'disabled') {
          // Absence is the false representation for boolean attributes.
          flush();
          builder.add(`if (${attribute.value}) __wizzParts.push(' ${attribute.name}');`);
          continue;
        }
        flush();
        builder.add(`__wizzParts.push(' ${attribute.name}="' + __wizzEscapeAttribute(String(${attribute.value})) + '"');`);
        continue;
      }
      pending += ` ${attribute.name}="${attribute.value === null ? '' : __wizzEscapeAttribute(attribute.value)}"`;
    }
    pending += '>';
    flush();

    if (!isVoid && node.children && node.children.length > 0) {
      emitChildren(builder, node.children);
      builder.add(`__wizzParts.push(${JSON.stringify(`</${node.name}>`)});`);
    }
  }

  // Only the first Element child of Root renders, matching the browser
  // target's root selection; surrounding root-level nodes are dropped.
  emitElement(builder, rootNode);

  builder.add('');
  builder.add("const html = __wizzParts.join('');");
  if (stateVars.length > 0) {
    builder.add(`const state = { ${stateVars.map(declaration => declaration.name).join(', ')} };`);
    builder.add('return { html, state };');
  } else {
    builder.add('return { html, state: {} };');
  }
  builder.dedent().add('}');

  return builder.generate();
}

module.exports = { generateServerComponent, assertServerRenderable, VOID_ELEMENTS };

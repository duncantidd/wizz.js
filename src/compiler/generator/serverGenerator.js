// src/compiler/generator/serverGenerator.js
const { CodeBuilder } = require('./codeBuilder');
const { findReactiveMutations } = require('./assignmentInterceptor');
const { buildComponentPropsSource } = require('./domGenerator');
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
 * target renders: elements, text, interpolations, dynamic attributes,
 * `{#if}` conditionals (the initially-taken branch), `{#each}` lists (the
 * initial collection), and imported component tags whose import the caller
 * has vouched for as server-renderable.
 *
 * Component eligibility cannot be decided inside the compiler — rendering
 * `<Counter>` renders Counter's own template, which the compiler never sees
 * from a single source string. `options.componentServerRenderable` maps an
 * import name to `true` when a server build exists for it. A missing or
 * false entry conservatively rejects the tag, which keeps the milestone 12
 * behavior for callers that pass no options at all.
 *
 * Both targets must agree on the surface, so these rules mirror the browser
 * generator exactly: `{#each}` bodies hold one root element with no nested
 * blocks, imported components, or event directives (domGenerator's
 * walkListNode restrictions), component tags take no children and no event
 * directives (buildComponentPropsSource), and event directives on regular
 * elements are validated with identical messages. Only the first root
 * element is rendered by both targets, so root-level nodes are not gated.
 * @param {Object} astPayload - The analyzed handoff payload.
 * @param {Object} [options] - Gate options.
 * @param {Object<string, boolean>} [options.componentServerRenderable] -
 *   Import names vouched for as having server-renderable builds.
 * @param {Object<string, string>} [options.componentIneligibilityReasons] -
 *   Import names mapped to the child's own gate failure, chained into the
 *   thrown diagnostic so the deepest blocking construct is identifiable.
 * @throws {SyntaxError} When the template exceeds the server-renderable surface.
 */
function assertServerRenderable(astPayload, options = {}) {
  const templateAST = astPayload.template;
  const importedNames = new Set((astPayload.imports || []).map((component) => component.name));
  const componentServerRenderable = (options && options.componentServerRenderable) || {};

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

  const where = (node) => `${node.loc.start.line}:${node.loc.start.column}`;

  const assertEventDirective = (attribute) => {
    const eventName = attribute.name.slice(3);
    const handlerExpression = attribute.value?.trim();
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(eventName)) {
      throw new SyntaxError(`Invalid event directive '${attribute.name}'.`);
    }
    if (!handlerExpression) {
      throw new SyntaxError(`Event directive '${attribute.name}' requires a handler expression.`);
    }
  };

  const assertComponentTag = (node) => {
    if (componentServerRenderable[node.name] !== true) {
      const reason = options && options.componentIneligibilityReasons
        ? options.componentIneligibilityReasons[node.name]
        : undefined;
      const suffix = reason
        ? ` Underlying reason: ${reason}`
        : ' No server-renderable build was provided for this import.';
      throw new SyntaxError(`Server rendering does not support component tags; <${node.name}> cannot be rendered server-side at ${where(node)}.${suffix}`);
    }
    if (node.children && node.children.length > 0) {
      throw new SyntaxError(`Component <${node.name}> does not support children at ${where(node)}.`);
    }
    for (const attribute of node.attributes || []) {
      if (attribute.name.startsWith('on:')) {
        throw new SyntaxError(`Event directive '${attribute.name}' is not supported on component <${node.name}>; component attributes become props at ${where(node)}.`);
      }
    }
  };

  const assertElement = (node) => {
    if (importedNames.has(node.name)) {
      assertComponentTag(node);
      return;
    }
    if (VOID_ELEMENTS.has(node.name.toLowerCase()) && node.children && node.children.length > 0) {
      throw new SyntaxError(`Void element <${node.name}> cannot have children at ${where(node)}.`);
    }
    for (const attribute of node.attributes || []) {
      if (attribute.name.startsWith('on:')) assertEventDirective(attribute);
    }
  };

  // Each bodies mirror the browser target's list-node restrictions exactly:
  // one root element, Text/Expression/Element children only, no nested
  // blocks, no imported components, and no event directives.
  const assertEachBody = (node) => {
    const contentNodes = node.children.filter((child) => child.type !== 'Text' || child.value.trim() !== '');
    if (contentNodes.length !== 1 || contentNodes[0].type !== 'Element') {
      throw new SyntaxError(`Each blocks must contain exactly one root element at ${where(node)}.`);
    }
    const assertListNode = (listNode) => {
      if (listNode.type === 'IfBlock' || listNode.type === 'EachBlock') {
        throw new SyntaxError(`Each block bodies do not support '${listNode.type}' nodes yet at ${where(listNode)}.`);
      }
      if (listNode.type === 'Element') {
        if (importedNames.has(listNode.name)) {
          throw new SyntaxError(`Imported components are not supported inside each blocks at ${where(listNode)}.`);
        }
        if (VOID_ELEMENTS.has(listNode.name.toLowerCase()) && listNode.children && listNode.children.length > 0) {
          throw new SyntaxError(`Void element <${listNode.name}> cannot have children at ${where(listNode)}.`);
        }
        for (const attribute of listNode.attributes || []) {
          if (attribute.name.startsWith('on:')) {
            throw new SyntaxError(`Event directive '${attribute.name}' is not supported inside each blocks yet at ${where(listNode)}.`);
          }
        }
        (listNode.children || []).forEach(assertListNode);
      }
    };
    assertListNode(contentNodes[0]);
  };

  const walk = (node) => {
    if (node.type === 'IfBlock') {
      (node.consequent || []).forEach(walk);
      (node.alternate || []).forEach(walk);
      return;
    }
    if (node.type === 'EachBlock') {
      assertEachBody(node);
      return;
    }
    if (node.type === 'Element') {
      assertElement(node);
      (node.children || []).forEach(walk);
    }
  };

  // Only the first Element child renders on either target, so only its
  // subtree is gated; root-level component tags are rejected because the
  // browser target refuses to mount one without a parent element.
  const rootNode = (templateAST.children || []).find(node => node.type === 'Element');
  if (!rootNode) {
    throw new SyntaxError('Component template must contain a root element.');
  }
  if (importedNames.has(rootNode.name)) {
    throw new SyntaxError(`Component <${rootNode.name}> must be nested inside an element at ${where(rootNode)}.`);
  }
  walk(rootNode);
}

/**
 * Generates the server module for a component: a pure string-rendering target
 * that never touches DOM APIs. Imported component tags render recursively —
 * the module imports the child's server module and embeds its HTML at the tag
 * position, collecting each child's state snapshot under the reserved
 * `__wizz.components` state key (only when the template contains component
 * tags, keeping component-free output byte-identical to milestone
 * 12).
 * @param {Object} astPayload - The final analyzed handoff payload.
 * @param {Object} [options] - Options forwarded to the renderable gate; see
 *   assertServerRenderable.
 * @returns {string} The generated JavaScript module (ESM source).
 */
function generateServerComponent(astPayload, options = {}) {
  assertServerRenderable(astPayload, options);

  const builder = new CodeBuilder();
  const props = astPayload.props || [];
  const templateAST = astPayload.template;
  const rootNode = templateAST.children.find(node => node.type === 'Element');
  const stateVars = (astPayload.script || [])
    .filter(declaration => declaration.type === 'VariableDeclaration' && declaration.isReactive && !declaration.isProp);
  const componentImports = astPayload.imports || [];
  const importedNames = new Set(componentImports.map((component) => component.name));

  // Prop bindings are parent-owned and read-only, with the same error
  // contract as the browser module.
  if (props.length > 0 && astPayload.rawScript) {
    const propMutations = findReactiveMutations(astPayload.rawScript, props.map((prop) => prop.name));
    if (propMutations.length > 0) {
      const first = propMutations[0];
      throw new SyntaxError(`Props are read-only: '${first.name}' cannot be assigned inside the component at ${first.line}:${first.column}.`);
    }
  }

  // Only imports the template actually renders are emitted, so an unused
  // import that failed the gate can never break module loading.
  const usedImportNames = new Set();
  const collectUsed = (node) => {
    if (node.type === 'Element' && importedNames.has(node.name)) {
      usedImportNames.add(node.name);
      return;
    }
    (node.children || []).forEach(collectUsed);
    (node.consequent || []).forEach(collectUsed);
    (node.alternate || []).forEach(collectUsed);
  };
  (templateAST.children || []).forEach(collectUsed);
  const hasComponentTags = usedImportNames.size > 0;

  builder.add(`// Generated by Wizz ${VERSIONS.compiler} (component syntax ${VERSIONS.syntax}, server output ${VERSIONS.output}). Edits will be overwritten.`);
  builder.add('');
  builder.add('// Server rendering target. renderComponent(props) executes the component\'s trusted');
  builder.add('// top-level script and template to produce an HTML string plus a JSON-safe');
  builder.add('// snapshot of the reactive state. It never touches DOM APIs.');
  builder.add('');

  // Child server modules are imported, not inlined: the build mirrors the
  // source layout into the output directory, so a component's relative
  // specifier resolves identically beside the generated module.
  const emittedImports = new Set();
  for (const component of componentImports) {
    if (!usedImportNames.has(component.name) || emittedImports.has(component.name)) continue;
    emittedImports.add(component.name);
    const serverPath = component.source.replace(/\.wizz$/, '.server.js');
    builder.add(`import * as __wizzServer_${component.name} from ${JSON.stringify(serverPath)};`);
  }
  if (emittedImports.size > 0) builder.add('');

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
    // analyzeDependencies strips import declarations from rawScript when each
    // sits on its own line; a line-packed script leaves them in, and a static
    // import inside renderComponent would be a module-load SyntaxError. Fail
    // at compile time with a clear message instead.
    if (/^\s*import\s*[A-Za-z0-9_$*{']/.test(astPayload.rawScript)) {
      throw new SyntaxError('Import statements must each be on their own line inside the component script.');
    }
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
  if (hasComponentTags) {
    builder.add('const __wizzChildStates = {};');
  }

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
      if (importedNames.has(node.name)) {
        emitComponentTag(builder, node);
        return;
      }
      emitElement(builder, node);
      return;
    }
    if (node.type === 'IfBlock') {
      // The server renders the initially-taken branch, evaluated against the
      // render-time state — the same expression the hydration walk
      // re-evaluates against the seeded state, so both targets select the
      // same branch. Markers sit at the block's own boundaries, never inside
      // the branches: an untaken branch emits nothing, so only the block
      // position needs protecting against the browser merging the text runs
      // that surround it, and the hydration walk strips comments before
      // comparing child counts.
      builder.add(`__wizzParts.push('<!-- -->');`);
      builder.add(`if (${node.test}) {`).indent();
      emitChildren(builder, node.consequent || []);
      builder.dedent();
      if (node.alternate) {
        builder.add('} else {').indent();
        emitChildren(builder, node.alternate || []);
        builder.dedent();
      }
      builder.add('}');
      builder.add(`__wizzParts.push('<!-- -->');`);
      return;
    }
    if (node.type === 'EachBlock') {
      // Only the single root element of the body renders per item (the gate
      // enforces the same shape the browser target builds). Item bodies are
      // element roots, so list items never introduce text adjacency.
      const contentNodes = node.children.filter((child) => child.type !== 'Text' || child.value.trim() !== '');
      builder.add(`for (const ${node.item} of ${node.collection}) {`).indent();
      emitElement(builder, contentNodes[0]);
      builder.dedent().add('}');
      return;
    }
    // The renderable gate rejects every other node type before generation.
    throw new SyntaxError(`Server rendering does not support ${node.type} nodes at ${node.loc?.start?.line ?? '?'}:${node.loc?.start?.column ?? '?'}.`);
  }

  function emitComponentTag(builder, node) {
    if (node.componentId == null) {
      throw new SyntaxError(`Component <${node.name}> is missing its componentId; run the analyzer before generation.`);
    }
    const idLiteral = JSON.stringify(String(node.componentId));
    builder.add('{').indent();
    builder.add(`const __wizzChild_${node.componentId} = __wizzServer_${node.name}.renderComponent(${buildComponentPropsSource(node)});`);
    builder.add(`__wizzChildStates[${idLiteral}] = __wizzChild_${node.componentId}.state;`);
    builder.add(`__wizzParts.push(__wizzChild_${node.componentId}.html);`);
    builder.dedent().add('}');
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
  if (hasComponentTags) {
    builder.add(`const state = { ${stateVars.map(declaration => declaration.name).join(', ')} };`);
    builder.add('state.__wizz = { components: __wizzChildStates };');
    builder.add('return { html, state };');
  } else if (stateVars.length > 0) {
    builder.add(`const state = { ${stateVars.map(declaration => declaration.name).join(', ')} };`);
    builder.add('return { html, state };');
  } else {
    builder.add('return { html, state: {} };');
  }
  builder.dedent().add('}');

  return builder.generate();
}

module.exports = { generateServerComponent, assertServerRenderable, VOID_ELEMENTS };

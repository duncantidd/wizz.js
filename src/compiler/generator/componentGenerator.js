const { CodeBuilder } = require('./codeBuilder');
const { generateCreateFunction } = require('./domGenerator');
const { generateUpdateFunction } = require('./updateGenerator');
const { interceptAssignments } = require('./assignmentInterceptor');

/**
 * Wraps the parsed component into a single, importable Factory Closure.
 * @param {Object} astPayload - The Final Handoff Object (must include rawScript).
 * @returns {string} The final compiled JavaScript module.
 */
function generateComponent(astPayload) {
  const builder = new CodeBuilder();
      const componentImports = astPayload.imports || [];

      componentImports.forEach(({ name, source }) => {
            builder.add(`import ${name} from ${JSON.stringify(source.replace(/\.wizz$/, '.js'))};`);
      });
      if (componentImports.length > 0) builder.add('');

  // 1. Factory Function Signature
  builder.add('export default function mountComponent(target) {')
        .indent();

      const reactiveVars = astPayload.script.filter(decl => decl.isReactive);

      builder.add('let isMounted = false;');
      builder.add('function queueUpdate(changed) {')
                        .indent()
                        .add('if (isMounted) update(ctx, changed);')
                        .dedent()
                        .add('}');

  // 2. Paste the developer's original logic so it forms the lexical environment
  builder.add('// --- Developer Logic ---');
  if (astPayload.rawScript) {
    // Split by newline and add to builder to maintain proper indentation
            const interceptedScript = interceptAssignments(
                  astPayload.rawScript,
                  reactiveVars.map(decl => decl.name)
            );
            interceptedScript.split('\n').forEach(line => builder.add(line));
  }

  // 3. Build the Context Object dynamically
  // We use getters so the create() function always reads the latest memory reference
  builder.add('\n// --- Framework Context ---');
  builder.add('const ctx = {')
        .indent();
  
  reactiveVars.forEach(decl => {
    builder.add(`get ${decl.name}() { return ${decl.name}; },`);
  });
  
  builder.dedent()
        .add('};');

  // 4. Inject the generated DOM create() function
  builder.add('\n// --- DOM Creation ---');
      const createCode = generateCreateFunction(astPayload.template, componentImports);
  createCode.split('\n').forEach(line => builder.add(line));

  // 5. Inject the generated Reactivity Engine update() function
  builder.add('\n// --- Reactivity Engine ---');
  const updateCode = generateUpdateFunction(astPayload.template);
  updateCode.split('\n').forEach(line => builder.add(line));

  // 6. Mount the component to the DOM
  builder.add('\n// --- Initialization ---')
        .add('const rootNode = create(ctx);')
        .add('const childComponents = rootNode.__wizzChildComponents;')
      .add('const listUpdates = rootNode.__wizzListUpdates;')
        .add('target.appendChild(rootNode);')
        .add('rootNode.__wizzMountChildren();');

  const initialChanges = reactiveVars.map(decl => `${decl.name}: true`).join(', ');
      builder.add(`update(ctx, { ${initialChanges} });`)
        .add('isMounted = true;');

  // 7. Return the public API (e.g., a way to unmount/destroy the component)
  builder.add('\nreturn {')
        .indent()
        .add('destroy() {')
        .indent()
      .add('childComponents.forEach((component) => component.destroy());')
        .add('target.removeChild(rootNode);')
        .dedent()
        .add('}')
        .dedent()
        .add('};');

  builder.dedent()
        .add('}');

  return builder.generate();
}

module.exports = { generateComponent };
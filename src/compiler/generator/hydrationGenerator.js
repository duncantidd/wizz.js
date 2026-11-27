// src/compiler/generator/hydrationGenerator.js
const { CodeBuilder } = require('./codeBuilder');
const { CODES, compilerDiagnostic } = require('../diagnostics.js');
const { buildComponentPropsSource, eventListenerParts, itemComponentParts, itemComponentMountLines, removeRecordSource } = require('./domGenerator');
const { analyzeBlocks, eachHasListeners, eachHasComponents, itemSliceKeySource, isEventAttribute, isReactiveIf, makerName, ifRecheckSource } = require('./blockScopes');
const { attributeWriteSource, attributeValueSource, isBooleanAttribute } = require('./attributePolicy');

/**
 * Generates the hydrateCreate() adoption walk for hydratable components.
 * The emitted function attaches to the server-rendered DOM in the same
 * pre-order the create() walk builds it, verifies each position against the
 * template AST, collects event listeners for deferred attachment, and reports
 * any mismatch once before falling back to a full client render.
 *
 * The walk relies on three invariants of the server target:
 * - adjacency markers (`<!-- -->`) separate text-like siblings and bracket
 *   block boundaries; they are stripped per element before positions are
 *   compared, leaving childNodes aligned one-to-one with the template AST;
 * - `data-wizz-id` attributes appear on the same elements the analyzer
 *   stamped, and are verified from the AST attribute, never from a counter;
 * - text content is rendered from the same expressions this walk re-evaluates
 *   against the seeded reactive bindings.
 *
 * Milestone 14 extends adoption to the full template surface: `{#if}` blocks
 * are adopted by re-evaluating the test against the seeded state (the same
 * expression the server evaluated at render time, so both targets select the
 * same branch unless the author's script is nondeterministic), `{#each}`
 * lists are adopted per item with their records map rebuilt and the list
 * anchor created (an empty text node cannot survive HTML serialization), and
 * imported component tags are adopted through the child module's hydrateRoot
 * export, which remounts inside the child's own root on mismatch so a nested
 * fallback never fails the parent.
 *
 * Reactive `{#if}` blocks (a test with reactive dependencies) are adopted
 * into the same block machinery create() builds: the delivered branch becomes
 * the block's initial scope record (see blockScopes.js), the block anchor is
 * created after the adopted run (like a list anchor, it cannot survive HTML
 * serialization), and a later change of branch calls the branch makers the
 * create generator emitted at factory scope. Listeners inside a branch or an
 * each item are still deferred until the walk passes, then attach through
 * `__wizzOn` into the owning scope's disposers.
 *
 * Milestone 15 extends adoption to the delivered head run: when the page
 * renders head markup, the walk locates the `<!--wizz:head-start-->` /
 * `<!--wizz:head-end-->` run in document.head, verifies this component's
 * slice (nodes tagged with its owner path) positionally against what
 * createHeadNodes() would build, claims it, and consumes the run by removing
 * the markers once every delivered head node was claimed by some component.
 * Unclaimed leftovers or verification failures fall back to a fresh mount,
 * which strips the stale delivery first — a nested (self-adopted) component
 * only ever strips its own slice so its failure never breaks the parent.
 * @param {Object} templateAST - The analyzed template AST.
 * @param {Array<{name: string}>} componentImports - The component's imports;
 *   rendered tags adopt the matching child hydratable module.
 * @param {Object|null} headBlock - The extracted HeadBlock node, or null.
 * @param {Object|null} styleBlock - The payload's style record, or null. It
 *   activates the run machinery for styled-only components: their delivered
 *   stylesheet carries no delivery tag (styles dedup by scope at apply time,
 *   never through slice verification), but the marker run must still be
 *   located and consumed so markers cannot strand in document.head.
 * @param {Object} [options] - Generation options; `options.filePath` is
 *   accepted for symmetry with the other generators (head locations are
 *   compared from the delivered markup, not re-derived).
 * @param {Map<Object, string>} [updateTargets] - update() target variables by
 *   AST node (`collectUpdateTargets().names`); the walk assigns each one from
 *   the node it adopts, matching create().
 * @returns {string} The hydration section source for the factory closure.
 */
function generateHydrationFunction(templateAST, componentImports = [], headBlock = null, options = {}, styleBlock = null, updateTargets = new Map()) {
  const builder = new CodeBuilder();
  let referenceCounter = 0;
  const nextReference = () => `__wizzNode_${++referenceCounter}`;
  let listCounter = 0;
  const blocks = analyzeBlocks(templateAST);
  const handlerSources = options.handlerSources ?? new WeakMap();
  // Update-target variables captured by the branch being emitted; null
  // outside reactive branches. `branchDepth` counts all enclosing {#if}
  // blocks (reactive or constant) so component adoption knows whether a tag's
  // ref can be null when its branch was not delivered.
  let branchTargets = null;
  let branchDepth = 0;

  const rootNode = templateAST.children.find(node => node.type === 'Element');
  if (!rootNode) {
    throw compilerDiagnostic(CODES.generator.missingRootElement, 'Component template must contain a root element.');
  }

  const importedNames = new Set(componentImports.map((component) => component.name));

  // Head machinery activates when this component owns head markup, owns a
  // style block (styles ride the same delivery run), or when a nested
  // component's head must be threaded through this module during adoption.
  // Must mirror componentGenerator's headActive condition.
  const headActive = headBlock != null || styleBlock != null || componentTagsExist(templateAST, importedNames);

  builder.add('// --- Hydration ---');
  builder.add('function __wizzNodeTag(node) {');
  builder.add("  return typeof node.tagName === 'string' ? node.tagName.toLowerCase() : null;");
  builder.add('}');
  builder.add('function __wizzStripComments(node) {');
  builder.add('  for (let __wizzI = node.childNodes.length - 1; __wizzI >= 0; __wizzI--) {');
  builder.add('    if (node.childNodes[__wizzI].nodeType === 8) node.removeChild(node.childNodes[__wizzI]);');
  builder.add('  }');
  builder.add('}');
  builder.add('function __wizzDescribe(node) {');
  builder.add("  if (!node) return 'nothing';");
  builder.add("  if (node.nodeType === 8) return 'a comment';");
  builder.add("  if (node.nodeType === 3) return 'text ' + JSON.stringify(node.nodeValue);");
  builder.add("  return '<' + (__wizzNodeTag(node) ?? 'unknown') + '>';");
  builder.add('}');

  // Prototype-safe lookup of a nested component's state slice. Serialized
  // state is author-influenced data, so every level is guarded with
  // hasOwnProperty before access.
  if (componentTagsExist(templateAST, importedNames)) {
    builder.add('function __wizzReadSlice(__wizzState, key) {');
    builder.add("  if (!__wizzState || typeof __wizzState !== 'object' || Array.isArray(__wizzState)) return {};");
    builder.add('  const __wizz = __wizzState.__wizz;');
    builder.add("  if (!__wizz || typeof __wizz !== 'object' || !Object.prototype.hasOwnProperty.call(__wizz, 'components')) return {};");
    builder.add('  const __wizzSlices = __wizz.components;');
    builder.add("  if (!__wizz.components || typeof __wizz.components !== 'object' || !Object.prototype.hasOwnProperty.call(__wizz.components, key)) return {};");
    builder.add('  const __wizzSlice = __wizzSlices[key];');
    builder.add("  return (__wizzSlice && typeof __wizzSlice === 'object' && !Array.isArray(__wizzSlice)) ? __wizzSlice : {};");
    builder.add('}');
  }

  builder.add(headActive
    ? 'function __wizzHydrateCreate(__wizzHost, __wizzState, __wizzAdoptSelf, __wizzOwnerPath) {'
    : 'function __wizzHydrateCreate(__wizzHost, __wizzState, __wizzAdoptSelf) {');
  if (headActive) {
    // Identity of the head slice this walk adopts: pages own the root run;
    // nested components receive their scoped owner path from the parent.
    builder.add("  const __wizzHeadOwner = __wizzOwnerPath || 'r';");
  }
  builder.add('  const __wizzProblems = [];');
  builder.add('  const __wizzPendingListeners = [];');
  builder.add('  const __wizzChildren = [];');
  builder.add('  const __wizzLists = [];');
  // Children of adopted each items: like the static tags below, they are
  // adopted only once the whole walk has passed.
  const itemAdoptions = eachComponentsExist(templateAST);
  if (itemAdoptions) builder.add('  const __wizzPendingAdoptions = [];');

  // Component-tag refs are declared at hydrateCreate scope up front: the
  // adoption block after the walk references them at function scope, but a
  // tag inside an if-branch is visited inside that branch, where an inline
  // `let` would be out of scope by then.
  const componentRefs = new Map();
  const preAllocateRefs = (node) => {
    if (node.type === 'Element') {
      if (importedNames.has(node.name)) {
        componentRefs.set(node, nextReference());
        return;
      }
      (node.children || []).forEach(preAllocateRefs);
      return;
    }
    if (node.type === 'IfBlock') {
      (node.consequent || []).forEach(preAllocateRefs);
      (node.alternate || []).forEach(preAllocateRefs);
    }
    // Component tags inside each bodies belong to their item records, which
    // hold their own per-row references; none is allocated here.
  };
  (templateAST.children || []).forEach(preAllocateRefs);
  for (const componentRef of componentRefs.values()) {
    builder.add(`  let ${componentRef} = null;`);
  }
  // Reactive if blocks get their adopted scope record and branch key at
  // function scope for the same reason: component adoption after the walk
  // registers a branch's children in its scope.
  for (const id of blocks.ifIds.values()) {
    builder.add(`  const __wizzIfScope_${id} = { lists: [], drop: [], mounts: [], nodes: [] };`);
    builder.add(`  let __wizzIfKey_${id} = 0;`);
  }

  // --- Delivered head adoption ---
  // Pages (!adoptSelf) locate the marker-delimited run the dev server
  // injected before </head>; self-adopted nested components find their slice
  // by owner path anywhere in document.head (the run markers belong to the
  // page and may already be consumed).
  if (headActive) {
    builder.add('  let __wizzHeadNodes = null;');
    builder.add('  let __wizzRun = null;');
    builder.add('  let __wizzOwn = null;');
    builder.add('  if (!__wizzAdoptSelf) {').indent();
    builder.add('    __wizzRun = __wizzFindHeadRun();');
    builder.add('    if (__wizzRun) {');
    builder.add("      __wizzOwn = __wizzRun.nodes.filter((node) => node.getAttribute && node.getAttribute('data-wizz-head-id') === __wizzHeadOwner);");
    builder.add('    }');
    builder.dedent().add('  } else {').indent();
    builder.add("    __wizzOwn = Array.prototype.slice.call(document.head.childNodes).filter((node) => node.getAttribute && node.getAttribute('data-wizz-head-id') === __wizzHeadOwner);");
    builder.dedent().add('  }');
    if (headBlock) {
      // Verify this component's slice positionally against compile-time
      // expectations derived from the head block, then claim it. The
      // expectations are data, not created nodes: hydration must not build
      // throwaway DOM just to compare it. A page with an absent run (no head
      // markers at all) leaves __wizzOwn null and falls back to a fresh
      // apply in mountInstance; a nested component whose slice is missing
      // fails verification and remounts fresh inside its own root, which
      // never breaks the parent walk.
      builder.add('  if (__wizzOwn) {').indent();
      builder.add('    const __wizzExpected = [');
      headBlock.children.forEach((child, index) => {
        const parts = [`tag: ${JSON.stringify(child.name)}`];
        if (child.name === 'title') {
          const segments = [];
          let pendingText = '';
          for (const grandChild of child.children || []) {
            if (grandChild.type === 'Text') {
              pendingText += grandChild.value;
              continue;
            }
            if (grandChild.type === 'Expression') {
              if (pendingText !== '') {
                segments.push(JSON.stringify(pendingText));
                pendingText = '';
              }
              segments.push(`String(${grandChild.value})`);
              continue;
            }
            throw compilerDiagnostic(CODES.generator.titleDisallowedChild, `<${grandChild.name}> is not allowed inside <title> at ${grandChild.loc?.start?.line ?? '?'}:${grandChild.loc?.start?.column ?? '?'}.`);
          }
          if (pendingText !== '') segments.push(JSON.stringify(pendingText));
          parts.push(`text: ${segments.length === 0 ? "''" : segments.join(' + ')}`);
        } else {
          parts.push("text: ''");
        }
        const attrs = [];
        const flags = [];
        for (const attribute of child.attributes || []) {
          if (attribute.name.startsWith('on:')) continue;
          if (attribute.dynamic && isBooleanAttribute(attribute.name)) {
            // Presence is the only representation for boolean attributes.
            flags.push(`[${JSON.stringify(attribute.name)}, ${attributeValueSource(attribute.name, attribute.value)}]`);
            continue;
          }
          // A null expected value means the attribute must be absent
          // (null/undefined dynamic values are not rendered).
          attrs.push(`[${JSON.stringify(attribute.name)}, ${attribute.dynamic
            ? attributeValueSource(attribute.name, attribute.value)
            : JSON.stringify(attribute.value === null ? '' : attribute.value)}]`);
        }
        parts.push(`attrs: [${attrs.join(', ')}]`);
        if (flags.length > 0) parts.push(`flags: [${flags.join(', ')}]`);
        builder.add(`      { ${parts.join(', ')} }${index < headBlock.children.length - 1 ? ',' : ''}`);
      });
      builder.add('    ];');
      builder.add('    if (__wizzOwn.length !== __wizzExpected.length) {');
      builder.add("      __wizzProblems.push('expected ' + __wizzExpected.length + ' head nodes, found ' + __wizzOwn.length);");
      builder.add('    } else {').indent();
      builder.add('      let __wizzHeadOk = true;');
      builder.add('      for (let __wizzI = 0; __wizzI < __wizzExpected.length; __wizzI++) {').indent();
      builder.add('        const __wizzGot = __wizzOwn[__wizzI];');
      builder.add('        const __wizzWant = __wizzExpected[__wizzI];');
      builder.add("        if (__wizzNodeTag(__wizzGot) !== __wizzExpected[__wizzI].tag) {");
      builder.add("          __wizzProblems.push('expected head node ' + __wizzI + ' to be <' + __wizzExpected[__wizzI].tag + '>, found ' + __wizzDescribe(__wizzGot));");
      builder.add('          __wizzHeadOk = false;');
      builder.add('          break;');
      builder.add('        }');
      // Title text and empty void elements compare through textContent.
      builder.add("        if ((__wizzGot.textContent || '') !== __wizzExpected[__wizzI].text) {");
      builder.add("          __wizzProblems.push('head node ' + __wizzI + ' text mismatch');");
      builder.add('          __wizzHeadOk = false;');
      builder.add('          break;');
      builder.add('        }');
      builder.add('        for (let __wizzA = 0; __wizzA < __wizzExpected[__wizzI].attrs.length; __wizzA++) {').indent();
      builder.add('          const __wizzPair = __wizzExpected[__wizzI].attrs[__wizzA];');
      builder.add("          if (__wizzGot.getAttribute(__wizzPair[0]) !== __wizzPair[1]) {");
      builder.add("            __wizzProblems.push('head node ' + __wizzI + ' attribute ' + __wizzPair[0] + ' mismatch');");
      builder.add('            __wizzHeadOk = false;');
      builder.add('            break;');
      builder.add('          }');
      builder.dedent().add('        }');
      builder.add('        if (!__wizzHeadOk) break;');
      builder.add('        for (let __wizzF = 0; __wizzF < (__wizzExpected[__wizzI].flags || []).length; __wizzF++) {').indent();
      builder.add('          const __wizzFlag = __wizzExpected[__wizzI].flags[__wizzF];');
      builder.add("          if ((__wizzGot.getAttribute(__wizzFlag[0]) !== null) !== (__wizzFlag[1] !== null)) {");
      builder.add("            __wizzProblems.push('head node ' + __wizzI + ' attribute ' + __wizzFlag[0] + ' mismatch');");
      builder.add('            __wizzHeadOk = false;');
      builder.add('            break;');
      builder.add('          }');
      builder.dedent().add('        }');
      builder.add('        if (!__wizzHeadOk) break;');
      builder.dedent().add('      }');
      builder.add('      if (__wizzHeadOk) {');
      builder.add('        __wizzClaimHead(__wizzOwn);');
      builder.add('        __wizzHeadNodes = __wizzOwn;');
      builder.add('      }');
      builder.dedent().add('    }');
      builder.dedent().add('  }');
    }
  }

  // The mount point's first element is adopted as the component root; a
  // self-adopted root (nested hydration) is the given node itself, which is
  // already in the parent's DOM at the component's position.
  builder.add('  const __wizzRoot = __wizzAdoptSelf ? __wizzHost : __wizzHost.firstElementChild;');
  builder.add('  if (!__wizzRoot) {');
  builder.add(`    __wizzProblems.push('expected root <${rootNode.name}>, found nothing');`);
  builder.add(`  } else if (__wizzNodeTag(__wizzRoot) !== '${rootNode.name.toLowerCase()}') {`);
  builder.add(`    __wizzProblems.push('expected root <${rootNode.name}>, found ' + __wizzDescribe(__wizzRoot));`);
  builder.add('  }');

  const expectedTextLiteral = (value) => JSON.stringify(JSON.stringify(value));

  function emitDataWizzIdCheck(ref, elementNode) {
    const idAttribute = (elementNode.attributes || []).find(attribute => attribute.name === 'data-wizz-id');
    if (!idAttribute) return;
    builder.add(`  if (__wizzProblems.length === 0 && ${ref}.getAttribute('data-wizz-id') !== ${JSON.stringify(idAttribute.value)}) {`);
    builder.add(`    __wizzProblems.push('expected data-wizz-id="${idAttribute.value}" on <${elementNode.name}>, found ' + JSON.stringify(${ref}.getAttribute('data-wizz-id')));`);
    builder.add('  }');
  }

  // `sc` names the scope record that owns what is being adopted (null for the
  // component scope); `top` marks a branch's own top-level nodes, which the
  // scope removes when the branch is replaced.
  const listsOf = (sc) => (sc ? `${sc}.lists` : '__wizzLists');
  const dropOf = (sc) => (sc ? `${sc}.drop` : '__wizzDrop');

  function emitListenerCollection(ref, elementNode, sc) {
    for (const attribute of elementNode.attributes || []) {
      if (!isEventAttribute(attribute)) continue;
      builder.add('  if (__wizzProblems.length === 0) {');
      // A fourth entry routes the listener into its scope's disposers.
      builder.add(`    __wizzPendingListeners.push([${ref}, ${JSON.stringify(attribute.name.slice(3))}, ${handlerSources.get(attribute) ?? attribute.value}${sc ? `, ${sc}.drop` : ''}]);`);
      builder.add('  }');
    }
  }

  function emitTextChild(child, parentRef, cursorRef, sc, top) {
    const ref = nextReference();
    builder.add('  if (__wizzProblems.length === 0) {');
    builder.add(`    const ${ref} = ${parentRef}.childNodes[${cursorRef}];`);
    builder.add(`    if (!${ref} || ${ref}.nodeType !== 3 || ${ref}.nodeValue !== ${JSON.stringify(child.value)}) {`);
    builder.add(`      __wizzProblems.push('expected text ' + ${expectedTextLiteral(child.value)} + ' at index ' + ${cursorRef} + ' of <' + __wizzNodeTag(${parentRef}) + '>, found ' + __wizzDescribe(${ref}));`);
    builder.add('    }');
    if (top) builder.add(`    ${sc}.nodes.push(${ref});`);
    builder.add(`    ${cursorRef} += 1;`);
    builder.add('  }');
  }

  // Hands a verified node to update(). A failed walk abandons this closure for a
  // fresh mount, so a target captured before the failure is never read.
  function emitTargetCapture(ref, templateNode) {
    if (!updateTargets.has(templateNode)) return;
    builder.add(`    ${updateTargets.get(templateNode)} = ${ref};`);
    if (branchTargets) branchTargets.push(updateTargets.get(templateNode));
  }

  function emitExpressionChild(child, parentRef, cursorRef, sc, top) {
    const ref = nextReference();
    builder.add('  if (__wizzProblems.length === 0) {');
    builder.add(`    const ${ref} = ${parentRef}.childNodes[${cursorRef}];`);
    // The delivered markup escaped this expression's output; the browser's
    // parser has decoded it again, so compare against the raw runtime value.
    builder.add(`    if (!${ref} || ${ref}.nodeType !== 3 || ${ref}.nodeValue !== String(${child.value})) {`);
    builder.add(`      __wizzProblems.push('expected expression text at index ' + ${cursorRef} + ' of <' + __wizzNodeTag(${parentRef}) + '>, found ' + __wizzDescribe(${ref}));`);
    builder.add('    }');
    emitTargetCapture(ref, child);
    if (top) builder.add(`    ${sc}.nodes.push(${ref});`);
    builder.add(`    ${cursorRef} += 1;`);
    builder.add('  }');
  }

  function emitElementChild(elementNode, parentRef, cursorRef, sc, top) {
    const ref = nextReference();
    builder.add(`  let ${ref} = null;`);
    builder.add('  if (__wizzProblems.length === 0) {');
    builder.add(`    ${ref} = ${parentRef}.childNodes[${cursorRef}];`);
    builder.add(`    if (__wizzNodeTag(${ref}) !== '${elementNode.name.toLowerCase()}') {`);
    builder.add(`      __wizzProblems.push('expected <${elementNode.name}> at index ' + ${cursorRef} + ' of <' + __wizzNodeTag(${parentRef}) + '>, found ' + __wizzDescribe(${ref}));`);
    builder.add('    }');
    emitTargetCapture(ref, elementNode);
    if (top) builder.add(`    ${sc}.nodes.push(${ref});`);
    builder.add(`    ${cursorRef} += 1;`);
    builder.add('  }');
    emitDataWizzIdCheck(ref, elementNode);
    emitListenerCollection(ref, elementNode, sc);
    walkChildren(elementNode, ref, sc);
  }

  // A component tag creates no element of its own: its rendered root occupies
  // exactly one child position. Only the presence of an element is verified
  // here — tag verification is the child's own first check, and structural
  // problems inside the child remount inside the child's root without
  // failing this parent. Adoption itself runs after the whole walk passes.
  function emitComponentChild(componentNode, parentRef, cursorRef) {
    if (componentNode.componentId == null) {
      throw compilerDiagnostic(CODES.generator.missingComponentId, `Component <${componentNode.name}> is missing its componentId; run the analyzer before generation.`);
    }
    // The ref was pre-allocated at function scope (see componentRefs above);
    // here it is only assigned at the tag's child position.
    const ref = componentRefs.get(componentNode);
    builder.add('  if (__wizzProblems.length === 0) {');
    builder.add(`    ${ref} = ${parentRef}.childNodes[${cursorRef}];`);
    builder.add(`    if (!${ref} || ${ref}.nodeType !== 1) {`);
    builder.add(`      __wizzProblems.push('expected <${componentNode.name}> at index ' + ${cursorRef} + ' of <' + __wizzNodeTag(${parentRef}) + '>, found ' + __wizzDescribe(${ref}));`);
    builder.add('    }');
    builder.add(`    ${cursorRef} += 1;`);
    builder.add('  }');
    return ref;
  }

  function emitIfBlock(node, parentRef, cursorRef, emitFlattenedChild, sc, top) {
    // The server selected its branch by evaluating this same test against the
    // render-time state; re-evaluating it against the seeded state selects
    // the same branch, so the flattened positions align. (A nondeterministic
    // author script can diverge here; the walk then falls back cleanly.)
    if (!isReactiveIf(node)) {
      // No reactive dependency: the branch never changes, so its content is
      // adopted straight into the enclosing scope.
      branchDepth += 1;
      builder.add('  if (__wizzProblems.length === 0) {').indent();
      builder.add(`    if (${node.test}) {`).indent();
      (node.consequent || []).forEach(child => emitFlattenedChild(child, sc, top));
      builder.dedent();
      if (node.alternate) {
        builder.add('    } else {').indent();
        (node.alternate || []).forEach(child => emitFlattenedChild(child, sc, top));
        builder.dedent();
      }
      builder.add('    }');
      builder.dedent().add('  }');
      branchDepth -= 1;
      return;
    }

    const id = blocks.ifIds.get(node);
    const scopeName = `__wizzIfScope_${id}`;
    const keyName = `__wizzIfKey_${id}`;
    // The delivered branch is adopted into the block's scope record, which
    // the block then owns exactly as if a maker had built it.
    const emitBranch = (children) => {
      const outerTargets = branchTargets;
      branchTargets = [];
      branchDepth += 1;
      children.forEach(child => emitFlattenedChild(child, scopeName, true));
      branchDepth -= 1;
      if (branchTargets.length > 0) {
        builder.add(`    if (__wizzProblems.length === 0) ${scopeName}.drop.push(() => { ${branchTargets.join(' = ')} = null; });`);
      }
      branchTargets = outerTargets;
    };
    builder.add('  if (__wizzProblems.length === 0) {').indent();
    builder.add(`    if (${node.test}) {`).indent();
    builder.add(`    ${keyName} = 1;`);
    emitBranch(node.consequent || []);
    builder.dedent();
    if (node.alternate) {
      builder.add('    } else {').indent();
      emitBranch(node.alternate);
      builder.dedent();
    }
    builder.add('    }');
    builder.dedent().add('  }');

    // The anchor occupies a real child position after the adopted run, so the
    // cursor moves past it (the same accounting as a list anchor).
    const anchorName = `__wizzIfAnchor_${id}`;
    const blockName = `__wizzIf_${id}`;
    const makers = `[${node.alternate ? makerName(id, 0) : 'null'}, ${makerName(id, 1)}]`;
    builder.add('  if (__wizzProblems.length === 0) {');
    builder.add(`    const ${anchorName} = document.createTextNode('');`);
    builder.add(`    ${parentRef}.insertBefore(${anchorName}, ${parentRef}.childNodes[${cursorRef}] || null);`);
    builder.add(`    ${cursorRef} += 1;`);
    if (top) builder.add(`    ${sc}.nodes.push(${anchorName});`);
    builder.add(`    const ${blockName} = __wizzIfBlock(${parentRef}, ${anchorName}, () => (${node.test}), ${makers}, ${keyName}, ${scopeName});`);
    builder.add(`    ${listsOf(sc)}.push((__wizzChanged) => ${blockName}.sync(__wizzChanged, ${ifRecheckSource(node)}));`);
    builder.add(`    ${dropOf(sc)}.push(${blockName}.drop);`);
    builder.add('  }');
  }

  function emitEachBlock(node, parentRef, cursorRef, sc, top) {
    const listId = ++listCounter;
    emitListMachinery(listId, node, sc, top);
    builder.add('  if (__wizzProblems.length === 0) {');
    builder.add(`    ${cursorRef} += __wizzHydrateList_${listId}(${parentRef}, ${cursorRef});`);
    builder.add('  }');
  }

  /**
   * Emits the per-list adoption machinery for one EachBlock, mirroring the
   * browser target's list implementation: item roots are verified and adopted
   * positionally, the records map is rebuilt with key-aware update closures,
   * and the list anchor (an empty text node that cannot survive HTML
   * serialization) is created after the adopted run. Fresh items created by
   * later client updates reuse the same record shape the browser target
   * builds, so updateList semantics match exactly.
   *
   * Items with `on:` directives carry a per-record `drop` array, as in the
   * browser target. An adopted item's listeners wait in the pending queue
   * until the whole walk passes; a fresh item attaches them immediately.
   */
  function emitListMachinery(listId, node, sc, top) {
    const itemVar = node.item;
    const recordsRef = `__wizzRecords_${listId}`;
    const anchorRef = `__wizzAnchor_${listId}`;
    const contentNodes = node.children.filter((child) => child.type !== 'Text' || child.value.trim() !== '');
    const itemRoot = contentNodes[0];
    const keylessIndex = `__wizzIndex_${listId}`;
    const hasListeners = eachHasListeners(node);
    // Items with child components own them through the record's `drop`
    // array, exactly as listeners are owned (see blockScopes.js).
    const hasComponents = eachHasComponents(node);
    const ownsScope = hasListeners || hasComponents;
    const isComponent = (listNode) => listNode.type === 'Element' && importedNames.has(listNode.name);
    // Handlers and child mounts close over the item parameter, so update()
    // rebinds it.
    const updateHead = ownsScope ? 'update(__wizzItem) {' : `update(${itemVar}) {`;
    const dropRecordSource = 'for (const __wizzDropItem of __wizzRecord.drop) __wizzDropItem();';

    const itemVars = new Map();
    // Component tags of the item in template order, with their emitted parts.
    const itemComponents = new Map();

    builder.add(`  const ${recordsRef} = new Map();`);
    builder.add(`  let ${anchorRef} = null;`);

    // Per-item verification: the item variable is in scope, so expression
    // text is re-evaluated per item exactly as the server rendered it.
    // Author expressions run in this scope, so its parameters and the list
    // functions' locals below carry the reserved `__wizz` prefix. The
    // ordinal (the item's position) keys its children's state slices the way
    // the server keyed them.
    builder.add(`  function __wizzHydrateListItem_${listId}(${itemVar}, __wizzParent, __wizzIndex${hasComponents ? ', __wizzOrdinal' : ''}) {`).indent();
    const rootVar = `__wizzNode_${listId}_root`;
    builder.add(`    const ${rootVar} = __wizzParent.childNodes[__wizzIndex];`);
    // A component's rendered root occupies the item's position; its tag is
    // the child's own first check, as for a component tag anywhere else.
    builder.add(isComponent(itemRoot)
      ? `    if (!${rootVar} || ${rootVar}.nodeType !== 1) {`
      : `    if (!${rootVar} || ${rootVar}.nodeType !== 1 || __wizzNodeTag(${rootVar}) !== '${itemRoot.name.toLowerCase()}') {`).indent();
    builder.add(`      __wizzProblems.push('expected <${itemRoot.name}> at index ' + __wizzIndex + ' of <' + __wizzNodeTag(__wizzParent) + '>, found ' + __wizzDescribe(${rootVar}));`);
    builder.add('      return null;');
    builder.dedent().add('    }');
    itemVars.set(itemRoot, rootVar);
    if (isComponent(itemRoot)) itemComponents.set(itemRoot, itemComponentParts(itemRoot));

    const walkItemNode = (listNode, parentVar) => {
      builder.add(`    __wizzStripComments(${parentVar});`);
      (listNode.children || []).forEach((child, childIndex) => {
        const childVar = `__wizzNode_${listId}_${childIndex}_${itemVars.size}`;
        if (isComponent(child)) {
          builder.add(`    const ${childVar} = ${parentVar}.childNodes[${childIndex}];`);
          builder.add(`    if (!${childVar} || ${childVar}.nodeType !== 1) {`).indent();
          builder.add(`      __wizzProblems.push('expected <${child.name}> at index ${childIndex} of <' + __wizzNodeTag(${parentVar}) + '>, found ' + __wizzDescribe(${childVar}));`);
          builder.add('      return null;');
          builder.dedent().add('    }');
          itemVars.set(child, childVar);
          itemComponents.set(child, itemComponentParts(child));
          return;
        }
        if (child.type === 'Element') {
          builder.add(`    const ${childVar} = ${parentVar}.childNodes[${childIndex}];`);
          builder.add(`    if (!${childVar} || ${childVar}.nodeType !== 1 || __wizzNodeTag(${childVar}) !== '${child.name.toLowerCase()}') {`).indent();
          builder.add(`      __wizzProblems.push('expected <${child.name}> at index ${childIndex} of <' + __wizzNodeTag(${parentVar}) + '>, found ' + __wizzDescribe(${childVar}));`);
          builder.add('      return null;');
          builder.dedent().add('    }');
          itemVars.set(child, childVar);
          walkItemNode(child, childVar);
          return;
        }
        if (child.type === 'Text') {
          builder.add(`    if (!${parentVar}.childNodes[${childIndex}] || ${parentVar}.childNodes[${childIndex}].nodeType !== 3 || ${parentVar}.childNodes[${childIndex}].nodeValue !== ${JSON.stringify(child.value)}) {`).indent();
          builder.add(`      __wizzProblems.push('expected text at index ${childIndex} of <' + __wizzNodeTag(${parentVar}) + '>, found ' + __wizzDescribe(${parentVar}.childNodes[${childIndex}]));`);
          builder.add('      return null;');
          builder.dedent().add('    }');
          return;
        }
        if (child.type === 'Expression') {
          builder.add(`    if (!${parentVar}.childNodes[${childIndex}] || ${parentVar}.childNodes[${childIndex}].nodeType !== 3 || ${parentVar}.childNodes[${childIndex}].nodeValue !== String(${child.value})) {`).indent();
          builder.add(`      __wizzProblems.push('expected expression text at index ${childIndex} of <' + __wizzNodeTag(${parentVar}) + '>, found ' + __wizzDescribe(${parentVar}.childNodes[${childIndex}]));`);
          builder.add('      return null;');
          builder.dedent().add('    }');
          return;
        }
        // The renderable gate rejects every other node type inside each
        // bodies before a hydratable module is generated.
        throw compilerDiagnostic(CODES.generator.hydrationEachUnsupportedNode, `Hydration does not support ${child.type} nodes inside each blocks.`);
      });
    };
    if (!isComponent(itemRoot)) walkItemNode(itemRoot, rootVar);

    if (ownsScope) builder.add('    const __wizzDrop = [];');
    if (hasListeners) {
      // Queued only once the whole item verified, so a failed item never
      // leaves a listener behind.
      for (const [listNode, listVar] of itemVars) {
        for (const attribute of listNode.attributes || []) {
          if (!isEventAttribute(attribute)) continue;
          const { eventName, handler } = eventListenerParts(attribute, handlerSources);
          builder.add(`    __wizzPendingListeners.push([${listVar}, ${JSON.stringify(eventName)}, ${handler}, __wizzDrop]);`);
        }
      }
    }
    // The item's children are adopted through their hydratable modules once
    // the whole walk passes, each with the slice and head owner the server
    // gave this row; a mismatch inside one remounts inside its own root.
    for (const [componentNode, parts] of itemComponents) {
      const keySource = itemSliceKeySource(componentNode, '__wizzOrdinal');
      builder.add(`    let ${parts.childVar} = null;`);
      builder.add('    __wizzPendingAdoptions.push(() => {').indent();
      builder.add(`      ${parts.childVar} = __wizzHydrate_${componentNode.name}.hydrateRoot(${itemVars.get(componentNode)}, ${parts.propsSource}, __wizzReadSlice(__wizzState, ${keySource}), __wizzHeadOwner + "/" + ${keySource});`);
      builder.add(`      __wizzDrop.push(() => ${parts.childVar}.destroy());`);
      builder.dedent().add('    });');
    }

    builder.add('    return {').indent();
    builder.add(`      node: ${rootVar},`);
    if (ownsScope) builder.add('      drop: __wizzDrop,');
    builder.add(`      ${updateHead}`).indent();
    if (ownsScope) builder.add(`        ${itemVar} = __wizzItem;`);
    emitItemUpdates(itemRoot);
    builder.dedent().add('      }');
    builder.dedent().add('    };');
    builder.dedent().add('  }');

    // Positional writes into an adopted (or freshly created) item root,
    // matching the browser target's emitListUpdates exactly.
    function emitItemUpdates(listNode) {
      if (itemComponents.has(listNode)) {
        const { setPropsSource } = itemComponents.get(listNode);
        if (setPropsSource) builder.add(`        ${setPropsSource}`);
        return;
      }
      const varName = itemVars.get(listNode);
      if (listNode.type !== 'Element' || !varName) return;
      for (const attribute of listNode.attributes || []) {
        if (!attribute.dynamic) continue;
        builder.add(`        ${attributeWriteSource(varName, attribute.name, attribute.value, { bind: attribute.bind })}`);
      }
      (listNode.children || []).forEach((child, childIndex) => {
        if (child.type === 'Expression') builder.add(`        ${varName}.childNodes[${childIndex}].nodeValue = String(${child.value});`);
        emitItemUpdates(child);
      });
    }

    // Fresh item creation for items the client adds after hydration; the
    // emission mirrors the browser target's createItem.
    const freshVars = new Map();
    builder.add(`  function __wizzCreateFreshItem_${listId}(${itemVar}${hasComponents ? ', __wizzMounts' : ''}) {`).indent();
    if (ownsScope) builder.add('    const __wizzDrop = [];');
    const buildFreshNode = (listNode, listParentName) => {
      const varName = `__wizzFresh_${listId}_${freshVars.size}`;
      freshVars.set(listNode, varName);
      if (isComponent(listNode)) {
        const parts = itemComponents.get(listNode);
        builder.add(`    const ${varName} = document.createTextNode("");`);
        builder.add(`    let ${parts.childVar} = null;`);
        if (listParentName) builder.add(`    ${listParentName}.appendChild(${varName});`);
        itemComponentMountLines(listNode, varName, parts, listNode === itemRoot).forEach((line) => builder.add(`    ${line}`));
        return varName;
      }
      if (listNode.type === 'Element') {
        builder.add(`    const ${varName} = document.createElement(${JSON.stringify(listNode.name)});`);
        for (const attribute of listNode.attributes || []) {
          if (attribute.dynamic) {
            builder.add(`    ${attributeWriteSource(varName, attribute.name, attribute.value, { bind: attribute.bind })}`);
          } else if (isEventAttribute(attribute)) {
            const { eventName, handler } = eventListenerParts(attribute, handlerSources);
            builder.add(`    __wizzDrop.push(__wizzOn(${varName}, ${JSON.stringify(eventName)}, ${handler}));`);
          } else {
            builder.add(attribute.value === null
              ? `    ${varName}.setAttribute(${JSON.stringify(attribute.name)}, "");`
              : `    ${varName}.setAttribute(${JSON.stringify(attribute.name)}, ${JSON.stringify(attribute.value)});`);
          }
        }
      } else if (listNode.type === 'Text') {
        builder.add(`    const ${varName} = document.createTextNode(${JSON.stringify(listNode.value)});`);
      } else {
        builder.add(`    const ${varName} = document.createTextNode(String(${listNode.value}));`);
      }
      if (listParentName) builder.add(`    ${listParentName}.appendChild(${varName});`);
      (listNode.children || []).forEach((child) => buildFreshNode(child, varName));
      return varName;
    };
    const freshRoot = buildFreshNode(itemRoot, null);
    builder.add(hasComponents ? '    const __wizzRecord = {' : '    return {').indent();
    builder.add(`      node: ${freshRoot},`);
    if (ownsScope) builder.add('      drop: __wizzDrop,');
    builder.add(`      ${updateHead}`).indent();
    if (ownsScope) builder.add(`        ${itemVar} = __wizzItem;`);
    const emitFreshUpdates = (listNode) => {
      const varName = freshVars.get(listNode);
      if (itemComponents.has(listNode)) {
        const { setPropsSource } = itemComponents.get(listNode);
        if (setPropsSource) builder.add(`        ${setPropsSource}`);
        return;
      }
      if (listNode.type === 'Element') {
        for (const attribute of listNode.attributes || []) {
          if (!attribute.dynamic) continue;
          builder.add(`        ${attributeWriteSource(varName, attribute.name, attribute.value, { bind: attribute.bind })}`);
        }
        (listNode.children || []).forEach((child, childIndex) => {
          if (child.type === 'Expression') builder.add(`        ${varName}.childNodes[${childIndex}].nodeValue = String(${child.value});`);
          emitFreshUpdates(child);
        });
      }
    };
    emitFreshUpdates(itemRoot);
    builder.dedent().add('      }');
    builder.dedent().add('    };');
    if (hasComponents) builder.add('    return __wizzRecord;');
    builder.dedent().add('  }');

    builder.add(`  function __wizzHydrateUpdateList_${listId}() {`).indent();
    builder.add(`    const __wizzItems = ${node.collection};`);
    // Runs only after hydration, with the list attached: fresh children
    // mount as soon as this pass has placed its records.
    if (hasComponents) builder.add('    const __wizzPendingMounts = [];');
    builder.add('    const __wizzNext = new Map();');
    builder.add('    const __wizzSeen = new Set();');
    builder.add(`    __wizzItems.forEach((${itemVar}${node.key ? '' : `, ${keylessIndex}`}) => {`).indent();
    builder.add(node.key ? `      const __wizzKey = ${itemVar}.${node.key};` : `      const __wizzKey = ${keylessIndex};`);
    builder.add('      if (__wizzSeen.has(__wizzKey)) throw new Error("Each block keys must be unique.");');
    builder.add('      __wizzSeen.add(__wizzKey);');
    builder.add(`      let __wizzRecord = ${recordsRef}.get(__wizzKey);`);
    builder.add(`      if (__wizzRecord) __wizzRecord.update(${itemVar});`);
    builder.add(`      else __wizzRecord = __wizzCreateFreshItem_${listId}(${itemVar}${hasComponents ? ', __wizzPendingMounts' : ''});`);
    builder.add(`      ${anchorRef}.parentNode.insertBefore(__wizzRecord.node, ${anchorRef});`);
    builder.add('      __wizzNext.set(__wizzKey, __wizzRecord);');
    builder.dedent().add('    });');
    const removeRecord = removeRecordSource(`${anchorRef}.parentNode`, ownsScope, hasComponents);
    builder.add(`    ${recordsRef}.forEach((__wizzRecord, __wizzKey) => { if (!__wizzNext.has(__wizzKey)) ${ownsScope ? `{ ${removeRecord} }` : removeRecord} });`);
    builder.add(`    ${recordsRef}.clear();`);
    builder.add(`    __wizzNext.forEach((__wizzRecord, __wizzKey) => ${recordsRef}.set(__wizzKey, __wizzRecord));`);
    if (hasComponents) builder.add('    for (const __wizzMount of __wizzPendingMounts) __wizzMount();');
    builder.dedent().add('  }');

    builder.add(`  function __wizzHydrateList_${listId}(__wizzParent, __wizzStart) {`).indent();
    builder.add(`    const __wizzItems = ${node.collection};`);
    builder.add('    let __wizzIndex = __wizzStart;');
    builder.add(`    __wizzItems.forEach((${itemVar}${node.key ? '' : `, ${keylessIndex}`}) => {`).indent();
    builder.add('      if (__wizzProblems.length > 0) return;');
    builder.add(node.key ? `      const __wizzKey = ${itemVar}.${node.key};` : `      const __wizzKey = ${keylessIndex};`);
    builder.add(`      if (${recordsRef}.has(__wizzKey)) __wizzProblems.push('Each block keys must be unique.');`);
    builder.add(`      const __wizzRecord = __wizzHydrateListItem_${listId}(${itemVar}, __wizzParent, __wizzIndex${hasComponents ? ', __wizzIndex - __wizzStart' : ''});`);
    builder.add('      if (__wizzRecord) {');
    builder.add(`        ${recordsRef}.set(__wizzKey, __wizzRecord);`);
    builder.add('        __wizzIndex += 1;');
    builder.add('      }');
    builder.dedent().add('    });');
    // The anchor must exist for future positional updates but cannot survive
    // HTML serialization, so hydration creates it after the adopted run.
    builder.add(`    ${anchorRef} = document.createTextNode('');`);
    builder.add(`    __wizzParent.insertBefore(${anchorRef}, __wizzParent.childNodes[__wizzIndex] || null);`);
    builder.add(`    ${listsOf(sc)}.push((__wizzChanged) => { if (__wizzChanged.${node.collection}) __wizzHydrateUpdateList_${listId}(); });`);
    if (top) builder.add(`    ${sc}.nodes.push(${anchorRef});`);
    if (ownsScope || top) {
      // The owning scope releases the live records: their listeners and
      // children always, their nodes when the list sits directly in a
      // replaced branch.
      builder.add(`    ${dropOf(sc)}.push((__wizzDetach) => {`).indent();
      builder.add(`      ${recordsRef}.forEach((__wizzRecord) => {`).indent();
      if (ownsScope) builder.add(`        ${dropRecordSource}`);
      if (top) {
        builder.add(hasComponents
          ? '        if (__wizzDetach && __wizzRecord.node.parentNode === __wizzParent) __wizzParent.removeChild(__wizzRecord.node);'
          : '        if (__wizzDetach) __wizzParent.removeChild(__wizzRecord.node);');
      }
      builder.dedent().add('      });');
      builder.add(`      ${recordsRef}.clear();`);
      builder.dedent().add('    });');
    }
    // The created anchor occupies a real child position of the parent (and
    // shifts any following siblings), so the consumed count includes it.
    builder.add('    return __wizzIndex - __wizzStart + 1;');
    builder.dedent().add('  }');
  }

  function walkChildren(elementNode, parentRef, sc = null) {
    const children = elementNode.children || [];
    // Hydration markers are stripped before anything else so the remaining
    // childNodes align one-to-one with the flattened template children.
    builder.add('  if (__wizzProblems.length === 0) {');
    builder.add(`    __wizzStripComments(${parentRef});`);
    builder.add('  }');
    const cursorRef = nextReference();
    builder.add(`  let ${cursorRef} = 0;`);

    const emitFlattenedChild = (child, childScope, top) => {
      if (child.type === 'Text') {
        emitTextChild(child, parentRef, cursorRef, childScope, top);
        return;
      }
      if (child.type === 'Expression') {
        emitExpressionChild(child, parentRef, cursorRef, childScope, top);
        return;
      }
      if (child.type === 'Element') {
        if (importedNames.has(child.name)) {
          const ref = emitComponentChild(child, parentRef, cursorRef);
          // A self-adopted child leaves its root in place on destroy (the
          // root belongs to this tree), so a branch tracks the root of a tag
          // at its top level and removes it with the branch's other nodes.
          if (top) builder.add(`  if (__wizzProblems.length === 0) ${childScope}.nodes.push(${ref});`);
          componentAdoptions.push({ node: child, ref, sc: childScope, conditional: branchDepth > 0 });
          return;
        }
        emitElementChild(child, parentRef, cursorRef, childScope, top);
        return;
      }
      if (child.type === 'IfBlock') {
        emitIfBlock(child, parentRef, cursorRef, emitFlattenedChild, childScope, top);
        return;
      }
      if (child.type === 'EachBlock') {
        emitEachBlock(child, parentRef, cursorRef, childScope, top);
        return;
      }
      throw compilerDiagnostic(CODES.generator.hydrationUnsupportedNode, `Hydration does not support ${child.type} nodes.`);
    };

    children.forEach((child) => emitFlattenedChild(child, sc, false));

    // Every template position was consumed: the flattened child count must
    // match exactly, including the empty run an untaken branch leaves behind.
    builder.add('  if (__wizzProblems.length === 0) {');
    builder.add(`    if (${cursorRef} !== ${parentRef}.childNodes.length) {`);
    builder.add(`      __wizzProblems.push('expected ' + ${cursorRef} + ' child nodes in <' + __wizzNodeTag(${parentRef}) + '>, found ' + ${parentRef}.childNodes.length);`);
    builder.add('    }');
    builder.add('  }');
  }

  const componentAdoptions = [];
  emitTargetCapture('__wizzRoot', rootNode);
  emitDataWizzIdCheck('__wizzRoot', rootNode);
  emitListenerCollection('__wizzRoot', rootNode);
  walkChildren(rootNode, '__wizzRoot');

  // Component adoption runs only after the whole walk passes: a mismatching
  // parent falls back to a full client render, which mounts its own children.
  for (const adoption of componentAdoptions) {
    const componentNode = adoption.node;
    const idLiteral = JSON.stringify(String(componentNode.componentId));
    const headOwnerArg = headActive ? `, __wizzHeadOwner + ${JSON.stringify(`/${componentNode.componentId}`)}` : '';
    const childName = `__wizzChild_${componentNode.componentId}`;
    const hasReactiveProps = (componentNode.attributes || []).some((attribute) => attribute.dynamic && attribute.dependencies?.length > 0);
    // A tag in any conditional branch has a ref only when its branch was the
    // one delivered; an untaken branch leaves ref null (and a reactive branch
    // mounts its children later when the branch is created).
    builder.add(adoption.conditional
      ? `  if (__wizzProblems.length === 0 && ${adoption.ref}) {`
      : '  if (__wizzProblems.length === 0) {').indent();
    builder.add(`    const __wizzSlice_${componentNode.componentId} = __wizzReadSlice(__wizzState, ${idLiteral});`);
    builder.add(`    const ${childName} = __wizzHydrate_${componentNode.name}.hydrateRoot(${adoption.ref}, ${buildComponentPropsSource(componentNode)}, __wizzSlice_${componentNode.componentId}${headOwnerArg});`);
    if (adoption.sc) {
      // Owned by the branch scope rather than the component-wide list, so
      // replacing the branch destroys the child.
      builder.add(hasReactiveProps
        ? `    ${adoption.sc}.drop.push(() => { ${childName}.destroy(); __wizzComponent_${componentNode.componentId} = null; });`
        : `    ${adoption.sc}.drop.push(() => ${childName}.destroy());`);
    } else {
      builder.add(`    __wizzChildren.push(${childName});`);
    }
    if (hasReactiveProps) {
      builder.add(`    __wizzComponent_${componentNode.componentId} = ${childName};`);
    }
    builder.dedent().add('  }');
  }
  if (itemAdoptions) {
    builder.add('  if (__wizzProblems.length === 0) for (const __wizzAdopt of __wizzPendingAdoptions) __wizzAdopt();');
  }

  // Consume the run only after every claim succeeded: any node still tagged
  // with a delivery owner was not adopted by any component, so the delivery
  // does not match the client tree. Claimed titles have been moved to the
  // front of document.head by __wizzClaimHead; they carry no delivery tag
  // anymore, so leftovers are position-independent. Delivered styles carry no
  // delivery tag by design (they are adopted by scope at apply time), so the
  // check treats an absent attribute as claimed — the loose `!= null` covers
  // both the DOM's null and the test shims' undefined.
  if (headActive) {
    builder.add('  if (__wizzProblems.length === 0 && __wizzRun) {').indent();
    builder.add("    const __wizzLeftover = __wizzRun.nodes.filter((node) => node.getAttribute && node.getAttribute('data-wizz-head-id') != null);");
    builder.add('    if (__wizzLeftover.length > 0) {');
    builder.add("      __wizzProblems.push(__wizzLeftover.length + ' delivered head nodes were never claimed');");
    builder.add('    } else {');
    builder.add('      __wizzRun.startMarker.parentNode.removeChild(__wizzRun.startMarker);');
    builder.add('      __wizzRun.endMarker.parentNode.removeChild(__wizzRun.endMarker);');
    builder.add('    }');
    builder.dedent().add('  }');
  }

  builder.add('  if (__wizzProblems.length > 0) {').indent();
  builder.add("    console.warn('[wizz] hydration mismatch: ' + __wizzProblems.join('; ') + '. Falling back to client rendering.');");
  if (headActive) {
    // A failed adoption must leave no head fragments behind: the fresh mount
    // re-applies this component's head, so adopted slices are released and
    // unclaimed delivery remains are stripped — the whole run for a page,
    // only the component's own slice for a nested remount.
    builder.add('    if (__wizzHeadNodes) __wizzReleaseHead(__wizzHeadNodes);');
    builder.add('    if (!__wizzAdoptSelf) {');
    builder.add('      if (__wizzRun) __wizzStripHeadRun();');
    builder.add('    } else {');
    builder.add('      __wizzStripOwnedHeadSlice(__wizzHeadOwner);');
    builder.add('    }');
  }
  builder.add('    while (__wizzHost.childNodes.length > 0) __wizzHost.removeChild(__wizzHost.childNodes[0]);');
  builder.add('    return null;');
  builder.dedent().add('  }');
  builder.add(blocks.scopedListeners
    ? '  __wizzPendingListeners.forEach((pending) => { if (pending[3]) pending[3].push(__wizzOn(pending[0], pending[1], pending[2])); else __wizzListen(pending[0], pending[1], pending[2]); });'
    : '  __wizzPendingListeners.forEach((pending) => __wizzListen(pending[0], pending[1], pending[2]));');
  builder.add(headActive
    ? '  return { node: __wizzRoot, __wizzChildren, __wizzLists, __wizzOwnHead: __wizzHeadNodes };'
    : '  return { node: __wizzRoot, __wizzChildren, __wizzLists };');
  builder.dedent().add('}');

  return builder.generate();
}

/**
 * Reports whether the template renders any imported component tag, including
 * inside each bodies. IfBlock.children aliases its consequent, so walking
 * consequent plus alternate covers every branch exactly once. Must agree with
 * componentGenerator's renderedImportNames, which gates the same head
 * machinery and the child hydration imports.
 */
function componentTagsExist(templateAST, importedNames) {
  const scan = (node) => {
    if (node.type === 'Element') {
      if (importedNames.has(node.name)) return true;
      return (node.children || []).some(scan);
    }
    if (node.type === 'IfBlock') {
      return (node.consequent || []).some(scan) || (node.alternate || []).some(scan);
    }
    if (node.type === 'EachBlock') return (node.children || []).some(scan);
    return false;
  };
  return (templateAST.children || []).some(scan);
}

/** Reports whether any each block in the template renders a component tag. */
function eachComponentsExist(templateAST) {
  const scan = (node) => {
    if (node.type === 'EachBlock') return eachHasComponents(node);
    if (node.type === 'IfBlock') {
      return (node.consequent || []).some(scan) || (node.alternate || []).some(scan);
    }
    return (node.children || []).some(scan);
  };
  return (templateAST.children || []).some(scan);
}

module.exports = { generateHydrationFunction };

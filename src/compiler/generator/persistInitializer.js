/**
 * Rewrites persistent state initializers out of a raw component script.
 *
 * stateScanner records, for every `persist(key, default)` declaration, the
 * exact span of the raw initializer inside the script it scanned. Because
 * that script is the same string the generators paste, splicing by offset
 * cannot be fooled by look-alike `persist(...)` text in comments or strings
 * elsewhere. The replacement is caller-chosen: the client target reads the
 * persisted value through the runtime helper, the server target renders the
 * plain default (the server has no storage).
 *
 * @param {string} rawScript - The component script with imports and props removed.
 * @param {Array<Object>} declarations - The scanned declarations (persistent
 *   ones carry initialValueStart/initialValueEnd).
 * @param {(declaration: Object) => string} buildReplacement - Produces the
 *   replacement expression for a persistent declaration.
 * @returns {string} The script with every persistent initializer replaced.
 * @throws {SyntaxError} When a recorded span no longer points at a persist
 *   marker — the offsets are a compiler invariant, so drift is a bug, not
 *   silently mangled output.
 */
function rewritePersistInitializers(rawScript, declarations, buildReplacement) {
  if (!rawScript || typeof rawScript !== 'string') return rawScript;

  const rewrites = (declarations || [])
    .filter((declaration) => declaration.isPersistent)
    .map((declaration) => ({
      start: declaration.initialValueStart,
      end: declaration.initialValueEnd,
      replacement: buildReplacement(declaration)
    }));
  if (rewrites.length === 0) return rawScript;

  // Splice from the back so earlier offsets stay valid while later ones
  // are rewritten.
  rewrites.sort((left, right) => right.start - left.start);
  let output = rawScript;
  for (const rewrite of rewrites) {
    const span = output.slice(rewrite.start, rewrite.end);
    if (!/^persist\s*\(/.test(span.trimStart())) {
      throw new SyntaxError(
        `Persistent initializer span no longer points at a persist() marker (compiler bug): ${JSON.stringify(span.slice(0, 40))}.`
      );
    }
    output = output.slice(0, rewrite.start) + rewrite.replacement + output.slice(rewrite.end);
  }
  return output;
}

module.exports = { rewritePersistInitializers };

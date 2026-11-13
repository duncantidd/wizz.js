// src/compiler/generator/attributePolicy.js
//
// One policy for how a dynamic attribute value reaches the DOM, shared by the
// browser create/update paths, each-block items, hydration, head nodes, and
// the server target so every target agrees on the markup.
//
//   - `value`, `checked`, `disabled` on body elements are assigned as DOM
//     properties (unchanged; the property is the live state for form controls).
//   - HTML boolean attributes are presence-only: a truthy value sets the
//     attribute to the empty string, a falsy value removes it. `hidden={false}`
//     therefore shows the element instead of rendering `hidden="false"`.
//   - Every other attribute is removed for `null`/`undefined` and otherwise
//     set to `String(value)`. `false` deliberately still renders "false":
//     enumerated attributes such as `aria-expanded`, `aria-hidden`,
//     `draggable`, `spellcheck`, and `contenteditable` give the string "false"
//     its own meaning, so removing it would silently change accessibility
//     semantics. (Conservative reading of issue #72: boolean attributes get
//     presence semantics, everything else only drops the never-useful
//     "null"/"undefined" strings.)

const PROPERTY_ATTRIBUTES = new Set(['value', 'checked', 'disabled']);

// Boolean attributes from the HTML Living Standard's attribute index. Matched
// case-insensitively because HTML attribute names are ASCII case-insensitive.
// The membership test runs at compile time only, so the list costs nothing in
// generated modules.
const BOOLEAN_ATTRIBUTES = new Set([
  'allowfullscreen', 'alpha', 'async', 'autofocus', 'autoplay', 'checked',
  'controls', 'default', 'defer', 'disabled', 'formnovalidate', 'hidden',
  'inert', 'ismap', 'itemscope', 'loop', 'multiple', 'muted', 'nomodule',
  'novalidate', 'open', 'playsinline', 'readonly', 'required', 'reversed',
  'selected', 'shadowrootclonable', 'shadowrootdelegatesfocus',
  'shadowrootserializable'
]);

function isBooleanAttribute(name) {
  return BOOLEAN_ATTRIBUTES.has(String(name).toLowerCase());
}

// Defined flush-left and emitted verbatim via Function.prototype.toString (the
// same pattern as the head and escaping helpers). The `__wizz` prefix is
// reserved, so author identifiers cannot collide with it. Only setAttribute /
// removeAttribute are used: values never reach innerHTML.
function __wizzAttr(node, name, value, boolean) {
  if (boolean ? !value : value == null) node.removeAttribute(name);
  else node.setAttribute(name, boolean ? '' : String(value));
}

/**
 * Source for one statement writing a dynamic attribute onto an element node.
 * @param {string} nodeRef - Expression naming the element.
 * @param {string} name - The attribute name.
 * @param {string} valueSource - The author expression source.
 * @param {{ properties?: boolean }} [options] - `properties: false` disables
 *   the value/checked/disabled property path (head nodes use attributes only).
 * @returns {string} A complete statement.
 */
function attributeWriteSource(nodeRef, name, valueSource, { properties = true } = {}) {
  // HTML attribute names are case-insensitive but DOM properties are not, so
  // `DISABLED={x}` must still assign the lowercase `.disabled` property.
  const lower = String(name).toLowerCase();
  if (properties && PROPERTY_ATTRIBUTES.has(lower)) return `${nodeRef}.${lower} = ${valueSource};`;
  return `__wizzAttr(${nodeRef}, ${JSON.stringify(name)}, ${valueSource}${isBooleanAttribute(name) ? ', 1' : ''});`;
}

/**
 * Source for an expression evaluating to the attribute's serialized value or
 * `null` when the attribute must be absent (used by hydration's head check).
 */
function attributeValueSource(name, valueSource) {
  return isBooleanAttribute(name)
    ? `((${valueSource}) ? '' : null)`
    : `((__wizzV) => __wizzV == null ? null : String(__wizzV))(${valueSource})`;
}

/**
 * Reports whether any element in an AST fragment carries a dynamic attribute
 * the `__wizzAttr` helper writes, so components with none keep byte-identical
 * output. Imported component tags are skipped when `componentNames` lists
 * them (their attributes are props, not DOM writes).
 * @param {object|object[]} root - AST fragment to scan.
 * @param {{ properties?: boolean, componentNames?: Set<string> }} [options] -
 *   `properties: false` counts value/checked/disabled too (head nodes).
 * @returns {boolean}
 */
function needsAttributeHelper(root, { properties = true, componentNames = new Set() } = {}) {
  const seen = new Set();
  const visit = (value) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) return value.some(visit);
    if (value.type === 'Element' && Array.isArray(value.attributes)
      && value.componentId == null && !componentNames.has(value.name)) {
      const written = value.attributes.some((attribute) => attribute.dynamic
        && !attribute.name.startsWith('on:')
        && !(properties && PROPERTY_ATTRIBUTES.has(attribute.name.toLowerCase())));
      if (written) return true;
    }
    return Object.keys(value).some((key) => key !== 'loc' && key !== 'attributes' && visit(value[key]));
  };
  return visit(root);
}

module.exports = {
  PROPERTY_ATTRIBUTES,
  BOOLEAN_ATTRIBUTES,
  isBooleanAttribute,
  attributeWriteSource,
  attributeValueSource,
  needsAttributeHelper,
  __wizzAttr
};

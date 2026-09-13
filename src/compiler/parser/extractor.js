/**
 * Extracts the JavaScript content from the <script> tag and removes the node from the AST.
 * @param {Object} ast - The fully integrated Template AST
 * @returns {string|null} The raw JavaScript string, or null if no script block exists.
 */
function extractScriptBlock(ast) {
  let scriptContent = null;

  function walk(node, parent, indexInParent) {
    if (node.type === 'Element' && node.name === 'script') {
      
      // 1. Extract and reconstruct the text content from ALL children
      if (node.children && node.children.length > 0) {
        scriptContent = node.children.map(child => {
          if (child.type === 'Text') return child.value;
          // If the tokenizer grabbed an expression, wrap it back in braces
          if (child.type === 'Expression') return `{${child.value}}`; 
          return '';
        }).join('');
      }

      // 2. Prune the script node from the AST
      if (parent && typeof indexInParent === 'number') {
        parent.children.splice(indexInParent, 1);
      }
      
      return;
    }

    if (node.children && Array.isArray(node.children)) {
      for (let i = node.children.length - 1; i >= 0; i--) {
        walk(node.children[i], node, i);
      }
    }
  }

  walk(ast, null, null);

  return scriptContent;
}

/**
 * Removes the top-level <wizz:head> block (if any) from the template AST and
 * returns it. Head markup is a page-level declaration, never body markup, so
 * the parser enforces it at root level and every later stage — body DOM
 * generation, the update pass, ID assignment, and the server renderability
 * gate — receives a tree with the block already pruned out.
 * @param {Object} ast - The fully integrated Template AST (Root node)
 * @returns {Object|null} The HeadBlock node, or null when the component declares no head.
 */
function extractHeadBlock(ast) {
  const index = ast.children.findIndex((child) => child.type === 'HeadBlock');
  if (index === -1) return null;
  const [headBlock] = ast.children.splice(index, 1);
  return headBlock;
}

module.exports = { extractScriptBlock, extractHeadBlock };
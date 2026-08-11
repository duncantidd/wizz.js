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

module.exports = { extractScriptBlock };
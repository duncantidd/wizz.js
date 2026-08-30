function parseTemplate(tokens) {
  // The root of our AST
  const root = {
    type: 'Root',
    children: []
  };

  const stack = [root];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    // The current parent is always the top of the stack
    const currentParent = stack[stack.length - 1];

    switch (token.type) {
      case 'OpenTag': {
        const element = {
          type: 'Element',
          name: token.name,
          attributes: token.attributes || [],
          children: [],
          loc: token.loc // Preserving your excellent source mapping
        };
        currentParent.children.push(element);
        stack.push(element); // This element is now the current parent
        break;
      }

      case 'CloseTag': {
        // Validate that the closing tag matches the currently open tag
        if (currentParent.type === 'Root') {
          throw new SyntaxError(`Unexpected closing tag </${token.name}> at ${token.loc.start.line}:${token.loc.start.column}. No open tags.`);
        }
        if (currentParent.name !== token.name) {
          throw new SyntaxError(`Mismatched closing tag. Expected </${currentParent.name}>, found </${token.name}> at ${token.loc.start.line}:${token.loc.start.column}.`);
        }
        
        stack.pop(); // Close the element by removing it from the stack
        break;
      }

      case 'SelfClosingTag': {
        const element = {
          type: 'Element',
          name: token.name,
          attributes: token.attributes || [],
          children: [], // Self-closing tags have no children
          loc: token.loc
        };
        currentParent.children.push(element);
        // Do NOT push to stack because it immediately closes
        break;
      }

      case 'Text': {
        currentParent.children.push({
          type: 'Text',
          value: token.value,
          loc: token.loc
        });
        break;
      }

      case 'Expression': {
        const directive = token.value.trim();
        if (directive.startsWith('#if ')) {
          const block = { type: 'IfBlock', test: directive.slice(4).trim(), consequent: [], alternate: null, children: [] };
          currentParent.children.push(block);
          stack.push(block);
          block.children = block.consequent;
          break;
        }
        if (directive === ':else') {
          if (currentParent.type !== 'IfBlock') throw new SyntaxError('Unexpected {:else}.');
          currentParent.alternate = [];
          currentParent.children = currentParent.alternate;
          break;
        }
        if (directive === '/if') {
          if (currentParent.type !== 'IfBlock') throw new SyntaxError('Unexpected {/if}.');
          stack.pop();
          break;
        }
        if (directive.startsWith('#each ')) {
          const match = directive.match(/^#each\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+\(\2\.([A-Za-z_$][A-Za-z0-9_$]*)\))?$/);
          if (!match) throw new SyntaxError('Each blocks require `collection as item` or `collection as item (item.key)` syntax.');
          const [, collection, item, key] = match;
          const block = { type: 'EachBlock', collection, item, key: key ?? null, children: [] };
          currentParent.children.push(block);
          stack.push(block);
          break;
        }
        if (directive === '/each') {
          if (currentParent.type !== 'EachBlock') throw new SyntaxError('Unexpected {/each}.');
          stack.pop();
          break;
        }
        currentParent.children.push({
          type: 'Expression',
          value: token.value, // We will hand this raw string to the Pratt Parser later
          loc: token.loc
        });
        break;
      }

      default:
        throw new SyntaxError(`Unsupported token type '${token.type}' at ${token.loc.start.line}:${token.loc.start.column}.`);
    }
  }

  // If the stack has more than just the Root node, a tag was left unclosed
  if (stack.length > 1) {
    const unclosed = stack[stack.length - 1];
    throw new SyntaxError(`Unclosed tag <${unclosed.name}> starting at ${unclosed.loc.start.line}:${unclosed.loc.start.column}.`);
  }

  return root;
}

module.exports = { parseTemplate };
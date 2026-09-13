// The framework-namespaced head block. Colon spelling matches the `on:`
// directive convention; the tokenizer already accepts `:` inside tag names.
const HEAD_BLOCK_NAME = 'wizz:head';
// The only elements a head block may contain. `meta` and `link` are void
// elements: inside a head block they may be written unclosed (the common
// authoring form) and can never receive a closing tag.
const HEAD_CHILD_ELEMENTS = new Set(['title', 'meta', 'link']);
const HEAD_VOID_ELEMENTS = new Set(['meta', 'link']);
// The framework-namespaced style block for scoped component stylesheets.
// Colon spelling matches <wizz:head>; the tokenizer raw-texts its body, so
// CSS braces, colons, and quotes never reach the expression lexer.
const STYLE_BLOCK_NAME = 'wizz:style';
// A plain <style> keeps HTML's global-stylesheet meaning in ordinary markup,
// so it is never silently accepted as the scoped form.
const PLAIN_STYLE_ELEMENT_NAME = 'style';

function parseTemplate(tokens) {
  // The root of our AST
  const root = {
    type: 'Root',
    children: []
  };

  const stack = [root];
  // Nesting depth of open <wizz:head> blocks. Head content validation needs to
  // know the context is a head block even when the current parent is one of
  // its elements (e.g. <title>).
  let headDepth = 0;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    // The current parent is always the top of the stack
    const currentParent = stack[stack.length - 1];
    const at = `${token.loc.start.line}:${token.loc.start.column}`;

    switch (token.type) {
      case 'OpenTag': {
        if (token.name === HEAD_BLOCK_NAME) {
          if (currentParent.type !== 'Root') {
            throw new SyntaxError(`<wizz:head> must be a top-level block; it cannot be nested inside <${currentParent.name}> at ${at}.`);
          }
          if (token.attributes && token.attributes.length > 0) {
            throw new SyntaxError(`<wizz:head> does not accept attributes at ${at}.`);
          }
          if (root.children.some((child) => child.type === 'HeadBlock')) {
            throw new SyntaxError(`A component can declare only one <wizz:head> block at ${at}.`);
          }
          const headBlock = { type: 'HeadBlock', name: 'wizz:head', children: [], loc: token.loc };
          currentParent.children.push(headBlock);
          stack.push(headBlock);
          headDepth += 1;
          break;
        }
        if (token.name === STYLE_BLOCK_NAME) {
          if (currentParent.type !== 'Root') {
            throw new SyntaxError(`<wizz:style> must be a top-level block; it cannot be nested inside <${currentParent.name || currentParent.type}> at ${at}.`);
          }
          if (token.attributes && token.attributes.length > 0) {
            throw new SyntaxError(`<wizz:style> does not accept attributes at ${at}.`);
          }
          if (root.children.some((child) => child.type === 'StyleBlock')) {
            throw new SyntaxError(`A component can declare only one <wizz:style> block at ${at}.`);
          }
          const styleBlock = { type: 'StyleBlock', name: 'wizz:style', value: '', loc: token.loc };
          currentParent.children.push(styleBlock);
          stack.push(styleBlock);
          break;
        }
        if (currentParent.type === 'StyleBlock') {
          throw new SyntaxError(`<${token.name}> is not allowed inside <wizz:style> — style content is raw CSS at ${at}.`);
        }
        if (headDepth > 0) {
          // Inside a head block the only element ever pushed onto the stack is
          // <title> (meta and link are void), so a further open tag under an
          // Element parent is always a nested element inside <title>.
          if (currentParent.type === 'Element' && currentParent.name === 'title') {
            throw new SyntaxError(`<${token.name}> is not allowed inside <title> at ${at}.`);
          }
          if (!HEAD_CHILD_ELEMENTS.has(token.name)) {
            throw new SyntaxError(`<${token.name}> is not allowed inside <wizz:head> — only <title>, <meta>, and <link> are supported at ${at}.`);
          }
          const element = {
            type: 'Element',
            name: token.name,
            attributes: token.attributes || [],
            children: [],
            loc: token.loc
          };
          currentParent.children.push(element);
          if (!HEAD_VOID_ELEMENTS.has(token.name)) stack.push(element);
          break;
        }
        if (token.name === PLAIN_STYLE_ELEMENT_NAME) {
          throw new SyntaxError(`Plain <style> blocks are not supported — use <wizz:style> for scoped component styles at ${at}.`);
        }
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
        if (currentParent.type === 'HeadBlock' && HEAD_VOID_ELEMENTS.has(token.name)) {
          throw new SyntaxError(`The void element <${token.name}> cannot have a closing tag at ${at}.`);
        }
        // Validate that the closing tag matches the currently open tag
        if (currentParent.type === 'Root') {
          throw new SyntaxError(`Unexpected closing tag </${token.name}> at ${at}. No open tags.`);
        }
        if (currentParent.name !== token.name) {
          throw new SyntaxError(`Mismatched closing tag. Expected </${currentParent.name}>, found </${token.name}> at ${at}.`);
        }

        if (currentParent.type === 'HeadBlock') headDepth -= 1;
        stack.pop(); // Close the element by removing it from the stack
        break;
      }

      case 'SelfClosingTag': {
        if (token.name === HEAD_BLOCK_NAME) {
          // An empty head block is a harmless no-op; it carries no children.
          if (currentParent.type !== 'Root') {
            throw new SyntaxError(`<wizz:head> must be a top-level block; it cannot be nested inside <${currentParent.name}> at ${at}.`);
          }
          if (token.attributes && token.attributes.length > 0) {
            throw new SyntaxError(`<wizz:head> does not accept attributes at ${at}.`);
          }
          if (root.children.some((child) => child.type === 'HeadBlock')) {
            throw new SyntaxError(`A component can declare only one <wizz:head> block at ${at}.`);
          }
          currentParent.children.push({ type: 'HeadBlock', name: 'wizz:head', children: [], loc: token.loc });
          // Do NOT push to stack because it immediately closes
          break;
        }
        if (token.name === STYLE_BLOCK_NAME) {
          if (currentParent.type !== 'Root') {
            throw new SyntaxError(`<wizz:style> must be a top-level block; it cannot be nested inside <${currentParent.name || currentParent.type}> at ${at}.`);
          }
          if (token.attributes && token.attributes.length > 0) {
            throw new SyntaxError(`<wizz:style> does not accept attributes at ${at}.`);
          }
          if (root.children.some((child) => child.type === 'StyleBlock')) {
            throw new SyntaxError(`A component can declare only one <wizz:style> block at ${at}.`);
          }
          // An empty style block is a harmless no-op; it carries no CSS.
          currentParent.children.push({ type: 'StyleBlock', name: 'wizz:style', value: '', loc: token.loc });
          // Do NOT push to stack because it immediately closes
          break;
        }
        if (headDepth > 0) {
          if (!HEAD_CHILD_ELEMENTS.has(token.name)) {
            throw new SyntaxError(`<${token.name}> is not allowed inside <wizz:head> — only <title>, <meta>, and <link> are supported at ${at}.`);
          }
          const element = {
            type: 'Element',
            name: token.name,
            attributes: token.attributes || [],
            children: [],
            loc: token.loc
          };
          currentParent.children.push(element);
          // Void or self-closing: never pushed onto the stack
          break;
        }
        if (token.name === PLAIN_STYLE_ELEMENT_NAME) {
          throw new SyntaxError(`Plain <style> blocks are not supported — use <wizz:style> for scoped component styles at ${at}.`);
        }
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
        if (currentParent.type === 'StyleBlock') {
          // Raw CSS from the tokenizer's raw-text mode, appended verbatim —
          // whitespace included; the extraction step decides final trimming.
          currentParent.value += token.value;
          break;
        }
        if (headDepth > 0 && currentParent.type === 'HeadBlock') {
          // Whitespace between head elements is formatting, not content; only
          // the three allowed elements may appear as direct head children.
          if (token.value.trim() === '') break;
          throw new SyntaxError(`Only <title>, <meta>, and <link> elements are allowed inside <wizz:head> at ${at}.`);
        }
        currentParent.children.push({
          type: 'Text',
          value: token.value,
          loc: token.loc
        });
        break;
      }

      case 'Expression': {
        if (currentParent.type === 'StyleBlock') {
          // Unreachable through tokenize() — raw-text mode keeps expressions
          // out of style bodies — but guards hand-built token streams so a
          // future tokenizer regression fails here with a clear diagnostic.
          throw new SyntaxError(`Expressions are not allowed inside <wizz:style> — style content is opaque CSS at ${at}.`);
        }
        if (headDepth > 0 && currentParent.type === 'HeadBlock') {
          // Head follows navigation, not state changes: neither block
          // directives nor bare expression text are head children.
          // Expressions are supported inside <title> text and as dynamic
          // attribute values on the allowed elements.
          const directive = token.value.trim();
          if (directive.startsWith('#if ') || directive === ':else' || directive === '/if'
            || directive.startsWith('#each ') || directive === '/each') {
            throw new SyntaxError(`Block directives are not supported inside <wizz:head> at ${at}.`);
          }
          throw new SyntaxError(`Expressions are not allowed directly inside <wizz:head> — put them inside <title> text at ${at}.`);
        }
        const directive = token.value.trim();
        if (directive.startsWith('#if ')) {
          const block = { type: 'IfBlock', test: directive.slice(4).trim(), consequent: [], alternate: null, children: [], loc: token.loc };
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
          const block = { type: 'EachBlock', collection, item, key: key ?? null, children: [], loc: token.loc };
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
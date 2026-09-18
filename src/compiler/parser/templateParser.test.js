const assert = require('node:assert/strict');
const test = require('node:test');
const { parseTemplate } = require('./templateParser');
const { tokenize } = require('./tokenizer');

test('builds a nested AST from tokenizer output', () => {
  const ast = parseTemplate(tokenize('<main><img alt="Logo" /><p>Hello {name}</p></main>'));

  assert.deepEqual(ast, {
    type: 'Root',
    children: [
      {
        type: 'Element',
        name: 'main',
        attributes: [],
        children: [
          {
            type: 'Element',
            name: 'img',
            attributes: [{ name: 'alt', value: 'Logo' }],
            children: [],
            loc: {
              start: { offset: 6, line: 1, column: 7 },
              end: { offset: 24, line: 1, column: 25 }
            }
          },
          {
            type: 'Element',
            name: 'p',
            attributes: [],
            children: [
              {
                type: 'Text',
                value: 'Hello ',
                loc: {
                  start: { offset: 27, line: 1, column: 28 },
                  end: { offset: 33, line: 1, column: 34 }
                }
              },
              {
                type: 'Expression',
                value: 'name',
                loc: {
                  start: { offset: 33, line: 1, column: 34 },
                  end: { offset: 39, line: 1, column: 40 }
                }
              }
            ],
            loc: {
              start: { offset: 24, line: 1, column: 25 },
              end: { offset: 27, line: 1, column: 28 }
            }
          }
        ],
        loc: {
          start: { offset: 0, line: 1, column: 1 },
          end: { offset: 6, line: 1, column: 7 }
        }
      }
    ]
  });
});

test('reports invalid template structure', () => {
  assert.throws(
    () => parseTemplate(tokenize('<div></span>')),
    /Mismatched closing tag\. Expected <\/div>, found <\/span> at 1:6\./
  );
  assert.throws(
    () => parseTemplate(tokenize('</div>')),
    /Unexpected closing tag <\/div> at 1:1\. No open tags\./
  );
  assert.throws(
    () => parseTemplate(tokenize('<div>')),
    /Unclosed tag <div> starting at 1:1\./
  );
});

test('rejects unsupported tokens instead of discarding them', () => {
  assert.throws(
    () => parseTemplate([{ type: 'Comment', loc: { start: { line: 2, column: 4 } } }]),
    /Unsupported token type 'Comment' at 2:4\./
  );
});

test('records source locations on block nodes', () => {
  const source = '<main>{#if flag}<p>yes</p>{/if}{#each items as item}<span></span>{/each}</main>';
  const root = parseTemplate(tokenize(source));
  const [ifBlock, eachBlock] = root.children[0].children;

  // Block nodes carry their directive token's location so downstream
  // consumers (e.g. the server target's diagnostics) can report `at L:C`.
  assert.equal(ifBlock.loc.start.line, 1);
  assert.equal(ifBlock.loc.start.column, 7);
  assert.equal(eachBlock.loc.start.line, 1);
  assert.equal(eachBlock.loc.start.column, 32);
});

test('parses if blocks with an optional else branch', () => {
  const root = parseTemplate(tokenize("<main>{#if section === 'About'}<p>About</p>{:else}<p>Other</p>{/if}</main>"));
  const block = root.children[0].children[0];

  assert.equal(block.type, 'IfBlock');
  assert.equal(block.test, "section === 'About'");
  assert.equal(block.consequent[0].name, 'p');
  assert.equal(block.alternate[0].name, 'p');
});

test('parses keyed each blocks', () => {
  const root = parseTemplate(tokenize('<ul>{#each items as item (item.id)}<li>{item.name}</li>{/each}</ul>'));
  const block = root.children[0].children[0];

  assert.deepEqual(
    { type: block.type, collection: block.collection, item: block.item, key: block.key },
    { type: 'EachBlock', collection: 'items', item: 'item', key: 'id' }
  );
  assert.equal(block.children[0].name, 'li');
});

test('parses keyless each blocks without an item key', () => {
  const root = parseTemplate(tokenize('<ul>{#each items as item}<li>{item}</li>{/each}</ul>'));
  const block = root.children[0].children[0];

  assert.deepEqual(
    { type: block.type, collection: block.collection, item: block.item, key: block.key },
    { type: 'EachBlock', collection: 'items', item: 'item', key: null }
  );
  assert.equal(block.children[0].name, 'li');
});

test('rejects each blocks with malformed syntax', () => {
  assert.throws(
    () => parseTemplate(tokenize('<ul>{#each items as}<li></li>{/each}</ul>')),
    /Each blocks require `collection as item` or `collection as item \(item\.key\)` syntax\./
  );
  assert.throws(
    () => parseTemplate(tokenize('<ul>{#each items as item (item)}<li></li>{/each}</ul>')),
    /Each blocks require `collection as item` or `collection as item \(item\.key\)` syntax\./
  );
  assert.throws(
    () => parseTemplate(tokenize('<ul>{#each items}<li></li>{/each}</ul>')),
    /Each blocks require `collection as item` or `collection as item \(item\.key\)` syntax\./
  );
});
test('parses a top-level wizz:head block with only the allowed head elements', () => {
  const source = '<wizz:head><title>Hello</title><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/a.css"></wizz:head><main>Body</main>';
  const root = parseTemplate(tokenize(source));

  assert.equal(root.children.length, 2);
  const head = root.children[0];
  assert.equal(head.type, 'HeadBlock');
  assert.equal(head.name, 'wizz:head');
  assert.equal(head.loc.start.line, 1);
  assert.equal(head.loc.start.column, 1);

  const [title, meta, link] = head.children;
  assert.equal(title.type, 'Element');
  assert.equal(title.name, 'title');
  assert.deepEqual(
    title.children.map((child) => ({ type: child.type, value: child.value })),
    [{ type: 'Text', value: 'Hello' }]
  );
  assert.equal(meta.name, 'meta');
  assert.deepEqual(meta.attributes, [
    { name: 'name', value: 'viewport' },
    { name: 'content', value: 'width=device-width' }
  ]);
  assert.equal(link.name, 'link');
  assert.deepEqual(link.attributes, [
    { name: 'rel', value: 'stylesheet' },
    { name: 'href', value: '/a.css' }
  ]);
  assert.equal(root.children[1].name, 'main');
});

test('treats meta and link as void inside head blocks', () => {
  // Unclosed meta must not swallow the following title (the common authoring form)
  const unclosed = parseTemplate(tokenize('<wizz:head><meta name="a"><title>t</title></wizz:head>'));
  assert.deepEqual(unclosed.children[0].children.map((child) => child.name), ['meta', 'title']);

  // Self-closing forms work too
  const selfClosed = parseTemplate(tokenize('<wizz:head><meta name="a" /><link rel="b" /></wizz:head>'));
  assert.deepEqual(selfClosed.children[0].children.map((child) => child.name), ['meta', 'link']);
  assert.deepEqual(selfClosed.children[0].children.map((child) => child.children.length), [0, 0]);

  // And they can never receive a closing tag
  assert.throws(
    () => parseTemplate(tokenize('<wizz:head><meta name="a"></meta></wizz:head>')),
    /The void element <meta> cannot have a closing tag at 1:\d+\./
  );
});

test('skips whitespace between head elements and allows expression title text', () => {
  const source = '<wizz:head>\n  <title>Page: {title}</title>\n  <meta content={description}>\n</wizz:head><main></main>';
  const root = parseTemplate(tokenize(source));
  const head = root.children[0];

  assert.equal(head.children.length, 2);
  const title = head.children[0];
  assert.deepEqual(
    title.children.map((child) => ({ type: child.type, value: child.value })),
    [
      { type: 'Text', value: 'Page: ' },
      { type: 'Expression', value: 'title' }
    ]
  );
  assert.equal(head.children[1].name, 'meta');
  assert.deepEqual(head.children[1].attributes, [{ name: 'content', value: 'description', dynamic: true }]);
});

test('parses a self-closing empty head block', () => {
  const root = parseTemplate(tokenize('<wizz:head /><main>Body</main>'));
  assert.equal(root.children[0].type, 'HeadBlock');
  assert.deepEqual(root.children[0].children, []);
  assert.equal(root.children[1].name, 'main');
});

test('rejects head blocks nested inside elements', () => {
  assert.throws(
    () => parseTemplate(tokenize('<main><wizz:head></wizz:head></main>')),
    /<wizz:head> must be a top-level block; it cannot be nested inside <main> at 1:7\./
  );
});

test('rejects a second head block in the same component', () => {
  assert.throws(
    () => parseTemplate(tokenize('<wizz:head></wizz:head><wizz:head></wizz:head>')),
    /A component can declare only one <wizz:head> block at 1:24\./
  );
});

test('rejects attributes on the head block itself', () => {
  assert.throws(
    () => parseTemplate(tokenize('<wizz:head lang="en"></wizz:head>')),
    /<wizz:head> does not accept attributes at 1:1\./
  );
});

test('rejects unsupported elements inside head blocks with located diagnostics', () => {
  const source = '<wizz:head>\n  <div></div>\n</wizz:head>';
  assert.throws(
    () => parseTemplate(tokenize(source)),
    /<div> is not allowed inside <wizz:head> — only <title>, <meta>, and <link> are supported at 2:3\./
  );
});

test('rejects text outside title inside head blocks', () => {
  assert.throws(
    () => parseTemplate(tokenize('<wizz:head>hello</wizz:head>')),
    /Only <title>, <meta>, and <link> elements are allowed inside <wizz:head> at 1:12\./
  );
});

test('rejects expressions placed directly inside head blocks', () => {
  assert.throws(
    () => parseTemplate(tokenize('<wizz:head>{title}</wizz:head>')),
    /Expressions are not allowed directly inside <wizz:head> — put them inside <title> text at 1:12\./
  );
});

test('rejects block directives inside head blocks', () => {
  assert.throws(
    () => parseTemplate(tokenize('<wizz:head>{#if flag}<title>t</title>{/if}</wizz:head>')),
    /Block directives are not supported inside <wizz:head> at 1:12\./
  );
  assert.throws(
    () => parseTemplate(tokenize('<wizz:head>{#each items as item}<title>t</title>{/each}</wizz:head>')),
    /Block directives are not supported inside <wizz:head> at 1:12\./
  );
});

test('rejects elements nested inside title inside head blocks', () => {
  assert.throws(
    () => parseTemplate(tokenize('<wizz:head><title><b>x</b></title></wizz:head>')),
    /<b> is not allowed inside <title> at 1:19\./
  );
});

test('reports unclosed head blocks and nested unclosed titles', () => {
  assert.throws(
    () => parseTemplate(tokenize('<wizz:head>')),
    /Unclosed tag <wizz:head> starting at 1:1\./
  );
  assert.throws(
    () => parseTemplate(tokenize('<wizz:head><title>t')),
    /Unclosed tag <title> starting at 1:12\./
  );
});

test('parses a top-level wizz:style block with raw CSS preserved', () => {
  const source = '<wizz:style>\n  h2 {\n    font-size: 30px; /* {not an expression} */\n    content: "a } b";\n  }\n</wizz:style><main>Body</main>';
  const ast = parseTemplate(tokenize(source));

  const style = ast.children[0];
  assert.equal(style.type, 'StyleBlock');
  assert.equal(style.name, 'wizz:style');
  assert.equal(style.value, '\n  h2 {\n    font-size: 30px; /* {not an expression} */\n    content: "a } b";\n  }\n');
  assert.equal(style.loc.start.line, 1);
  assert.equal(style.loc.start.column, 1);
  // The block is a sibling of body markup; body parsing is unaffected.
  assert.equal(ast.children[1].type, 'Element');
  assert.equal(ast.children[1].name, 'main');
});

test('keeps every raw-text character of style content, whitespace included', () => {
  const source = '<wizz:style>@media (min-width: 40em) {\n  a:hover { color: red }\n}\n</wizz:style>';
  const ast = parseTemplate(tokenize(source));
  assert.equal(ast.children[0].value, '@media (min-width: 40em) {\n  a:hover { color: red }\n}\n');
});

test('accepts a self-closing empty wizz:style block', () => {
  const ast = parseTemplate(tokenize('<wizz:style /><main>Body</main>'));
  assert.deepEqual(
    { type: ast.children[0].type, name: ast.children[0].name, value: ast.children[0].value },
    { type: 'StyleBlock', name: 'wizz:style', value: '' }
  );
});

test('rejects a wizz:style block nested inside an element', () => {
  assert.throws(
    () => parseTemplate(tokenize('<main><wizz:style>h2 {}</wizz:style></main>')),
    /<wizz:style> must be a top-level block; it cannot be nested inside <main> at 1:7\./
  );
});

test('rejects a wizz:style block inside an each body', () => {
  assert.throws(
    () => parseTemplate(tokenize('{#each items as item}<wizz:style>h2 {}</wizz:style>{/each}')),
    /<wizz:style> must be a top-level block; it cannot be nested inside <EachBlock> at 1:22\./
  );
});

test('rejects attributes on a wizz:style block', () => {
  assert.throws(
    () => parseTemplate(tokenize('<wizz:style media="print">h2 {}</wizz:style>')),
    /<wizz:style> does not accept attributes at 1:1\./
  );
});

test('rejects a second wizz:style block', () => {
  assert.throws(
    () => parseTemplate(tokenize('<wizz:style>h2 {}</wizz:style><wizz:style>p {}</wizz:style>')),
    /A component can declare only one <wizz:style> block at 1:31\./
  );
});

test('rejects a plain style element with a diagnostic pointing at wizz:style', () => {
  assert.throws(
    () => parseTemplate(tokenize('<main><style>h2 { color: red }</style></main>')),
    /Plain <style> blocks are not supported — use <wizz:style> for scoped component styles at 1:7\./
  );
  assert.throws(
    () => parseTemplate(tokenize('<style />')),
    /Plain <style> blocks are not supported — use <wizz:style> for scoped component styles at 1:1\./
  );
});

test('reports unclosed style blocks at the parser level', () => {
  // Hand-built token stream: the tokenizer fails earlier on real unclosed
  // input; this pins the parser's own guard for any token source.
  const openTag = {
    type: 'OpenTag',
    name: 'wizz:style',
    attributes: [],
    start: 0,
    end: 12,
    loc: { start: { offset: 0, line: 1, column: 1 }, end: { offset: 12, line: 1, column: 13 } }
  };
  assert.throws(
    () => parseTemplate([openTag]),
    /Unclosed tag <wizz:style> starting at 1:1\./
  );
});

test('rejects expressions and elements inside style blocks', () => {
  // Both are unreachable through tokenize() — raw-text mode keeps them out of
  // style bodies — so these pin the parser guards against hand-built streams
  // and future tokenizer regressions.
  const openLoc = { start: { offset: 0, line: 1, column: 1 }, end: { offset: 12, line: 1, column: 13 } };
  const innerLoc = { start: { offset: 12, line: 1, column: 13 }, end: { offset: 19, line: 1, column: 20 } };
  const openTag = { type: 'OpenTag', name: 'wizz:style', attributes: [], start: 0, end: 12, loc: openLoc };
  const expression = { type: 'Expression', value: 'title', start: 12, end: 19, loc: innerLoc };
  const divTag = { type: 'OpenTag', name: 'div', attributes: [], start: 12, end: 17, loc: innerLoc };

  assert.throws(
    () => parseTemplate([openTag, expression]),
    /Expressions are not allowed inside <wizz:style> — style content is opaque CSS at 1:13\./
  );
  assert.throws(
    () => parseTemplate([openTag, divTag]),
    /<div> is not allowed inside <wizz:style> — style content is raw CSS at 1:13\./
  );
});

// --- pre-family leading-newline normalization (hydration alignment) ---

// The HTML tree builder drops a single newline immediately after a
// pre/textarea/listing start tag and immediately after its end tag. The
// parser models that so the server markup, the client's created nodes, and
// the hydration walk's expectations all describe the DOM the browser
// actually builds from the delivered markup.

// Compact child summary: elements as <name>, text as the verbatim value,
// expressions as {source}.
const childValues = (element) => element.children.map((child) => {
  if (child.type === 'Element') return `<${child.name}>`;
  if (child.type === 'Expression') return `{${child.value}}`;
  return child.value;
});

test('drops the authoring newline immediately after a pre start tag', () => {
  const ast = parseTemplate(tokenize('<pre>\n  <code>x</code></pre>'));

  assert.deepEqual(childValues(ast.children[0]), ['  ', '<code>']);
});

test('drops exactly one newline after a pre start tag', () => {
  const ast = parseTemplate(tokenize('<pre>\n\nkeep me</pre>'));

  assert.deepEqual(childValues(ast.children[0]), ['\nkeep me']);
});

test('drops a carriage-return newline pair after a pre start tag', () => {
  const ast = parseTemplate(tokenize('<pre>\r\nx</pre>'));

  assert.deepEqual(childValues(ast.children[0]), ['x']);
});

test('keeps pre text that does not start with a newline', () => {
  const ast = parseTemplate(tokenize('<pre>unchanged</pre>'));

  assert.deepEqual(childValues(ast.children[0]), ['unchanged']);
});

test('a newline-only first text inside pre produces no text node', () => {
  const ast = parseTemplate(tokenize('<pre>\n</pre>'));

  assert.deepEqual(childValues(ast.children[0]), []);
});

test('drops the newline in the text immediately after a pre end tag', () => {
  const ast = parseTemplate(tokenize('<div><pre>x</pre>\n  </div>'));

  assert.deepEqual(childValues(ast.children[0]), ['<pre>', '  ']);
});

test('a newline-only text after a pre end tag produces no text node', () => {
  const ast = parseTemplate(tokenize('<div><pre>x</pre>\n</div>'));

  assert.deepEqual(childValues(ast.children[0]), ['<pre>']);
});

test('an expression between the pre start tag and the newline blocks the drop', () => {
  // The next token is not the newline, and runtime output could end in one;
  // only statically known text is normalized.
  const ast = parseTemplate(tokenize('<pre>{x}\ny</pre>'));

  assert.deepEqual(childValues(ast.children[0]), ['{x}', '\ny']);
});

test('applies both newline rules to textarea', () => {
  const ast = parseTemplate(tokenize('<div><textarea>\ncontent</textarea>\n</div>'));
  const div = ast.children[0];

  assert.deepEqual(childValues(div), ['<textarea>']);
  assert.deepEqual(childValues(div.children[0]), ['content']);
});

test('applies the open-tag rule to listing', () => {
  const ast = parseTemplate(tokenize('<listing>\nx</listing>'));

  assert.deepEqual(childValues(ast.children[0]), ['x']);
});

test('elements outside the pre family keep their leading newlines', () => {
  const ast = parseTemplate(tokenize('<div>\n<span>\nx</span></div>'));

  assert.deepEqual(childValues(ast.children[0]), ['\n', '<span>']);
  assert.deepEqual(childValues(ast.children[0].children[1]), ['\nx']);
});

test('a self-closing pre applies the trailing-text rule', () => {
  const ast = parseTemplate(tokenize('<div><pre />\n  </div>'));

  assert.deepEqual(childValues(ast.children[0]), ['<pre>', '  ']);
});

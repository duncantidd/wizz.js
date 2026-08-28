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

test('parses if blocks with an optional else branch', () => {
  const root = parseTemplate(tokenize("<main>{#if section === 'About'}<p>About</p>{:else}<p>Other</p>{/if}</main>"));
  const block = root.children[0].children[0];

  assert.equal(block.type, 'IfBlock');
  assert.equal(block.test, "section === 'About'");
  assert.equal(block.consequent[0].name, 'p');
  assert.equal(block.alternate[0].name, 'p');
});
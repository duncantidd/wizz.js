const assert = require('node:assert/strict');
const test = require('node:test');
const { assignNodeIds } = require('../analyzer/idAssigner');
const { analyzeDependencies } = require('../analyzer/dependencyAnalyzer');
const { parseComponent } = require('../parser');
const { generateComponent } = require('./componentGenerator');

function createDocument() {
  const elements = new Map();

  return {
    createElement(name) {
      return {
        name,
        attributes: {},
        childNodes: [],
        setAttribute(attributeName, value) {
          this.attributes[attributeName] = value;
          if (attributeName === 'data-wizz-id') {
            elements.set(`[data-wizz-id="${value}"]`, this);
          }
        },
        appendChild(node) {
          this.childNodes.push(node);
        }
      };
    },
    createTextNode(nodeValue) {
      return { nodeValue };
    },
    querySelector(selector) {
      return elements.get(selector) || null;
    }
  };
}

test('generates a mountable module from formatted component source', () => {
  const payload = assignNodeIds(analyzeDependencies(parseComponent(`
    <script>let count = 0;</script>
    <main><h1>Count: {count}</h1></main>
  `)));
  const source = generateComponent(payload);
  const document = createDocument();
  const target = {
    childNodes: [],
    appendChild(node) {
      this.childNodes.push(node);
    },
    removeChild(node) {
      this.childNodes.splice(this.childNodes.indexOf(node), 1);
    }
  };
  const mountComponent = new Function(
    'document',
    `${source.replace('export default ', '')}\nreturn mountComponent;`
  )(document);

  const component = mountComponent(target);

  assert.equal(target.childNodes.length, 1);
  assert.equal(target.childNodes[0].name, 'main');
  assert.equal(target.childNodes[0].childNodes[0].name, 'h1');
  assert.equal(target.childNodes[0].childNodes[0].childNodes[1].nodeValue, '0');

  component.destroy();
  assert.deepEqual(target.childNodes, []);
});

test('emits an ES module default export and creates framework context getters', () => {
  const payload = assignNodeIds(analyzeDependencies(parseComponent(
    '<script>let count = 0; const title = "Total";</script><p>{count}</p>'
  )));
  const source = generateComponent(payload);

  assert.match(source, /^export default function mountComponent\(target\)/);
  assert.match(source, /get count\(\) \{ return count; \}/);
  assert.doesNotMatch(source, /get title\(\)/);
});
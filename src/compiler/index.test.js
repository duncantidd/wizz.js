const assert = require('node:assert/strict');
const test = require('node:test');
const { compile } = require('./index');

function createDocument() {
  const elements = new Map();

  return {
    createElement(name) {
      return {
        name,
        attributes: {},
        childNodes: [],
        listeners: {},
        setAttribute(attributeName, value) {
          this.attributes[attributeName] = value;
          if (attributeName === 'data-wizz-id') {
            elements.set(`[data-wizz-id="${value}"]`, this);
          }
        },
        appendChild(node) {
          this.childNodes.push(node);
        },
        addEventListener(eventName, listener) {
          this.listeners[eventName] = listener;
        },
        dispatchEvent(eventName) {
          this.listeners[eventName]?.({ type: eventName, target: this });
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

function mount(source, document) {
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
    `${compile(source).source.replace('export default ', '')}\nreturn mountComponent;`
  )(document);

  return { component: mountComponent(target), target };
}

test('returns the generated module source and its analyzed payload', () => {
  const { source, payload } = compile(
    '<script>let count = 0; const title = "Total";</script><section><h1>{title}</h1><p>Count: {count + 1}</p></section>'
  );

  assert.match(source, /^export default function mountComponent\(target\)/);

  const section = payload.template.children[0];
  const heading = section.children[0];
  const paragraph = section.children[1];

  // Reactive declarations drive dependency tracking and context getters...
  assert.deepEqual(heading.children[0].dependencies, []);
  assert.deepEqual(paragraph.children[1].dependencies, ['count']);
  assert.match(source, /get count\(\) \{ return count; \}/);
  assert.doesNotMatch(source, /get title\(\)/);

  // ...and ID assignment targets only the element holding the reactive child.
  assert.equal(
    paragraph.attributes.find((attribute) => attribute.name === 'data-wizz-id')?.value,
    '1'
  );
  assert.equal(heading.attributes.find((attribute) => attribute.name === 'data-wizz-id'), undefined);
});

test('emits intercepted mutations and targeted updates in the generated source', () => {
  const { source } = compile(
    '<script>let count = 0; function increment() { count += 1; }</script><button on:click={increment}>Clicks: {count}</button>'
  );

  assert.match(source, /count \+= 1; queueUpdate\(\{ count: true \}\);/);
  assert.match(source, /document\.querySelector\('\[data-wizz-id="1"\]'\)/);
});

test('mounts, updates through events, and destroys against a minimal DOM', () => {
  const document = createDocument();
  const { component, target } = mount(
    `
    <script>
      let count = 0;
      function increment() {
        count += 1;
      }
    </script>
    <main><button on:click={increment}>Clicks: {count}</button></main>
  `,
    document
  );

  const button = target.childNodes[0].childNodes[0];
  assert.equal(button.childNodes[1].nodeValue, '0');

  button.dispatchEvent('click');
  assert.equal(button.childNodes[1].nodeValue, '1');

  component.destroy();
  assert.deepEqual(target.childNodes, []);
});

test('compiles a static component without a script block', () => {
  const { source, payload } = compile('<main><p>Total</p></main>');

  assert.deepEqual(payload.script, []);
  assert.equal(payload.rawScript, '');
  assert.doesNotMatch(source, /data-wizz-id|querySelector/);

  const document = createDocument();
  const { target } = mount('<main><p>Total</p></main>', document);
  assert.equal(target.childNodes[0].childNodes[0].childNodes[0].nodeValue, 'Total');
});

test('propagates compiler errors with their component source locations', () => {
  assert.throws(() => compile('<main><p>{count}</p>'), /Unclosed tag <main> starting at 1:1\./);
  assert.throws(() => compile('<div></span>'), /Mismatched closing tag\. Expected <\/div>, found <\/span> at 1:6\./);
  assert.throws(() => compile('<p>{1 2}</p>'), /Template Expression Error at 1:7 - Unexpected token Number/);
});

test('identifies the input file and source location when compiling from a file', () => {
  const unclosed = (() => {
    try {
      compile('<main><p>{count}</p>', { filePath: 'src/pages/Home.wizz' });
    } catch (error) {
      return error;
    }
  })();

  assert.ok(unclosed instanceof SyntaxError);
  assert.equal(unclosed.filePath, 'src/pages/Home.wizz');
  assert.equal(unclosed.message, 'Unclosed tag <main> starting at src/pages/Home.wizz:1:1.');

  assert.throws(
    () => compile('<div></span>', { filePath: 'Home.wizz' }),
    /found <\/span> at Home\.wizz:1:6\./
  );
  assert.throws(
    () => compile('<p>{1 2}</p>', { filePath: 'Home.wizz' }),
    /Template Expression Error at Home\.wizz:1:7 - Unexpected token Number/
  );
  assert.throws(
    () => compile('Only text', { filePath: 'Home.wizz' }),
    /Home\.wizz: Component template must contain a root element\.$/
  );
});

test('leaves error messages unchanged when no file path is supplied', () => {
  assert.throws(() => compile('<main><p>{count}</p>'), /Unclosed tag <main> starting at 1:1\./);
});

test('rejects non-string component source', () => {
  assert.throws(() => compile(undefined), /Component source must be a string\./);
  assert.throws(() => compile(undefined, { filePath: 'Home.wizz' }), /Home\.wizz: Component source must be a string\.$/);
  assert.throws(() => compile(undefined, null), /Component source must be a string\./);
});

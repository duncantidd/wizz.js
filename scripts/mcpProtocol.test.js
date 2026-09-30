const assert = require('node:assert/strict');
const test = require('node:test');
const {
  SUPPORTED_PROTOCOL_VERSIONS,
  LATEST_PROTOCOL_VERSION,
  MAX_MESSAGE_BYTES,
  ERROR_CODES,
  ToolExecutionError,
  safeJsonParse,
  createProtocolSession
} = require('./mcpProtocol');

function createHarness(toolRegistry) {
  const writes = [];
  const errorLogs = [];
  const session = createProtocolSession({
    serverInfo: { name: 'wizz', title: 'Wizz', version: '9.9.9' },
    instructions: 'Start with project_overview.',
    toolRegistry,
    write: (message) => writes.push(message),
    logger: { error: (line) => errorLogs.push(line) }
  });
  return { session, writes, errorLogs };
}

function defaultRegistry(overrides = {}) {
  return {
    list: () => [{ name: 'demo_tool', description: 'Demo.', inputSchema: { type: 'object' } }],
    has: (name) => name === 'demo_tool',
    call: async (name, args) => ({ text: `called ${name} with ${JSON.stringify(args)}`, structured: { args } }),
    ...overrides
  };
}

async function initializeSession(session, protocolVersion = '2025-06-18') {
  await session.handleMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion, capabilities: {}, clientInfo: { name: 'test-client', version: '0.0.0' } }
  });
  await session.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

test('safeJsonParse parses messages and strips __proto__ keys', () => {
  const parsed = safeJsonParse('{"a":1,"__proto__":{"polluted":true},"nested":{"__proto__":{"x":1},"b":2}}');
  assert.deepEqual(parsed, { ok: true, message: { a: 1, nested: { b: 2 } } });
  assert.deepEqual(safeJsonParse('{not json'), { ok: false });
  assert.deepEqual(safeJsonParse(''), { ok: false });
});

test('rejects unparsable lines with a parse error addressed to null', async () => {
  const { session, writes } = createHarness(defaultRegistry());
  await session.handleLine('{oops');
  assert.deepEqual(writes, [{
    jsonrpc: '2.0',
    id: null,
    error: { code: ERROR_CODES.PARSE, message: 'Message is not valid JSON.' }
  }]);
});

test('rejects lines over the message size limit before parsing them', async () => {
  const { session, writes } = createHarness(defaultRegistry());
  const oversized = 'a'.repeat(MAX_MESSAGE_BYTES + 1);
  assert.equal(Buffer.byteLength(oversized, 'utf8'), MAX_MESSAGE_BYTES + 1);
  await session.handleLine(oversized);
  assert.deepEqual(writes, [{
    jsonrpc: '2.0',
    id: null,
    error: { code: ERROR_CODES.PARSE, message: 'Message exceeds the size limit.' }
  }]);
});

test('ignores whitespace-only lines without a response', async () => {
  const { session, writes } = createHarness(defaultRegistry());
  await session.handleLine('');
  await session.handleLine('   ');
  await session.handleLine('\t');
  assert.deepEqual(writes, []);
});

test('rejects batch, non-object, wrong-jsonrpc, methodless, and null-id messages', async () => {
  const { session, writes } = createHarness(defaultRegistry());
  const invalid = [
    ['["batched"]', 'a JSON array'],
    ['42', 'a number'],
    ['"text"', 'a string'],
    ['{"id":1,"method":"ping"}', 'missing jsonrpc'],
    ['{"jsonrpc":"1.0","id":1,"method":"ping"}', 'wrong version'],
    ['{"jsonrpc":"2.0","id":1}', 'missing method'],
    ['{"jsonrpc":"2.0","id":null,"method":"ping"}', 'null id'],
    ['{"jsonrpc":"2.0","id":true,"method":"ping"}', 'boolean id'],
    ['{"jsonrpc":"2.0","id":{"x":1},"method":"ping"}', 'object id']
  ];
  for (const [line] of invalid) {
    await session.handleLine(line);
  }
  assert.equal(writes.length, invalid.length);
  for (const response of writes) {
    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, null);
    assert.equal(response.error.code, ERROR_CODES.INVALID_REQUEST);
  }
});

test('echoes a supported protocol version verbatim and falls back to the latest', async () => {
  for (const requested of SUPPORTED_PROTOCOL_VERSIONS) {
    const { session, writes } = createHarness(defaultRegistry());
    await session.handleMessage({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: requested } });
    assert.equal(writes[0].result.protocolVersion, requested);
  }
  const { session, writes } = createHarness(defaultRegistry());
  await session.handleMessage({ jsonrpc: '2.0', id: 7, method: 'initialize', params: { protocolVersion: '9999-99-99' } });
  assert.equal(writes[0].result.protocolVersion, LATEST_PROTOCOL_VERSION);
});

test('the initialize result carries the server identity, tool capability, and instructions', async () => {
  const { session, writes } = createHarness(defaultRegistry());
  await session.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  const result = writes[0].result;
  assert.deepEqual(result.serverInfo, { name: 'wizz', title: 'Wizz', version: '9.9.9' });
  assert.deepEqual(result.capabilities, { tools: {} });
  assert.equal(result.instructions, 'Start with project_overview.');
  assert.equal(writes[0].id, 1);
});

test('rejects initialize without string protocolVersion params', async () => {
  const { session, writes } = createHarness(defaultRegistry());
  await session.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await session.handleMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: 2025 } });
  await session.handleMessage({ jsonrpc: '2.0', id: 3, method: 'initialize' });
  assert.deepEqual(writes.map((response) => response.error.code), [ERROR_CODES.INVALID_PARAMS, ERROR_CODES.INVALID_PARAMS, ERROR_CODES.INVALID_PARAMS]);
  // A failed initialize must not advance the session into initializing.
  assert.equal(session.isOperational(), false);
});

test('refuses tool requests before initialization and allows ping anytime', async () => {
  const { session, writes } = createHarness(defaultRegistry());
  await session.handleMessage({ jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.deepEqual(writes[0], { jsonrpc: '2.0', id: 1, result: {} });
  await session.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  await session.handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'demo_tool', arguments: {} } });
  assert.deepEqual(writes.slice(1).map((response) => response.error.code), [
    ERROR_CODES.SERVER_NOT_INITIALIZED,
    ERROR_CODES.SERVER_NOT_INITIALIZED
  ]);
});

test('silently consumes a premature notifications/initialized and only operationalizes the real one', async () => {
  const { session, writes } = createHarness(defaultRegistry());
  // Before initialize: consumed, and the session stays unoperational.
  await session.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.deepEqual(writes, []);
  assert.equal(session.isOperational(), false);
  await initializeSession(session);
  assert.equal(session.isOperational(), true);
});

test('answers tools/list with the registry tools and no pagination', async () => {
  const { session, writes } = createHarness(defaultRegistry());
  await initializeSession(session);
  await session.handleMessage({ jsonrpc: '2.0', id: 5, method: 'tools/list' });
  assert.deepEqual(writes[1], {
    jsonrpc: '2.0',
    id: 5,
    result: { tools: [{ name: 'demo_tool', description: 'Demo.', inputSchema: { type: 'object' } }] }
  });
});

test('answers tools/call with the text/structured envelope and echoes ids unchanged', async () => {
  const { session, writes } = createHarness(defaultRegistry());
  await initializeSession(session);
  await session.handleMessage({ jsonrpc: '2.0', id: 'abc', method: 'tools/call', params: { name: 'demo_tool', arguments: { x: 1 } } });
  await session.handleMessage({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'demo_tool' } });
  assert.deepEqual(writes[1], {
    jsonrpc: '2.0',
    id: 'abc',
    result: {
      content: [{ type: 'text', text: 'called demo_tool with {"x":1}' }],
      structuredContent: { args: { x: 1 } }
    }
  });
  assert.deepEqual(writes[2], {
    jsonrpc: '2.0',
    id: 42,
    result: {
      content: [{ type: 'text', text: 'called demo_tool with {}' }],
      structuredContent: { args: {} }
    }
  });
});

test('marks expected refusals as isError results without a protocol error', async () => {
  const registry = defaultRegistry({
    call: async () => {
      throw new ToolExecutionError('Writes are disabled.');
    }
  });
  const { session, writes } = createHarness(registry);
  await initializeSession(session);
  await session.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'demo_tool', arguments: {} } });
  assert.deepEqual(writes[1], {
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text: 'Writes are disabled.' }], isError: true }
  });
});

test('reports unexpected handler failures as internal errors with the detail logged only', async () => {
  const registry = defaultRegistry({
    call: async () => {
      throw new Error('secret stack detail');
    }
  });
  const { session, writes, errorLogs } = createHarness(registry);
  await initializeSession(session);
  await session.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'demo_tool', arguments: {} } });
  assert.deepEqual(writes[1], {
    jsonrpc: '2.0',
    id: 1,
    error: { code: ERROR_CODES.INTERNAL, message: 'Internal error while executing the tool.' }
  });
  assert.equal(errorLogs.length, 1);
  assert.match(errorLogs[0], /secret stack detail/);
});

test('rejects malformed and unknown tool calls', async () => {
  const { session, writes } = createHarness(defaultRegistry());
  await initializeSession(session);
  await session.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope' } });
  await session.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {} });
  await session.handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call' });
  await session.handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'demo_tool', arguments: 'not an object' } });
  assert.equal(writes[1].error.code, ERROR_CODES.INVALID_PARAMS);
  assert.match(writes[1].error.message, /^Unknown tool: nope$/);
  assert.equal(writes[2].error.code, ERROR_CODES.INVALID_PARAMS);
  assert.equal(writes[3].error.code, ERROR_CODES.INVALID_PARAMS);
  assert.equal(writes[4].error.code, ERROR_CODES.INVALID_PARAMS);
});

test('returns method-not-found for unknown requests after initialization', async () => {
  const { session, writes } = createHarness(defaultRegistry());
  await initializeSession(session);
  await session.handleMessage({ jsonrpc: '2.0', id: 1, method: 'resources/list' });
  assert.deepEqual(writes[1], {
    jsonrpc: '2.0',
    id: 1,
    error: { code: ERROR_CODES.METHOD_NOT_FOUND, message: 'Method not found: resources/list' }
  });
});

test('never responds to a notification, even an unknown one', async () => {
  const { session, writes } = createHarness(defaultRegistry());
  await initializeSession(session);
  const countBefore = writes.length;
  await session.handleMessage({ jsonrpc: '2.0', method: 'notifications/unknown' });
  await session.handleMessage({ jsonrpc: '2.0', method: 'canceled', params: {} });
  assert.equal(writes.length, countBefore);
});

test('answers concurrent requests in completion order with each response carrying its own id', async () => {
  let releaseFirst;
  const firstCall = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const registry = defaultRegistry({
    call: async (name) => {
      if (name === 'slow_tool') {
        await firstCall;
        return { text: 'slow done' };
      }
      return { text: 'fast done' };
    },
    has: (name) => name === 'demo_tool' || name === 'slow_tool'
  });
  const { session, writes } = createHarness(registry);
  await initializeSession(session);
  const first = session.handleMessage({ jsonrpc: '2.0', id: 'slow', method: 'tools/call', params: { name: 'slow_tool', arguments: {} } });
  const second = session.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'demo_tool', arguments: {} } });
  releaseFirst();
  await Promise.all([first, second]);
  // The queued processing order is stable: the slow request's response is
  // written first, and each response carries its own request's id.
  assert.deepEqual(writes.map((response) => response.id), [1, 'slow', 2]);
  assert.equal(writes[1].result.content[0].text, 'slow done');
  assert.equal(writes[2].result.content[0].text, 'fast done');
});
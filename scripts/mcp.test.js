const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { initProject } = require('./init');
const { VERSIONS } = require('../src/compiler');
const { runMcpServer, startMcpServer } = require('./mcp');

function createProjectFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-mcp-server-'));
  initProject(root);
  return root;
}

function createStreamPair() {
  const input = new PassThrough();
  const writes = [];
  const output = {
    write(text) {
      writes.push(text);
    }
  };
  return { input, output, writes };
}

function sendMessage(input, message) {
  input.write(`${JSON.stringify(message)}\n`);
}

async function driveSession(writes) {
  // Convenience accessors over the collected write stream.
  const responses = writes.map((text) => JSON.parse(text));
  return responses;
}

test('a full MCP session runs over injected streams and answers in order', async () => {
  const root = createProjectFixture();
  const { input, output, writes } = createStreamPair();
  const running = runMcpServer({ input, output, projectRoot: root, allowWrite: false });

  sendMessage(input, { jsonrpc: '2.0', id: 'i', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
  sendMessage(input, { jsonrpc: '2.0', method: 'notifications/initialized' });
  sendMessage(input, { jsonrpc: '2.0', id: 'l', method: 'tools/list' });
  sendMessage(input, { jsonrpc: '2.0', id: 'd', method: 'tools/call', params: { name: 'component_diagnostics', arguments: { source: '<main><p>ok</p></main>' } } });
  sendMessage(input, { jsonrpc: '2.0', id: 9, method: 'ping' });
  input.end();

  await running;
  const responses = await driveSession(writes);

  // Every response is a single-line JSON-RPC message with a trailing
  // newline as the only framing.
  for (const text of writes) {
    assert.ok(text.endsWith('\n'));
    assert.ok(!text.slice(0, -1).includes('\n'), 'a response contained a raw newline');
  }
  assert.deepEqual(responses.map((response) => response.id), ['i', 'l', 'd', 9]);
  const initialize = responses[0];
  assert.equal(initialize.result.serverInfo.version, VERSIONS.compiler);
  assert.deepEqual(initialize.result.capabilities, { tools: {} });
  assert.equal(initialize.result.protocolVersion, '2025-06-18');
  const listed = responses[1];
  assert.equal(listed.result.tools.length, 6);
  const diagnostics = responses[2];
  assert.equal(diagnostics.result.structuredContent.ok, true);
  assert.equal(diagnostics.result.content[0].type, 'text');
  assert.equal(typeof diagnostics.result.content[0].text, 'string');
  assert.deepEqual(responses[3].result, {});

  fs.rmSync(root, { recursive: true, force: true });
});

test('a broken project root rejects the session before any stream is touched', async () => {
  const missing = path.join(os.tmpdir(), 'wizz-mcp-server-missing');
  fs.rmSync(missing, { recursive: true, force: true });
  await assert.rejects(
    runMcpServer({ input: new PassThrough(), output: { write() {} }, projectRoot: missing }),
    /Project root does not exist/
  );
});

test('startMcpServer refuses a non-existent project root with a clear message', async () => {
  const missing = path.join(os.tmpdir(), 'wizz-mcp-start-missing');
  fs.rmSync(missing, { recursive: true, force: true });
  await assert.rejects(
    startMcpServer({ projectRoot: missing, logger: { error() {} } }),
    (error) => {
      assert.match(error.message, /does not exist or is not a directory/);
      return true;
    }
  );
});

test('the spawned server keeps stdout protocol-pure end to end', () => {
  const root = createProjectFixture();
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'project_overview', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'build_project', arguments: {} } },
    { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 999 } }
  ];
  const input = messages.map((message) => `${JSON.stringify(message)}\n`).join('');
  const result = spawnSync(process.execPath, [path.join(__dirname, 'mcp.js')], {
    cwd: root,
    input,
    encoding: 'utf8',
    timeout: 120000
  });

  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const stdoutLines = result.stdout.split('\n').filter((line) => line !== '');
  // The stdout-pollution proof: every single line must parse as a JSON-RPC
  // message, whatever any transitively imported module printed.
  const responses = stdoutLines.map((line) => {
    const parsed = JSON.parse(line);
    assert.equal(parsed.jsonrpc, '2.0');
    return parsed;
  });
  assert.deepEqual(responses.map((response) => response.id), [1, 2, 3, 4]);
  assert.equal(responses[0].result.serverInfo.version, VERSIONS.compiler);
  assert.equal(responses[1].result.tools.length, 6);
  assert.equal(responses[2].result.structuredContent.inputDirectory, 'src');
  assert.equal(responses[3].result.structuredContent.ok, true);
  // The stderr banner is information, never protocol.
  assert.match(result.stderr, /Wizz MCP server listening on stdio/);

  fs.rmSync(root, { recursive: true, force: true });
});
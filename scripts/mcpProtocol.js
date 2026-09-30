// The MCP wire protocol session for the Wizz MCP server (`wizz mcp`).
//
// The Model Context Protocol's stdio transport is newline-delimited JSON-RPC
// 2.0 on the process's stdin/stdout: one message per line, UTF-8, no
// Content-Length framing. This module implements that session as a pure
// layer — no fs, no compiler, no real streams — so tests drive a full
// conversation in-process through injected `write` and `logger` functions
// (the same dependency-injection discipline as `runCli` in scripts/cli.js).
// scripts/mcp.js wires this session to the real stdio streams.
//
// Two rules shape everything here:
//
// 1. stdout is protocol-only. Every non-protocol byte a transitively
//    imported module writes to stdout corrupts the agent's stream, so this
//    layer never logs to stdout and surfaces diagnostics through the
//    injected logger only (the adapter redirects them to stderr).
// 2. Input is untrusted. Messages arrive from an external agent process, so
//    parsing strips `__proto__` keys (prototype pollution), field access is
//    limited to declared keys, and oversized lines are rejected before
//    parsing allocates on their behalf.

const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2025-03-26', '2025-06-18']);
const LATEST_PROTOCOL_VERSION = '2025-06-18';

// stdin lines are capped so a hostile client cannot make the server parse
// arbitrarily large payloads: an over-limit line is a parse error, not a
// crash or an OOM vector.
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

const ERROR_CODES = Object.freeze({
  SERVER_NOT_INITIALIZED: -32002,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  PARSE: -32700
});

/**
 * An expected tool refusal: a rejected path, a disabled write mode, a failed
 * compile gate. The session turns these into a `tools/call` result with
 * `isError: true` carrying the user-facing message — not a protocol error —
 * because the protocol exchange itself is healthy. Any other error from a
 * handler is a server bug and becomes -32603 with the detail logged only.
 */
class ToolExecutionError extends Error {}

/**
 * Parses a JSON message with prototype pollution neutralized: a reviver that
 * drops `__proto__` keys keeps a crafted `{"__proto__": {...}}` payload from
 * ever materializing an own property, whatever JSON.parse's own-property
 * semantics do with it.
 * @param {string} text - The raw JSON text.
 * @returns {{ ok: true, message: any } | { ok: false }}
 */
function safeJsonParse(text) {
  try {
    const message = JSON.parse(text, (key, value) => (key === '__proto__' ? undefined : value));
    return { ok: true, message };
  } catch {
    return { ok: false };
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRequestId(value) {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function createProtocolSession({ serverInfo, instructions, toolRegistry, write, logger }) {
  if (typeof write !== 'function') {
    throw new TypeError('The protocol session requires an injected write function.');
  }
  const log = logger || { error() {}, warn() {} };
  // Phases: awaiting-initialize -> initializing (initialize answered)
  //         -> operational (notifications/initialized received).
  // The spec lets the server answer only `ping` before it is operational;
  // everything else is refused with the standard not-initialized code.
  let phase = 'awaiting-initialize';
  // Lines are processed in arrival order through one promise chain so
  // responses are written atomically and in order, never interleaved.
  let queue = Promise.resolve();

  function respond(id, result) {
    write({ jsonrpc: '2.0', id, result });
  }

  function respondError(id, code, message) {
    write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  function toolResult(result) {
    const payload = { content: [{ type: 'text', text: result.text }] };
    if (result.structured !== undefined) payload.structuredContent = result.structured;
    if (result.isError === true) payload.isError = true;
    return payload;
  }

  function handleInitialize(id, message) {
    if (!isPlainObject(message.params) || typeof message.params.protocolVersion !== 'string') {
      respondError(id, ERROR_CODES.INVALID_PARAMS, 'Initialize requires params.protocolVersion as a string.');
      return;
    }
    // If the client's requested version is supported it is echoed verbatim;
    // otherwise the server responds with the latest version it supports and
    // an incompatible client disconnects (MCP lifecycle negotiation).
    const requested = message.params.protocolVersion;
    const negotiated = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : LATEST_PROTOCOL_VERSION;
    phase = 'initializing';
    respond(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo,
      instructions
    });
  }

  async function dispatchRequest(id, message) {
    const method = message.method;
    if (method === 'initialize') {
      handleInitialize(id, message);
      return;
    }
    if (method === 'ping') {
      respond(id, {});
      return;
    }
    if (phase !== 'operational') {
      respondError(id, ERROR_CODES.SERVER_NOT_INITIALIZED, 'Server not initialized.');
      return;
    }
    if (method === 'tools/list') {
      respond(id, { tools: toolRegistry.list() });
      return;
    }
    if (method === 'tools/call') {
      const params = message.params;
      if (!isPlainObject(params) || typeof params.name !== 'string') {
        respondError(id, ERROR_CODES.INVALID_PARAMS, 'Tools/call requires params.name as a string.');
        return;
      }
      if (params.arguments !== undefined && !isPlainObject(params.arguments)) {
        respondError(id, ERROR_CODES.INVALID_PARAMS, 'Tools/call arguments must be an object.');
        return;
      }
      if (!toolRegistry.has(params.name)) {
        respondError(id, ERROR_CODES.INVALID_PARAMS, `Unknown tool: ${params.name}`);
        return;
      }
      try {
        const result = await toolRegistry.call(params.name, params.arguments || {});
        respond(id, toolResult(result));
      } catch (error) {
        if (error instanceof ToolExecutionError) {
          respond(id, toolResult({ text: error.message, isError: true }));
          return;
        }
        log.error(`Tools/call '${params.name}' failed unexpectedly: ${error && error.stack ? error.stack : error}`);
        respondError(id, ERROR_CODES.INTERNAL, 'Internal error while executing the tool.');
      }
      return;
    }
    respondError(id, ERROR_CODES.METHOD_NOT_FOUND, `Method not found: ${method}`);
  }

  function dispatchNotification(message) {
    // Notifications never get a response — not even errors. Only
    // notifications/initialized advances the state machine; every other
    // notification is consumed silently.
    if (phase === 'initializing' && message.method === 'notifications/initialized') {
      phase = 'operational';
    }
  }

  async function handleMessage(message) {
    if (!isPlainObject(message)) {
      respondError(null, ERROR_CODES.INVALID_REQUEST, 'Request must be a JSON-RPC 2.0 object.');
      return;
    }
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      respondError(null, ERROR_CODES.INVALID_REQUEST, 'Request must carry jsonrpc "2.0" and a string method.');
      return;
    }
    // MCP messages are never batched (a batch is an Array, already refused
    // above), and a null id is invalid: it is flatly an invalid request.
    if ('id' in message && message.id === null) {
      respondError(null, ERROR_CODES.INVALID_REQUEST, 'Request id must not be null.');
      return;
    }
    if (message.id !== undefined && !isRequestId(message.id)) {
      respondError(null, ERROR_CODES.INVALID_REQUEST, 'Request id must be a string or a number.');
      return;
    }
    if (message.id === undefined) {
      dispatchNotification(message);
      return;
    }
    await dispatchRequest(message.id, message);
  }

  async function processLine(line) {
    // Whitespace-only lines are transport noise, not protocol errors: an
    // agent's writer may emit blank lines around flushes.
    if (line.trim() === '') return;
    if (Buffer.byteLength(line, 'utf8') > MAX_MESSAGE_BYTES) {
      log.error(`Rejected an MCP message over the ${MAX_MESSAGE_BYTES} byte limit.`);
      respondError(null, ERROR_CODES.PARSE, 'Message exceeds the size limit.');
      return;
    }
    const parsed = safeJsonParse(line);
    if (!parsed.ok) {
      respondError(null, ERROR_CODES.PARSE, 'Message is not valid JSON.');
      return;
    }
    await handleMessage(parsed.message);
  }

  return {
    /**
     * Handles one raw stdin line: size cap, parse, validate, dispatch.
     * @param {string} line - The raw line (without its newline).
     * @returns {Promise<void>}
     */
    handleLine(line) {
      queue = queue.then(() => processLine(line)).catch((error) => {
        // A rejection escaping processLine must never poison the queue:
        // every later message would otherwise be swallowed forever. The
        // last-resort response is attempted, but a failing transport (a
        // broken pipe, say) must not throw out of this catch either.
        log.error(`Internal error while handling an MCP message: ${error && error.stack ? error.stack : error}`);
        try {
          respondError(null, ERROR_CODES.INTERNAL, 'Internal error while handling a message.');
        } catch {
          // The transport itself is failing; logging is all that is left.
        }
      });
      return queue;
    },
    /**
     * Handles an already-parsed message object (used by tests and by the
     * adapter when it wants to bypass the framing layer).
     * @param {any} message - The parsed JSON-RPC message.
     * @returns {Promise<void>}
     */
    handleMessage(message) {
      queue = queue.then(() => handleMessage(message)).catch((error) => {
        // Same queue-preservation contract as handleLine above.
        log.error(`Internal error while handling an MCP message: ${error && error.stack ? error.stack : error}`);
        try {
          respondError(null, ERROR_CODES.INTERNAL, 'Internal error while handling a message.');
        } catch {
          // The transport itself is failing; logging is all that is left.
        }
      });
      return queue;
    },
    isOperational() {
      return phase === 'operational';
    }
  };
}

module.exports = {
  SUPPORTED_PROTOCOL_VERSIONS,
  LATEST_PROTOCOL_VERSION,
  MAX_MESSAGE_BYTES,
  ERROR_CODES,
  ToolExecutionError,
  safeJsonParse,
  createProtocolSession
};
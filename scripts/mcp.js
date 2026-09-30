// The stdio adapter for the Wizz MCP server and its CLI entry point.
//
// This module is deliberately thin: scripts/mcpProtocol.js owns the
// JSON-RPC session and scripts/mcpTools.js owns the tools and their
// security guards. What remains here is wiring the session to the real
// stdio streams — one line per message in, one JSON.stringify per response
// out — plus the startup configuration (`--root`, `--allow-write`) and the
// stdout-purity guarantee.
//
// stdout purity is enforced in three layers. First, every module the
// server transitively imports routes human output through an injected
// logger (verified for build.js; the MCP build tool passes a silent one).
// Second, `startMcpServer` redirects the global console methods to stderr
// for the server's lifetime, so an unlogged `console.log` anywhere in a
// future dependency still cannot corrupt the agent's stream. Third, the
// spawned smoke test in mcp.test.js proves every byte on stdout parses as
// a JSON-RPC message.

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { createProtocolSession } = require('./mcpProtocol');
const { createToolRegistry } = require('./mcpTools');
const { VERSIONS } = require('../src/compiler');

const SERVER_INSTRUCTIONS =
  'This is the Wizz MCP server for one Wizz application project. Start with ' +
  'project_overview, read language_contract before authoring or editing any ' +
  'component, and use component_diagnostics to check proposed sources before ' +
  'asking create_or_update_component to write them. Component writes are ' +
  'refused unless the server was started with --allow-write, and every write ' +
  'is compile-gated.';

function createServerInfo() {
  return { name: 'wizz', title: 'Wizz', version: VERSIONS.compiler };
}

/**
 * Runs one MCP session over injected streams, resolving when the input
 * ends. Client shutdown is EOF on stdin (the spec's stdio close); the
 * process's default signal termination is the fallback for SIGINT/SIGTERM.
 * Fatal startup errors (an unusable project root) reject.
 * @param {Object} [options]
 * @param {NodeJS.ReadableStream} [options.input] - Defaults to process.stdin.
 * @param {NodeJS.WritableStream} [options.output] - Defaults to process.stdout.
 * @param {string} options.projectRoot - The absolute project directory.
 * @param {boolean} [options.allowWrite=false] - Enable component writes.
 * @param {Object} [options.logger] - Receives protocol diagnostics (stderr).
 * @returns {Promise<void>}
 */
async function runMcpServer({ input = process.stdin, output = process.stdout, projectRoot, allowWrite = false, logger = console } = {}) {
  // The registry validates the root before the session exists, so a bad
  // root fails fast without ever touching the streams.
  const toolRegistry = createToolRegistry({ root: projectRoot, allowWrite });
  const session = createProtocolSession({
    serverInfo: createServerInfo(),
    instructions: SERVER_INSTRUCTIONS,
    toolRegistry,
    logger,
    write: (message) => {
      // JSON.stringify emits no raw newlines, so each write is exactly one
      // stdio message; the trailing newline is the transport framing.
      output.write(`${JSON.stringify(message)}\n`);
    }
  });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  return new Promise((resolve, reject) => {
    lines.on('line', (line) => {
      session.handleLine(line);
    });
    input.on('error', reject);
    lines.on('close', resolve);
  });
}

/**
 * The CLI-facing entry point: validates the project root, pins stdout
 * purity for the whole process, and runs the session on the real streams.
 * @param {Object} options
 * @param {string} options.projectRoot - The resolved project directory.
 * @param {boolean} [options.allowWrite=false]
 * @param {Object} [options.logger] - Defaults to the (redirected) console.
 * @returns {Promise<void>} Resolves on client EOF; rejects on fatal errors.
 */
async function startMcpServer({ projectRoot, allowWrite = false, logger = console } = {}) {
  if (typeof projectRoot !== 'string' || projectRoot === '') {
    throw new Error('The MCP server requires a project root directory.');
  }
  const stat = fs.statSync(projectRoot, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory()) {
    throw new Error(`Project root does not exist or is not a directory: ${projectRoot}`);
  }

  // From here on stdout belongs to the protocol: send stray console output
  // to stderr so a future dependency cannot corrupt the agent's stream.
  for (const method of ['log', 'info', 'warn']) {
    console[method] = (...args) => process.stderr.write(`${args.join(' ')}\n`);
  }
  logger.error(`Wizz MCP server listening on stdio (root: ${projectRoot}, writes: ${allowWrite ? 'enabled' : 'disabled'}).`);
  await runMcpServer({ projectRoot, allowWrite, logger });
}

if (require.main === module) {
  // Direct invocation (`node scripts/mcp.js`): serve the working directory
  // with writes disabled — the conservative default. The CLI adds --root
  // and --allow-write on top of the same entry point.
  startMcpServer({ projectRoot: path.resolve(process.cwd()), allowWrite: false }).then(
    () => { process.exitCode = 0; },
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    }
  );
}

module.exports = { SERVER_INSTRUCTIONS, runMcpServer, startMcpServer };
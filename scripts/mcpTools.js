// The Wizz tool registry and security guards for the MCP server.
//
// Every tool the Wizz MCP server exposes lives here, behind one registry
// object the protocol session calls: list() (tools/list descriptors),
// has(name), and call(name, arguments). Handlers receive the project root
// and the write-permission flag from the startup configuration — never from
// the agent — so the project boundary and the write opt-in are fixed for
// the server's lifetime (the spec's client-controlled `roots` capability is
// deliberately unused).
//
// Security posture, in order of the layers that enforce it:
//
// 1. Project scoping: every filesystem path a tool touches is resolved
//    against the root and refused if it escapes — lexically
//    (`resolveInsideRoot`) and through the real filesystem, so symlinks and
//    symlinked ancestor directories cannot smuggle a path outside
//    (`realpathInsideRoot`).
// 2. Write hardening: writes require the explicit startup `--allow-write`
//    opt-in, target only `.wizz` files, refuse managed trees
//    (`dist/`, `node_modules/`, `.git/`, `release/`, `vscode-extension/`),
//    refuse symbolic-link targets, and cap source size.
// 3. Compile gate: a proposed component source is compiled in collect mode
//    before anything touches the disk; a source with error-severity
//    diagnostics is refused with the records echoed and no write.
// 4. Input hygiene: tool arguments are read by declared key only and are
//    never merged or spread, so a hostile `__proto__` key in `arguments`
//    (already stripped at parse time by the protocol layer) has no surface.

const fs = require('node:fs');
const path = require('node:path');
const { compile, VERSIONS } = require('../src/compiler');
const {
  BUILD_DIAGNOSTICS_FORMAT,
  buildProject,
  discoverWizzFiles,
  getRoutePath,
  KNOWN_ADAPTERS
} = require('../build');
const { discoverApiRoutes } = require('./apiRoutes');
const { ToolExecutionError } = require('./mcpProtocol');

const DEFAULT_INPUT_DIRECTORY = 'src';
const DEFAULT_OUTPUT_DIRECTORY = 'dist';

// A write tool input cap: a component source larger than this is almost
// certainly a mistake (an entire page dump, a binary), and refusing it keeps
// one write call from materializing an arbitrary-size file.
const MAX_SOURCE_BYTES = 256 * 1024;

// First-segment denylist for the write tool: these project-root trees are
// build output, dependency, or tooling territory, and no agent-authored
// component belongs in them.
const WRITE_DENIED_ROOT_DIRECTORIES = Object.freeze([
  'dist',
  'node_modules',
  '.git',
  'release',
  'vscode-extension'
]);

// ---------------------------------------------------------------------------
// Path guards
// ---------------------------------------------------------------------------

function toPosixPath(relativePath) {
  return relativePath.split(path.sep).join('/');
}

/**
 * Lexical containment: resolves `relativePath` against `root` and refuses
 * absolute paths, traversal (`..`), and the root itself. Pure string
 * arithmetic — the filesystem-level escape (symlinks) is the next layer's
 * job.
 * @param {string} root - The absolute project root.
 * @param {string} relativePath - The agent-supplied path.
 * @returns {{ ok: true, absolutePath: string, relativePosix: string } | { ok: false, reason: string }}
 */
function resolveInsideRoot(root, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.trim() === '') {
    return { ok: false, reason: 'A non-empty path relative to the project root is required.' };
  }
  if (path.isAbsolute(relativePath)) {
    return { ok: false, reason: `Path must be relative to the project root: ${relativePath}` };
  }
  const absolutePath = path.resolve(root, relativePath);
  const relative = path.relative(root, absolutePath);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { ok: false, reason: `Path must stay inside the project root: ${relativePath}` };
  }
  return { ok: true, absolutePath, relativePosix: toPosixPath(relative) };
}

/**
 * Filesystem containment: walks up from `absolutePath` to the nearest
 * existing ancestor, realpaths it, rejoins the non-existent remainder, and
 * re-checks containment against the real root. This catches a symlinked
 * target and a symlinked ancestor directory alike — escapes the lexical
 * check cannot see.
 * @param {string} root - The absolute project root.
 * @param {string} absolutePath - An already lexically-contained path.
 * @returns {{ ok: true, realPath: string } | { ok: false, reason: string }}
 */
function realpathInsideRoot(root, absolutePath) {
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return { ok: false, reason: `Project root does not exist or is not readable: ${root}` };
  }
  let probe = absolutePath;
  const missing = [];
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) {
      return { ok: false, reason: `Path does not resolve inside the project root: ${absolutePath}` };
    }
    missing.unshift(path.basename(probe));
    probe = parent;
  }
  let realPath;
  try {
    realPath = fs.realpathSync(probe);
  } catch {
    return { ok: false, reason: `Path cannot be resolved: ${absolutePath}` };
  }
  if (missing.length > 0) {
    realPath = path.join(realPath, ...missing);
  }
  const relative = path.relative(realRoot, realPath);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { ok: false, reason: `Path resolves outside the project root through the filesystem: ${absolutePath}` };
  }
  return { ok: true, realPath };
}

/**
 * Read-side gate for `.wizz` components: lexical containment, filesystem
 * containment, and the `.wizz` extension. No denylist — reading is safe
 * anywhere inside the root.
 * @param {string} root - The absolute project root.
 * @param {string} relativePath - The agent-supplied path.
 * @returns {{ ok: true, absolutePath: string, relativePosix: string } | { ok: false, reason: string }}
 */
function assertReadableComponentPath(root, relativePath) {
  const lexical = resolveInsideRoot(root, relativePath);
  if (!lexical.ok) return lexical;
  if (path.extname(lexical.relativePosix) !== '.wizz') {
    return { ok: false, reason: `Path must be a .wizz component file: ${relativePath}` };
  }
  const real = realpathInsideRoot(root, lexical.absolutePath);
  if (!real.ok) return real;
  return lexical;
}

/**
 * Write-side gate: everything the read gate checks, plus the source size
 * cap, the managed-tree denylist, and the symbolic-link refusal (a final
 * segment that is itself a symlink — including a dangling one — is refused;
 * existing symlink targets are caught by the realpath walk).
 * @param {string} root - The absolute project root.
 * @param {string} relativePath - The agent-supplied target path.
 * @param {string} source - The proposed component source.
 * @returns {{ ok: true, absolutePath: string, relativePosix: string } | { ok: false, reason: string }}
 */
function assertWritableComponentPath(root, relativePath, source) {
  const sourceBytes = Buffer.byteLength(source, 'utf8');
  if (sourceBytes > MAX_SOURCE_BYTES) {
    return { ok: false, reason: `Component source exceeds the ${MAX_SOURCE_BYTES} byte limit (${sourceBytes} bytes).` };
  }
  const lexical = resolveInsideRoot(root, relativePath);
  if (!lexical.ok) return lexical;
  if (path.extname(lexical.relativePosix) !== '.wizz') {
    return { ok: false, reason: `Write target must be a .wizz component file: ${relativePath}` };
  }
  const firstSegment = lexical.relativePosix.split('/')[0];
  if (WRITE_DENIED_ROOT_DIRECTORIES.includes(firstSegment)) {
    return { ok: false, reason: `Write target is inside the managed '${firstSegment}/' tree: ${relativePath}` };
  }
  // lstat the final segment unconditionally — existsSync returns false for
  // a dangling symlink, and a write must never follow one out of the root.
  try {
    if (fs.lstatSync(lexical.absolutePath).isSymbolicLink()) {
      return { ok: false, reason: `Write target is a symbolic link: ${relativePath}` };
    }
  } catch {
    // The target does not exist (the usual create case, or it vanished
    // between the checks): the realpath walk below re-establishes the
    // ground truth.
  }
  const real = realpathInsideRoot(root, lexical.absolutePath);
  if (!real.ok) return real;
  return lexical;
}

/**
 * Compiles proposed component source in collect mode. Collect mode never
 * throws for compile failures, so a clean source yields
 * `{ ok: true, diagnostics: [] }` and a broken one yields every
 * error-severity record for the caller to echo.
 * @param {string} source - The proposed component source.
 * @param {string} filePathLabel - The label diagnostics are qualified with.
 * @returns {{ ok: boolean, diagnostics: Array<{ code, severity, message, file, line, column }> }}
 */
function compileGate(source, filePathLabel) {
  const result = compile(source, { filePath: filePathLabel, diagnostics: 'collect' });
  const diagnostics = result.diagnostics || [];
  return { ok: diagnostics.length === 0, diagnostics };
}

/**
 * The init scaffold contract: a Wizz project has an `index.html` document
 * shell or a source directory at its root.
 * @param {string} root - The absolute project root.
 * @returns {boolean}
 */
function looksLikeWizzProject(root) {
  return fs.existsSync(path.join(root, 'index.html')) || fs.existsSync(path.join(root, 'src'));
}

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

function requireString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolExecutionError(`${fieldName} must be a non-empty string.`);
  }
  return value;
}

function optionalString(value, fallback, fieldName) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolExecutionError(`${fieldName} must be a non-empty string.`);
  }
  return value;
}

function resolveInputDirectory(root, rawInputDirectory) {
  const inputDirectory = optionalString(rawInputDirectory, DEFAULT_INPUT_DIRECTORY, 'inputDirectory');
  const guard = resolveInsideRoot(root, inputDirectory);
  if (!guard.ok) throw new ToolExecutionError(guard.reason);
  return guard;
}

function formatDiagnostic(diagnostic) {
  const location = diagnostic.line === null
    ? diagnostic.file || '(unknown file)'
    : `${diagnostic.file || '(unknown file)'}:${diagnostic.line}:${diagnostic.column}`;
  return `${diagnostic.code || 'WIZZ-?'} [${diagnostic.severity}] ${location} — ${diagnostic.message}`;
}

function diagnosticsText(diagnostics) {
  if (diagnostics.length === 0) return 'No diagnostics.';
  return diagnostics.map((diagnostic) => formatDiagnostic(diagnostic)).join('\n');
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

/**
 * Surveys the project: components, routes, API routes, document shell,
 * build output, adapters, and the version contract.
 */
async function projectOverviewHandler(args, { root }) {
  const input = resolveInputDirectory(root, args.inputDirectory);
  const components = [];
  let discoveryError;
  try {
    for (const inputPath of discoverWizzFiles(input.absolutePath)) {
      components.push({
        file: toPosixPath(path.relative(input.absolutePath, inputPath)),
        route: getRoutePath(input.absolutePath, inputPath)
      });
    }
  } catch (error) {
    discoveryError = error.message;
  }
  let apiRoutes = [];
  try {
    // The build's own convention: API handlers live below <input>/server/api.
    apiRoutes = [...discoverApiRoutes(path.join(input.absolutePath, 'server', 'api')).values()]
      .map((route) => ({
        routePath: route.routePath,
        filePath: toPosixPath(path.relative(input.absolutePath, route.modulePath))
      }));
  } catch (error) {
    discoveryError = discoveryError ? `${discoveryError}; ${error.message}` : error.message;
  }
  const overview = {
    root,
    inputDirectory: input.relativePosix,
    versions: { ...VERSIONS },
    documentShell: fs.existsSync(path.join(root, 'index.html')),
    distPresent: fs.existsSync(path.join(root, DEFAULT_OUTPUT_DIRECTORY)) &&
      fs.statSync(path.join(root, DEFAULT_OUTPUT_DIRECTORY)).isDirectory(),
    adapters: [...KNOWN_ADAPTERS],
    components,
    apiRoutes,
    ...(discoveryError ? { discoveryError } : {})
  };
  const routed = components.filter((component) => component.route !== null);
  const text = [
    `Wizz ${overview.versions.compiler} (syntax ${overview.versions.syntax}, output ${overview.versions.output})`,
    `Components: ${components.length} (${routed.length} routed: ${routed.map((component) => component.route).join(', ') || 'none'})`,
    `API routes: ${apiRoutes.map((route) => route.routePath).join(', ') || 'none'}`,
    `Document shell (index.html): ${overview.documentShell ? 'present' : 'missing'}`,
    `dist/ build output: ${overview.distPresent ? 'present' : 'absent'}`,
    `Known adapters: ${overview.adapters.join(', ')}`,
    ...(discoveryError ? [`Discovery error: ${discoveryError}`] : [])
  ].join('\n');
  return { text, structured: overview };
}

/**
 * Compiles a component — from disk, from inline source, or every component
 * in the input directory — and returns the structured diagnostic records.
 * Client-target only by design: full server-eligibility analysis belongs to
 * the build tool, whose envelope reports eligibility per file.
 */
async function componentDiagnosticsHandler(args, { root }) {
  // Target selection: `all` excludes everything else; `source` compiles
  // inline text with an optional `path` label; a bare `path` compiles that
  // project file. The `path` key therefore doubles as a label, not a second
  // target.
  if (args.all !== undefined && (args.path !== undefined || args.source !== undefined)) {
    throw new ToolExecutionError('The all option excludes path and source.');
  }
  if (args.all === undefined && args.source === undefined && args.path === undefined) {
    throw new ToolExecutionError('Provide exactly one of path, source, or all.');
  }

  if (args.all !== undefined) {
    if (args.all !== true) {
      throw new ToolExecutionError('The all option must be true when present.');
    }
    const input = resolveInputDirectory(root, args.inputDirectory);
    const files = [];
    let discoveryError;
    try {
      for (const inputPath of discoverWizzFiles(input.absolutePath)) {
        const relativePosix = toPosixPath(path.relative(input.absolutePath, inputPath));
        let source;
        try {
          source = fs.readFileSync(inputPath, 'utf8');
        } catch (error) {
          files.push({
            file: relativePosix,
            ok: false,
            diagnostics: [{ code: null, severity: 'error', message: error.message, file: relativePosix, line: null, column: null }]
          });
          continue;
        }
        const gate = compileGate(source, relativePosix);
        files.push({ file: relativePosix, ok: gate.ok, diagnostics: gate.diagnostics });
      }
    } catch (error) {
      discoveryError = error.message;
    }
    const ok = !discoveryError && files.every((entry) => entry.ok);
    const text = [
      `Compiled ${files.length} component(s) under ${input.relativePosix}: ${ok ? 'all clean' : `${files.filter((entry) => !entry.ok).length} with diagnostics`}`,
      ...(discoveryError ? [`Discovery error: ${discoveryError}`] : []),
      ...files.filter((entry) => !entry.ok).map((entry) => `${entry.file}:\n${diagnosticsText(entry.diagnostics)}`)
    ].join('\n');
    return {
      text,
      structured: {
        target: 'all',
        inputDirectory: input.relativePosix,
        ok,
        files,
        ...(discoveryError ? { discoveryError } : {})
      }
    };
  }

  if (args.source !== undefined) {
    const source = args.source;
    if (typeof source !== 'string') {
      throw new ToolExecutionError('source must be a string.');
    }
    // An optional path label qualifies diagnostic locations; it is a label,
    // not a file read, so it is not path-guarded.
    const label = args.path === undefined ? 'inline.wizz' : requireString(args.path, 'path');
    const gate = compileGate(source, label);
    return {
      text: `${label}: ${gate.ok ? 'no diagnostics' : `${gate.diagnostics.length} diagnostic(s)`}\n${diagnosticsText(gate.diagnostics)}`,
      structured: { target: label, ok: gate.ok, diagnostics: gate.diagnostics }
    };
  }

  const guard = assertReadableComponentPath(root, requireString(args.path, 'path'));
  if (!guard.ok) throw new ToolExecutionError(guard.reason);
  if (!fs.existsSync(guard.absolutePath)) {
    throw new ToolExecutionError(`Component file not found: ${guard.relativePosix}`);
  }
  const source = fs.readFileSync(guard.absolutePath, 'utf8');
  const gate = compileGate(source, guard.relativePosix);
  return {
    text: `${guard.relativePosix}: ${gate.ok ? 'no diagnostics' : `${gate.diagnostics.length} diagnostic(s)`}\n${diagnosticsText(gate.diagnostics)}`,
    structured: { target: guard.relativePosix, ok: gate.ok, diagnostics: gate.diagnostics }
  };
}

/**
 * Runs the project build in-process with the machine-readable envelope.
 * Directories are project-scoped like every other path; the silent logger
 * keeps stdout (and the injected write stream) protocol-pure.
 */
async function buildProjectHandler(args, { root }) {
  const input = resolveInputDirectory(root, args.inputDirectory);
  const outputDirectory = optionalString(args.outputDirectory, DEFAULT_OUTPUT_DIRECTORY, 'outputDirectory');
  const output = resolveInsideRoot(root, outputDirectory);
  if (!output.ok) throw new ToolExecutionError(output.reason);
  const inputReal = realpathInsideRoot(root, input.absolutePath);
  if (!inputReal.ok) throw new ToolExecutionError(inputReal.reason);
  const outputReal = realpathInsideRoot(root, output.absolutePath);
  if (!outputReal.ok) throw new ToolExecutionError(outputReal.reason);
  if (output.absolutePath === input.absolutePath) {
    throw new ToolExecutionError('Input and output directories must be different.');
  }
  let adapter = null;
  if (args.adapter !== undefined) {
    if (typeof args.adapter !== 'string' || !KNOWN_ADAPTERS.includes(args.adapter)) {
      throw new ToolExecutionError(`Unknown adapter '${args.adapter}'. Known adapters: ${KNOWN_ADAPTERS.join(', ')}.`);
    }
    adapter = args.adapter;
  }
  const result = buildProject(input.absolutePath, output.absolutePath, { log() {}, error() {} }, {
    json: true,
    ...(adapter ? { adapter } : {})
  });
  const structured = {
    format: BUILD_DIAGNOSTICS_FORMAT,
    ok: result.ok,
    compiledCount: result.compiledCount,
    failedCount: result.failedCount,
    diagnostics: result.diagnostics,
    files: result.files,
    ...(adapter ? { adapter } : {})
  };
  const text = [
    `Build ${result.ok ? 'succeeded' : 'failed'}: ${result.compiledCount} compiled, ${result.failedCount} failed.`,
    diagnosticsText(result.diagnostics),
    `Output: ${output.relativePosix}/`
  ].join('\n');
  return { text, structured };
}

/**
 * The component language contract: what a .wizz file may contain, the
 * lifecycle hooks, and where the stable diagnostic codes live. The content
 * is an inline string — it ships in the CLI tarball by construction, needs
 * no file resolution, and its tests pin the version triple so a version
 * bump cannot silently desync the documentation from the compiler.
 */
function languageContractHandler() {
  return {
    text: `Wizz component language contract (compiler ${VERSIONS.compiler}, syntax ${VERSIONS.syntax}, output ${VERSIONS.output})

A .wizz component has a template and an optional <script> block. The template
must contain exactly one root element. Top-level optional blocks: <wizz:style>
(one, raw CSS, scoped per component) and <wizz:head> (one; only <title>,
<meta>, and <link> children).

Script boundary (inside <script>):
- let declarations are reactive state: template expressions update when a
  handler mutates them (batched, applied on the next microtask).
- export let declares a prop the parent passes as an attribute on the
  component tag; props are reactive and read-only in the child. A bare
  declaration defaults to undefined.
- let initialized with persist(key, default) survives refreshes and stays
  reactive across browser tabs via localStorage; only a top-level let may
  use it.
- Named functions are handlers; onMount(fn) and onDestroy(fn) register
  lifecycle hooks (no import needed). onMount runs after the component is
  attached and its children mounted; onDestroy runs before teardown.
  Assignments inside statement-level hook callbacks are reactive.

Template expressions ({...}) use a safe subset: identifiers, member access,
string and number literals, and strict equality — no arbitrary JS. Text
output escapes &, <, >; attribute values additionally escape ".

Directives:
- on:<event>={handler} — native browser event names; client-only.
- {#if condition} ... {:else} ... {/if} — branch chosen at mount time.
- {#each items as item (item.id)} ... {/each} — keyed, or keyless for
  positional identity. The collection must be a reactive let, the block
  must sit inside a native element, and the body must contain exactly one
  native root element. Each bodies do not support components, on:
  directives, or nested blocks (compile-time errors, never silent).

Components:
- Import a component with a default import from a .wizz path and render it
  self-closing inside a native element (<Counter />). Imported component
  tags take no children or event directives; attributes pass as props.

Stable diagnostics: every author-facing compile failure carries a code —
WIZZ-P### (parse stage) or WIZZ-G### (generate stage; the WIZZ-A### analyzer
namespace is reserved and empty). The catalog in src/compiler/diagnostics.js
is the single source of truth; tooling switches on codes without parsing
prose. See the component_diagnostics tool for structured records.`,
    structured: { versions: { ...VERSIONS } }
  };
}

/**
 * The development and deployment workflow: the real commands, their
 * defaults, and the secrets rule.
 */
function devWorkflowHandler() {
  return {
    text: `Wizz development and deployment workflow

wizz init [directory] [--force]
    Scaffold the starter project (index.html shell, src/App.wizz, pages,
    components, a server API handler). Existing files are never overwritten.

wizz dev [--port <n>] [--host <addr>]
    Build src into dist, serve at http://127.0.0.1:3000 (or --port), watch
    .wizz sources, and live-reload connected tabs over a dev-only SSE
    channel (/_wizz/reload). Requires an index.html document shell in the
    project directory and fails cleanly when the port is taken. Server-
    renderable routes receive the shell with rendered markup inside the
    mount point plus the serialized state script, and the router hydrates
    it. Missing assets return 404; /server/** is never served as static
    files. The server has no authentication or TLS, so it binds to
    127.0.0.1 (loopback) by default; HOST=<addr> or --host <addr> opts the
    bind out of loopback for remote development.

wizz build [input-directory] [output-directory] [--json] [--adapter node]
    Compile src into dist (defaults), preserving paths. Writes
    dist/package.json ({"type":"module"}), extracts scoped styles into
    dist/app.css, and writes the route and API manifests. --json prints the
    machine-parsable wizz-build-diagnostics@1 envelope; --adapter node
    additionally emits dist/server.mjs.

Deploying (node adapter): deploy the dist/ directory and run
    node dist/server.mjs        # serves http://localhost:8080
    PORT=3000 node dist/server.mjs
The host serves traversal-guarded static files, server-renders the route
manifest, runs /api/** handlers behind the same request context as wizz
dev, and never serves /server/**. Secrets load from a .env.server in the
directory the host is started in (real environment values are never
overridden) — secret files live in the project root, never in src/.

Server API routes: place handlers below src/server/api/*.js. Each handler
exports a function receiving a frozen request context and returns the
response shape wizz dev and the node adapter share. A route collision fails
the build and routes nothing rather than guessing.

wizz update
    Fetch the latest release and swap the managed installation in place.
    When developing Wizz itself, reinstall the working tree with
    ./scripts/install-cli.sh --local after compiler/runtime/CLI changes.

wizz --version
    Print the version triple: wizz <compiler> (compiler <c>, syntax <s>,
    output <o>).`
  };
}

/**
 * Creates or updates a .wizz component inside the project. The full gate
 * chain runs before any write: write permission, size, path guards,
 * scaffold check, compile gate, overwrite coherence — a refusal leaves the
 * file byte-identical.
 */
async function createOrUpdateComponentHandler(args, { root, allowWrite }) {
  if (!allowWrite) {
    throw new ToolExecutionError('Writes are disabled. Start the server with `wizz mcp --allow-write` to enable component writes.');
  }
  const relativePath = requireString(args.path, 'path');
  const source = args.source;
  if (typeof source !== 'string' || source === '') {
    throw new ToolExecutionError('source must be a non-empty string.');
  }
  if (args.overwrite !== undefined && typeof args.overwrite !== 'boolean') {
    throw new ToolExecutionError('overwrite must be a boolean.');
  }
  const overwrite = args.overwrite === true;

  const guard = assertWritableComponentPath(root, relativePath, source);
  if (!guard.ok) return refusalResult('path-refused', relativePath, guard.reason);

  if (!looksLikeWizzProject(root)) {
    return refusalResult(
      'no-project',
      relativePath,
      'This does not look like a Wizz project (no index.html document shell and no src directory). Run `wizz init <directory>` first.'
    );
  }

  // The compile gate runs before the existence check so a refused write is
  // indistinguishable from a refused create: diagnostics first, disk never.
  const gate = compileGate(source, guard.relativePosix);
  if (!gate.ok) {
    return {
      isError: true,
      text: `Refusing to write ${guard.relativePosix}: the proposed source does not compile (${gate.diagnostics.length} diagnostic(s)).\n${diagnosticsText(gate.diagnostics)}`,
      structured: {
        ok: false,
        refused: 'compile-gate',
        file: guard.relativePosix,
        diagnostics: gate.diagnostics
      }
    };
  }

  const exists = fs.existsSync(guard.absolutePath);
  if (exists && !overwrite) {
    return refusalResult(
      'exists',
      relativePath,
      `${guard.relativePosix} already exists. Pass overwrite: true to replace it.`
    );
  }
  if (!exists && overwrite) {
    return refusalResult(
      'missing-file',
      relativePath,
      `${guard.relativePosix} does not exist, so there is nothing to overwrite. Call again without overwrite.`
    );
  }

  fs.mkdirSync(path.dirname(guard.absolutePath), { recursive: true });
  fs.writeFileSync(guard.absolutePath, source, 'utf8');
  const action = exists ? 'updated' : 'created';
  return {
    text: `${action === 'created' ? 'Created' : 'Updated'} ${guard.relativePosix}.`,
    structured: { action, file: guard.relativePosix, diagnostics: [] }
  };
}

function refusalResult(refused, file, message) {
  return {
    isError: true,
    text: message,
    structured: { ok: false, refused, file, diagnostics: [] }
  };
}

// ---------------------------------------------------------------------------
// Tool descriptors and registry
// ---------------------------------------------------------------------------

const TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'project_overview',
    title: 'Wizz project overview',
    description: 'Survey a Wizz application: its .wizz components and routes, server API routes, document shell, build output presence, known adapters, and the compiler version contract.',
    inputSchema: {
      type: 'object',
      properties: {
        inputDirectory: { type: 'string', description: 'Source directory relative to the project root. Default "src".' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'component_diagnostics',
    title: 'Wizz component diagnostics',
    description: 'Compile a .wizz component and return structured WIZZ-P/WIZZ-G diagnostic records without writing anything. Targets exactly one of: a project file (path), inline source text (source, with an optional path label), or every component under the input directory (all).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Component file relative to the project root (.wizz).' },
        source: { type: 'string', description: 'Compile this source text instead of reading a file; pair with path to label diagnostic locations.' },
        all: { type: 'boolean', description: 'Compile every .wizz file under inputDirectory.' },
        inputDirectory: { type: 'string', description: 'Source directory relative to the project root, used with all. Default "src".' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'build_project',
    title: 'Wizz project build',
    description: 'Run the project build (the wizz build equivalent) in-process and return the machine-readable wizz-build-diagnostics@1 envelope: ok, per-file diagnostics, compiled/failed counts, and the files manifest with server-renderability.',
    inputSchema: {
      type: 'object',
      properties: {
        inputDirectory: { type: 'string', description: 'Source directory relative to the project root. Default "src".' },
        outputDirectory: { type: 'string', description: 'Output directory relative to the project root. Default "dist".' },
        adapter: { type: 'string', enum: ['node'], description: 'Also generate the node adapter host (dist/server.mjs).' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'language_contract',
    title: 'Wizz language contract',
    description: 'The .wizz component language contract: file structure, reactive script boundary, template expressions, directives, component imports and props, the version triple, and the stable diagnostic code catalog. Read this before authoring or editing a component.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'dev_workflow',
    title: 'Wizz development workflow',
    description: 'The development and deployment workflow: wizz init/dev/build, the node adapter deploy recipe, server API routes and the .env.server secrets rule, and the managed-install update flow.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'create_or_update_component',
    title: 'Create or update a Wizz component',
    description: 'Create or update a .wizz component inside the project. The proposed source is compiled first and the write is refused with the diagnostic records echoed when it does not compile. Requires the server to run with --allow-write; targets are confined to the project root and may not reach managed trees.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Target file relative to the project root. Must end in .wizz.' },
        source: { type: 'string', description: 'The complete component source to write.' },
        overwrite: { type: 'boolean', description: 'Allow replacing an existing file. Default false.' }
      },
      required: ['path', 'source'],
      additionalProperties: false
    }
  }
]);

function createToolRegistry({ root, allowWrite }) {
  if (typeof root !== 'string' || root === '') {
    throw new TypeError('The tool registry requires a project root string.');
  }
  const resolvedRoot = path.resolve(root);
  if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
    throw new Error(`Project root does not exist or is not a directory: ${resolvedRoot}`);
  }
  const context = { root: resolvedRoot, allowWrite: allowWrite === true };
  const handlers = {
    project_overview: projectOverviewHandler,
    component_diagnostics: componentDiagnosticsHandler,
    build_project: buildProjectHandler,
    language_contract: languageContractHandler,
    dev_workflow: devWorkflowHandler,
    create_or_update_component: createOrUpdateComponentHandler
  };
  return {
    list() {
      return TOOL_DEFINITIONS.map((definition) => ({
        name: definition.name,
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema
      }));
    },
    has(name) {
      return Object.prototype.hasOwnProperty.call(handlers, name);
    },
    call(name, args) {
      const handler = handlers[name];
      if (!handler) {
        throw new TypeError(`Unknown tool: ${name}`);
      }
      return handler(args, context);
    }
  };
}

module.exports = {
  DEFAULT_INPUT_DIRECTORY,
  DEFAULT_OUTPUT_DIRECTORY,
  MAX_SOURCE_BYTES,
  WRITE_DENIED_ROOT_DIRECTORIES,
  TOOL_DEFINITIONS,
  ToolExecutionError,
  assertReadableComponentPath,
  assertWritableComponentPath,
  compileGate,
  createToolRegistry,
  looksLikeWizzProject,
  realpathInsideRoot,
  resolveInsideRoot
};
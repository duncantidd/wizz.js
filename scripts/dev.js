const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { buildProject, discoverWizzFiles } = require('../build');
const {
  API_ROUTE_PREFIX,
  createApiRequestContext,
  discoverApiRoutes,
  isServerOutputPath,
  listJavaScriptFiles,
  loadServerEnv,
  readRequestBody,
  resolveApiRoute,
  sendApiErrorResponse,
  sendApiResult
} = require('./apiRoutes');

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8'
};

// Monotonic per-process build counter backing each rebuild's module query.
let moduleQuerySequence = 0;

// Realpath containment for static serving: the path.relative/startsWith
// prefix checks are lexical, so a symlink inside the output tree pointing
// outside would pass them. Resolve the candidate's canonical path and
// re-check it against the canonical root, which is resolved once per root
// path so a symlinked output ancestor keeps serving. Every failure — a
// dangling symlink, an unreadable ancestor, a NUL byte — conservatively
// answers false: the request falls through to the not-a-file paths.
const canonicalRootCache = new Map();
function isWithinRealRoot(candidate, root) {
  try {
    let canonicalRoot = canonicalRootCache.get(root);
    if (canonicalRoot === undefined) {
      canonicalRoot = fs.realpathSync(root);
      canonicalRootCache.set(root, canonicalRoot);
    }
    const realPath = fs.realpathSync(candidate);
    return realPath === canonicalRoot || realPath.startsWith(`${canonicalRoot}${path.sep}`);
  } catch {
    return false;
  }
}

function copyDocumentShell(projectDirectory, outputDirectory) {
  for (const fileName of ['index.html', 'App.css']) {
    const sourcePath = path.join(projectDirectory, fileName);
    if (fs.existsSync(sourcePath)) {
      fs.copyFileSync(sourcePath, path.join(outputDirectory, fileName));
    }
  }
}

function assertDocumentShell(outputDirectory) {
  const indexPath = path.join(outputDirectory, 'index.html');
  if (!fs.existsSync(indexPath) || !fs.statSync(indexPath).isFile()) {
    throw new Error(`Project document shell is missing: ${indexPath}`);
  }
}

function buildApplication(inputDirectory, outputDirectory, projectDirectory, logger, build = buildProject) {
  // Each rebuild stamps child `.server.js` import specifiers with a fresh
  // query so the dev server's in-process module cache re-evaluates the whole
  // child graph: Node's cache keys on the full URL and queries never
  // propagate through static imports, so without the stamp a component edit
  // would keep serving the first build's stale markup and styles until the
  // server restarted. Timestamp plus sequence survives rapid test rebuilds.
  moduleQuerySequence += 1;
  const moduleQuery = `?v=${Date.now()}-${moduleQuerySequence}`;
  const result = build(inputDirectory, outputDirectory, logger, { moduleQuery });
  copyDocumentShell(projectDirectory, outputDirectory);

  if (result.failedCount > 0) {
    logger.error(`Build completed with ${result.failedCount} failed component(s).`);
  }

  return result;
}

// The route manifest is generated as `export const pageModules = <JSON>`, so
// the array literal can be extracted and parsed directly. Reading it per
// document request keeps route eligibility in lockstep with the build that
// produced it: after a watch rebuild the new manifest is served immediately
// and the previous build's server modules can never be rendered again.
function readRouteTable(outputDirectory) {
  const manifestPath = path.join(path.resolve(outputDirectory), 'runtime', 'routes.js');
  if (!fs.existsSync(manifestPath)) return null;

  try {
    const manifestSource = fs.readFileSync(manifestPath, 'utf8');
    const arrayStart = manifestSource.indexOf('[');
    const arrayEnd = manifestSource.lastIndexOf(']');
    if (arrayStart === -1 || arrayEnd <= arrayStart) return null;

    const pageModules = JSON.parse(manifestSource.slice(arrayStart, arrayEnd + 1));
    if (!Array.isArray(pageModules)) return null;

    const runtimeDirectory = path.join(path.resolve(outputDirectory), 'runtime');
    const routeTable = new Map();
    for (const pageModule of pageModules) {
      if (!pageModule || typeof pageModule.routePath !== 'string') continue;
      // The manifest field is the single authority on eligibility; the server
      // module file itself is resolved lazily at render time.
      routeTable.set(pageModule.routePath, {
        routePath: pageModule.routePath,
        serverModulePath: typeof pageModule.serverModulePath === 'string'
          ? path.resolve(runtimeDirectory, pageModule.serverModulePath)
          : null,
        hydratableModulePath: typeof pageModule.hydratableModulePath === 'string'
          ? path.resolve(runtimeDirectory, pageModule.hydratableModulePath)
          : null
      });
    }
    return routeTable;
  } catch {
    return null;
  }
}

const RELOAD_ROUTE_PREFIX = '/_wizz/reload';
const RELOAD_SCRIPT = '<script>(function(){if(typeof EventSource!=="undefined"){new EventSource("/_wizz/reload").onmessage=function(){location.reload();};}})();</script>';

function injectReloadScript(html) {
  if (typeof html !== 'string') return html;
  // Anchor on the LAST closing body tag, case-insensitively: an earlier
  // literal '</body>' can appear inside inline script text or a comment, and
  // first-occurrence matching would splice the reload script into it and
  // corrupt the page's JavaScript. A `</BODY>` spelling must be treated as a
  // real closer too, not fall through to the append branch. Remaining
  // limitation (accepted for a dev server): a '</body>' sequence inside an
  // inline string with no genuine closing tag anywhere still matches — real
  // HTML parsing is out of scope here.
  const closingBodyTag = /<\/body\s*>/gi;
  let match;
  let lastCloseIndex = -1;
  while ((match = closingBodyTag.exec(html)) !== null) {
    lastCloseIndex = match.index;
  }
  if (lastCloseIndex !== -1) {
    return html.slice(0, lastCloseIndex) + RELOAD_SCRIPT + '\n' + html.slice(lastCloseIndex);
  }
  return html + RELOAD_SCRIPT;
}

function sendDocumentShell(indexPath, response) {
  const shell = fs.readFileSync(indexPath, 'utf8');
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(injectReloadScript(shell));
}

async function renderServerRoute(routeEntry, indexPath, response) {
  // Cache-bust by file mtime: a rebuild rewrites the server module, so the
  // new mtime forms a fresh module URL and the in-process ESM cache can
  // never deliver a stale render after an edit.
  const { mtimeMs } = fs.statSync(routeEntry.serverModulePath);
  const serverModule = await import(`${pathToFileURL(routeEntry.serverModulePath).href}?v=${mtimeMs}`);
  const { html, state, head } = serverModule.renderComponent();
  const stateScript = serverModule.serializeInitialState(state);
  const shell = fs.readFileSync(indexPath, 'utf8');
  const mountPoint = '<div id="app"></div>';

  if (!shell.includes(mountPoint)) {
    throw new Error(`Document shell has no <div id="app"></div> mount point: ${indexPath}`);
  }

  // Marker-delimited so the client's hydrateCreate can locate the delivered
  // run and consume it after a successful adoption. No title de-duplication
  // is attempted here: per-owner slice verification on the client requires
  // every component's own nodes to be delivered verbatim; precedence is
  // resolved at mount time, where the deepest component's title is moved to
  // the head front (the one document.title reads).
  const headRun = head
    ? `<!--wizz:head-start-->${head}<!--wizz:head-end-->`
    : '';

  // Function-form replacement: rendered HTML may contain `$` sequences
  // (`$&`, `$'`, `$$`) that string-form replacement would expand.
  const document = shell
    .replace(mountPoint, () => `<div id="app">${html}</div>\n  ${stateScript}`)
    .replace('</head>', () => `${headRun}</head>`);

  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(injectReloadScript(document));
}

// Milestone 21: `/api/**` requests resolve against `src/server/api/**`
// through the discovered route table (a Map lookup, never a filesystem join,
// so traversal has nothing to resolve against) and run inside the dev server
// process. Handlers execute from their `dist/server/**` copies, never from
// source: the build pins `dist/package.json` to `{"type":"module"}`, and
// Node 18/20 have no module-syntax detection, so importing the authored
// `src/.../*.js` directly would parse as CommonJS and fail on `export` in
// any project without its own type declaration. Dev therefore runs the same
// ESM-typed artifacts production runs.
//
// The watcher only rebuilds on `.wizz` changes, so handler edits would leave
// the dist copies stale; each API request re-copies any source module newer
// than its copy (source mtimes are preserved on copies, so the comparison is
// stable) and imports the copy cache-busted by the source mtime — a handler
// edit takes effect on the next request without a rebuild. A relative edit
// to a private module refreshes its copy on disk, but the importing
// handler's module URL only changes when the handler file itself changes
// (Node's ESM cache keys on it): touch the handler too, or restart, to pick
// up shared-module edits.
function syncServerModules(serverSourceDirectory, outputDirectory) {
  if (!fs.existsSync(serverSourceDirectory) || !fs.statSync(serverSourceDirectory).isDirectory()) {
    return;
  }

  for (const sourcePath of listJavaScriptFiles(serverSourceDirectory)) {
    const targetPath = path.join(outputDirectory, 'server', path.relative(serverSourceDirectory, sourcePath));
    let stale = true;
    try {
      stale = fs.statSync(targetPath).mtimeMs < fs.statSync(sourcePath).mtimeMs;
    } catch {
      stale = true;
    }
    if (!stale) continue;

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
    // utimesSync accepts Dates (it would read raw numbers as seconds, which
    // the *Ms fields are not) — preserving the source mtime keeps the
    // staleness comparison stable across repeated requests.
    const { atime, mtime } = fs.statSync(sourcePath);
    fs.utimesSync(targetPath, atime, mtime);
  }

  // The module-type marker the build writes beside its output: a dev server
  // serving a dist that predates it (or a direct createRequestHandler caller
  // that never built) still needs the pin for Node 18/20 ESM parsing.
  const moduleTypeMarkerPath = path.join(outputDirectory, 'package.json');
  if (!fs.existsSync(moduleTypeMarkerPath)) {
    fs.writeFileSync(moduleTypeMarkerPath, '{"type":"module"}\n', 'utf8');
  }
}

async function handleApiRequest(request, response, url, requestPath, apiDirectory, outputDirectory, logger) {
  // A handler created without an API source directory (older direct
  // createRequestHandler callers) simply has no API surface.
  if (!apiDirectory) {
    sendApiErrorResponse(response, 404, logger);
    return;
  }

  let routes;
  try {
    routes = discoverApiRoutes(apiDirectory);
  } catch (error) {
    logger.error(error.message);
    sendApiErrorResponse(response, 404, logger);
    return;
  }

  const routeEntry = resolveApiRoute(routes, requestPath);
  if (!routeEntry) {
    sendApiErrorResponse(response, 404, logger);
    return;
  }

  try {
    const serverSourceDirectory = path.dirname(apiDirectory);
    syncServerModules(serverSourceDirectory, outputDirectory);
    const relativeModulePath = path.relative(serverSourceDirectory, routeEntry.modulePath);
    const moduleCopyPath = path.join(outputDirectory, 'server', relativeModulePath);
    // Cache-bust by the SOURCE mtime: sync preserves it on the copy, so an
    // edit forms a fresh module URL even though the copy is rewritten.
    const { mtimeMs } = fs.statSync(routeEntry.modulePath);
    const handlerModule = await import(`${pathToFileURL(moduleCopyPath).href}?v=${mtimeMs}`);
    const handler = handlerModule.default;
    if (typeof handler !== 'function') {
      throw new Error(`API module has no default export function: ${routeEntry.modulePath}`);
    }

    const body = await readRequestBody(request);
    const result = await handler(createApiRequestContext(request, url, body, requestPath));
    sendApiResult(response, result);
  } catch (error) {
    // Framework-level request problems carry the status to answer with;
    // everything else — a handler throw, a bad import, a missing default
    // export — is a 500 whose detail goes to the log, never the client.
    const statusCode = error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    sendApiErrorResponse(response, statusCode, logger, `${routeEntry.routePath}: ${error.message}`);
  }
}

function createRequestHandler(outputDirectory, options = {}) {
  const resolvedOutputDirectory = path.resolve(outputDirectory);
  const indexPath = path.join(resolvedOutputDirectory, 'index.html');
  const getRouteTable = options.getRouteTable || (() => readRouteTable(resolvedOutputDirectory));
  const logger = options.logger || console;
  const apiDirectory = options.apiDirectory || null;
  const reloadClients = options.reloadClients || null;

  return (request, response) => {
    let requestPath;
    let url;
    try {
      // Concatenated into a fixed origin rather than parsed against a base:
      // a base would re-parse an origin-form target starting with '//' as
      // protocol-relative, silently promoting its first path segment to an
      // authority (dropping path segments, or throwing on an invalid host).
      // This server is not a proxy, so an absolute-form target lands in the
      // same 400 as any other malformed request.
      url = new URL('http://localhost' + request.url);
      requestPath = decodeURIComponent(url.pathname);
    } catch {
      // An undecodable pathname is a malformed request, not a crash.
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Bad request');
      return;
    }

    // A NUL byte is invalid in any filesystem path (fs throws on it), so
    // reject it deterministically as a malformed request instead of letting
    // it fall through to the shell fallback.
    if (requestPath.includes('\0')) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Bad request');
      return;
    }

    // Dev-only Server-Sent Events (SSE) reload endpoint: broadcast updates to open tabs.
    if (requestPath === RELOAD_ROUTE_PREFIX) {
      if (request.method === 'GET') {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*'
        });
        response.write('retry: 1000\n\n');
        if (reloadClients) {
          reloadClients.add(response);
          request.on('close', () => {
            reloadClients.delete(response);
          });
        }
      } else {
        response.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Method not allowed');
      }
      return;
    }

    // Handler source lives in `dist/server/` for external Node hosts after a
    // production build; a dev server pointed at that dist must never serve it
    // as a static file.
    if (isServerOutputPath(requestPath)) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }

    const filePath = path.resolve(resolvedOutputDirectory, `.${requestPath}`);
    const isInsideOutput = filePath === resolvedOutputDirectory
      || filePath.startsWith(`${resolvedOutputDirectory}${path.sep}`);
    const isFile = isInsideOutput
      && fs.existsSync(filePath)
      && fs.statSync(filePath).isFile()
      && isWithinRealRoot(filePath, resolvedOutputDirectory);

    if (isFile) {
      if (path.extname(filePath) === '.html') {
        const content = fs.readFileSync(filePath, 'utf8');
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(injectReloadScript(content));
        return;
      }
      response.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(response);
      return;
    }

    if (path.extname(requestPath)) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }

    // Server API routes: extensionless `/api/**` paths run their handler
    // inside this process. An unmatched API path answers 404 JSON — never the
    // SPA shell, which would make an API miss look like a 200 HTML page.
    if (requestPath === API_ROUTE_PREFIX || requestPath.startsWith(`${API_ROUTE_PREFIX}/`)) {
      handleApiRequest(request, response, url, requestPath, apiDirectory, resolvedOutputDirectory, logger).catch((error) => {
        logger.error(`API request failed for ${requestPath}: ${error.message}`);
        if (!response.headersSent) {
          sendApiErrorResponse(response, 500, logger);
        } else {
          response.destroy();
        }
      });
      return;
    }

    // Route documents: extensionless paths matching a manifest route with a
    // server module render server-side. Route matching mirrors the client
    // router exactly (exact pathname lookup), so the server never delivers
    // markup the router would not claim. Every other extensionless path
    // keeps the SPA fallback shell.
    const routeTable = getRouteTable();
    const routeEntry = routeTable instanceof Map ? routeTable.get(requestPath) : undefined;
    if (routeEntry && routeEntry.serverModulePath) {
      renderServerRoute(routeEntry, indexPath, response).catch((error) => {
        logger.error(`Server rendering failed for ${routeEntry.routePath}: ${error.message}`);
        try {
          sendDocumentShell(indexPath, response);
        } catch {
          response.destroy();
        }
      });
      return;
    }

    sendDocumentShell(indexPath, response);
  };
}

function createSourceSnapshot(inputDirectory) {
  return discoverWizzFiles(inputDirectory)
    .map((filePath) => {
      const stats = fs.statSync(filePath);
      return `${filePath}:${stats.size}:${stats.mtimeMs}`;
    })
    .join('|');
}

function watchSourceFiles(inputDirectory, onChange, options = {}) {
  const watch = options.watch || fs.watch;
  const setIntervalFn = options.setInterval || setInterval;
  const clearIntervalFn = options.clearInterval || clearInterval;
  const onWatchUnavailable = options.onWatchUnavailable || (() => {});
  let snapshot = createSourceSnapshot(inputDirectory);
  // Recursive fs.watch is unavailable on supported platforms (Linux before
  // Node 20 throws ERR_FEATURE_UNAVAILABLE_ON_PLATFORM at call time), so a
  // failure degrades to the snapshot poller below instead of refusing to
  // start: the poller detects the same changes with a 250ms latency bound.
  let watcher = null;
  try {
    watcher = watch(inputDirectory, { recursive: true }, (eventType, fileName) => {
      if (fileName && path.extname(fileName) === '.wizz') {
        snapshot = createSourceSnapshot(inputDirectory);
        onChange(eventType, fileName);
      }
    });
    // A native watcher that dies mid-session must not take the server down:
    // route the failure through the same notice and let the poller carry on.
    if (watcher && typeof watcher.on === 'function') {
      watcher.on('error', (error) => onWatchUnavailable(error));
    }
  } catch (error) {
    onWatchUnavailable(error);
  }
  const poller = setIntervalFn(() => {
    const nextSnapshot = createSourceSnapshot(inputDirectory);
    if (nextSnapshot === snapshot) return;
    snapshot = nextSnapshot;
    onChange('change', 'source files');
  }, 250);

  return {
    close() {
      if (watcher) watcher.close();
      if (poller) clearIntervalFn(poller);
    }
  };
}

// The dev server serves compiled source, executes /api handlers in-process
// with .env.server secrets loaded into process.env, and exposes an SSE
// reload channel — all without authentication or TLS. Binding every
// interface would hand all of that to the local network, so the default is
// loopback; HOST (environment) and the --host flag are the explicit opt-ins
// for remote development, with an explicit option outranking the
// environment.
function resolveBindHost(explicitHost) {
  const candidate = explicitHost ?? process.env.HOST;
  if (candidate === undefined || candidate === null || candidate === '') {
    return '127.0.0.1';
  }
  if (typeof candidate !== 'string') {
    throw new TypeError('Invalid host: must be a string.');
  }
  return candidate;
}

function startDevelopmentServer(options = {}) {
  const projectDirectory = path.resolve(options.projectDirectory || path.join(__dirname, '..'));
  const inputDirectory = path.resolve(options.inputDirectory || path.join(projectDirectory, 'src'));
  const outputDirectory = path.resolve(options.outputDirectory || path.join(projectDirectory, 'dist'));
  const port = options.port ?? 3000;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new TypeError('Invalid port: must be an integer between 0 and 65535.');
  }
  const host = resolveBindHost(options.host);
  const logger = options.logger || console;
  const build = options.build || buildProject;
  const loadEnv = options.loadEnv || loadServerEnv;

  // Server-side secrets load once before the first request: handlers read
  // them through process.env, and the file they come from is never copied
  // into the served output.
  const loadedEnvCount = loadEnv(projectDirectory);
  if (loadedEnvCount > 0) {
    logger.log(`Loaded ${loadedEnvCount} server environment variable(s) from .env.server.`);
  }

  buildApplication(inputDirectory, outputDirectory, projectDirectory, logger, build);
  assertDocumentShell(outputDirectory);
  const reloadClients = new Set();
  const server = http.createServer(createRequestHandler(outputDirectory, {
    logger,
    apiDirectory: path.join(inputDirectory, 'server', 'api'),
    reloadClients
  }));
  const watcher = watchSourceFiles(inputDirectory, (eventType, fileName) => {
    logger.log(`Rebuilding after ${eventType}: ${fileName}`);
    buildApplication(inputDirectory, outputDirectory, projectDirectory, logger, build);
    for (const clientResponse of reloadClients) {
      try {
        clientResponse.write('data: reload\n\n');
      } catch {
        reloadClients.delete(clientResponse);
      }
    }
  }, {
    watch: options.watch,
    setInterval: options.setInterval,
    clearInterval: options.clearInterval,
    onWatchUnavailable: (error) => {
      logger.log(`Recursive fs.watch unavailable (${error.code || error.message}); watching by polling every 250ms.`);
    }
  });

  return {
    server,
    reloadClients,
    close() {
      watcher.close();
      for (const clientResponse of reloadClients) {
        try { clientResponse.end(); } catch {}
      }
      reloadClients.clear();
      if (!server.listening) {
        return Promise.resolve();
      }
      return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
    listen() {
      return new Promise((resolve, reject) => {
        const onError = (error) => {
          server.removeListener('listening', onListening);
          if (error && error.code === 'EADDRINUSE') {
            reject(new Error(`Port ${port} is already in use. Specify a different port with --port <n>.`));
          } else {
            reject(error);
          }
        };
        const onListening = () => {
          server.removeListener('error', onError);
          const address = server.address();
          // The advertised URL must be exactly dialable, so it names the
          // bound address, never "localhost": on hosts where localhost
          // resolves to ::1 first (Linux CI images do), a strict client
          // such as node's fetch would fail to reach an IPv4 loopback bind
          // through it. Browsers try both stacks for localhost, but the
          // banner should not depend on that.
          const displayHost = address.address.includes(':')
            ? `[${address.address}]`
            : address.address;
          const url = `http://${displayHost}:${address.port}`;
          logger.log(`Wizz development server running at ${url}`);
          resolve(url);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
    }
  };
}

if (require.main === module) {
  try {
    const developmentServer = startDevelopmentServer();
    developmentServer.listen().then(
      () => {},
      (error) => {
        // Same contract as the CLI path: release the watcher handles so the
        // process exits cleanly instead of hanging or dumping an unhandled
        // rejection stack trace.
        developmentServer.close();
        console.error(error.message);
        process.exitCode = 1;
      }
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  RELOAD_ROUTE_PREFIX,
  RELOAD_SCRIPT,
  assertDocumentShell,
  buildApplication,
  copyDocumentShell,
  createRequestHandler,
  createSourceSnapshot,
  injectReloadScript,
  readRouteTable,
  resolveBindHost,
  startDevelopmentServer,
  watchSourceFiles
};
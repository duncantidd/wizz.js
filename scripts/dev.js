const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { buildProject, discoverWizzFiles } = require('../build');

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8'
};

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
  const result = build(inputDirectory, outputDirectory, logger);
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

function sendDocumentShell(indexPath, response) {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  fs.createReadStream(indexPath).pipe(response);
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
  response.end(document);
}

function createRequestHandler(outputDirectory, options = {}) {
  const resolvedOutputDirectory = path.resolve(outputDirectory);
  const indexPath = path.join(resolvedOutputDirectory, 'index.html');
  const getRouteTable = options.getRouteTable || (() => readRouteTable(resolvedOutputDirectory));
  const logger = options.logger || console;

  return (request, response) => {
    const requestPath = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const filePath = path.resolve(resolvedOutputDirectory, `.${requestPath}`);
    const isInsideOutput = filePath === resolvedOutputDirectory
      || filePath.startsWith(`${resolvedOutputDirectory}${path.sep}`);
    const isFile = isInsideOutput && fs.existsSync(filePath) && fs.statSync(filePath).isFile();

    if (isFile) {
      response.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(response);
      return;
    }

    if (path.extname(requestPath)) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
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
  let snapshot = createSourceSnapshot(inputDirectory);
  const watcher = watch(inputDirectory, { recursive: true }, (eventType, fileName) => {
    if (fileName && path.extname(fileName) === '.wizz') {
      snapshot = createSourceSnapshot(inputDirectory);
      onChange(eventType, fileName);
    }
  });
  const poller = setIntervalFn(() => {
    const nextSnapshot = createSourceSnapshot(inputDirectory);
    if (nextSnapshot === snapshot) return;
    snapshot = nextSnapshot;
    onChange('change', 'source files');
  }, 250);

  return {
    close() {
      watcher.close();
      if (poller) clearIntervalFn(poller);
    }
  };
}

function startDevelopmentServer(options = {}) {
  const projectDirectory = path.resolve(options.projectDirectory || path.join(__dirname, '..'));
  const inputDirectory = path.resolve(options.inputDirectory || path.join(projectDirectory, 'src'));
  const outputDirectory = path.resolve(options.outputDirectory || path.join(projectDirectory, 'dist'));
  const port = options.port ?? 3000;
  const logger = options.logger || console;
  const build = options.build || buildProject;

  buildApplication(inputDirectory, outputDirectory, projectDirectory, logger, build);
  assertDocumentShell(outputDirectory);
  const server = http.createServer(createRequestHandler(outputDirectory, { logger }));
  const watcher = watchSourceFiles(inputDirectory, (eventType, fileName) => {
    logger.log(`Rebuilding after ${eventType}: ${fileName}`);
    buildApplication(inputDirectory, outputDirectory, projectDirectory, logger, build);
  }, {
    watch: options.watch,
    setInterval: options.setInterval,
    clearInterval: options.clearInterval
  });

  return {
    server,
    close() {
      watcher.close();
      if (!server.listening) {
        return Promise.resolve();
      }
      return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
    listen() {
      return new Promise((resolve) => {
        server.listen(port, () => {
          const address = server.address();
          const url = `http://localhost:${address.port}`;
          logger.log(`Wizz development server running at ${url}`);
          resolve(url);
        });
      });
    }
  };
}

if (require.main === module) {
  try {
    const developmentServer = startDevelopmentServer();
    void developmentServer.listen();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  assertDocumentShell,
  buildApplication,
  copyDocumentShell,
  createRequestHandler,
  createSourceSnapshot,
  readRouteTable,
  startDevelopmentServer,
  watchSourceFiles
};
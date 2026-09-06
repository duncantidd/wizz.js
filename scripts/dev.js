const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
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

function createRequestHandler(outputDirectory) {
  const resolvedOutputDirectory = path.resolve(outputDirectory);
  const indexPath = path.join(resolvedOutputDirectory, 'index.html');

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

    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(indexPath).pipe(response);
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
  const server = http.createServer(createRequestHandler(outputDirectory));
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
  startDevelopmentServer,
  watchSourceFiles
};
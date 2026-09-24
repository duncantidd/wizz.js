const fs = require('node:fs');
const path = require('node:path');

const API_ROUTE_PREFIX = '/api';
const SERVER_OUTPUT_PREFIX = '/server';
// A request body larger than this never reaches a handler: the dev server is
// a development tool, but it is still an internet-facing HTTP endpoint, and
// node:http imposes no body limit of its own.
const MAX_BODY_BYTES = 1024 * 1024;

// An error carrying an HTTP status it should answer with. Raised for
// framework-level request problems (bad JSON, oversized body) so the dev
// server can send the status without treating the request as a handler bug.
function createApiError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

// Route paths mirror the page convention (`getRoutePath` in build.js):
// lowercase, directory segments preserved, `index.js` names the directory
// itself. Files and directories starting with `_` are private server modules
// — importable by handlers, never routable.
function getApiRoutePath(apiDirectory, filePath) {
  const relativePath = path.relative(apiDirectory, filePath);
  const segments = relativePath.split(path.sep);

  if (segments.some((segment) => segment.startsWith('_'))) return null;

  const pageSegments = segments.slice(0, -1);
  const fileName = path.basename(filePath, '.js');
  if (fileName !== 'index') pageSegments.push(fileName);

  return `${API_ROUTE_PREFIX}/${pageSegments.join('/').toLowerCase()}`.replace(/\/$/, '') || API_ROUTE_PREFIX;
}

// Lists every .js file under `directory` (recursively, sorted for byte-stable
// manifests). Private `_`-prefixed modules are included: they are never
// routable, but handlers import them, so build/dev copies must carry them.
function listJavaScriptFiles(directory) {
  const files = [];
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) return files;

  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
        continue;
      }
      if (entry.isFile() && path.extname(entry.name) === '.js') files.push(entryPath);
    }
  };
  walk(directory);
  return files;
}

// Walks the API source directory and returns a Map of routePath -> entry
// { routePath, modulePath (absolute) }. Duplicate routes (an `index.js` next
// to a same-named file, or case-folded collisions) throw, mirroring
// `validateRouteEntries` — the caller decides whether that fails a build or
// disables API serving.
function discoverApiRoutes(apiDirectory) {
  const routes = new Map();

  for (const modulePath of listJavaScriptFiles(apiDirectory)) {
    const routePath = getApiRoutePath(apiDirectory, modulePath);
    if (!routePath) continue;

    const existing = routes.get(routePath);
    if (existing) {
      throw new Error(
        `Ambiguous API route '${routePath}' is claimed by ${path.relative(apiDirectory, existing.modulePath)} and ${path.relative(apiDirectory, modulePath)}`
      );
    }
    routes.set(routePath, { routePath, modulePath });
  }
  return routes;
}

// Resolves a decoded request pathname against the discovered routes. Returns
// null for anything that is not an exact route match — the resolution is a
// table lookup, never a filesystem join, so `..` segments and encoded
// traversal have nothing to resolve against.
function resolveApiRoute(routes, requestPath) {
  return routes instanceof Map ? routes.get(requestPath) : undefined;
}

// Reads a request body to a UTF-8 string, refusing bodies larger than
// maxBytes with a 413. The socket is destroyed on refusal so an oversized
// upload cannot keep streaming into a discarded buffer.
function readRequestBody(request, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const onData = (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        // Stop reading and pause — do not destroy the socket, or the 413
        // answer could never be written. The response carries
        // `Connection: close` so the truncated upload cannot linger.
        request.removeListener('data', onData);
        request.pause();
        reject(createApiError(413, `Request body exceeds the ${maxBytes}-byte limit.`));
        return;
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    };
    request.on('data', onData);
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

// Builds the frozen, platform-plain context a handler receives. Nothing from
// Node's req/res objects leaks through: strings, a lowercased header map, a
// URLSearchParams, and the raw body. `json()` parses lazily and throws a 400
// on malformed input — no reviver, no merging, so a hostile `__proto__` key
// stays inert data on the parsed object.
function createApiRequestContext(request, url, body, requestPath) {
  const headers = Object.freeze({ ...request.headers });
  const context = {
    method: request.method || 'GET',
    path: requestPath || url.pathname,
    query: url.searchParams,
    headers,
    body: body.length > 0 ? body : null,
    json() {
      if (context.body === null) return undefined;
      try {
        return JSON.parse(context.body);
      } catch {
        throw createApiError(400, 'Request body is not valid JSON.');
      }
    }
  };
  return Object.freeze(context);
}

// Sends a handler's return value. `undefined` answers 204; an object carrying
// a numeric `status` is treated as a full response ({ status, headers, body });
// anything else answers 200 as JSON. Strings pass through verbatim so a
// handler can answer plain text without JSON quoting.
function sendApiResult(response, result) {
  if (result === undefined) {
    response.writeHead(204);
    response.end();
    return;
  }

  if (result !== null && typeof result === 'object' && typeof result.status === 'number' && Number.isInteger(result.status) && result.status >= 200 && result.status <= 599) {
    const headers = {};
    if (result.headers !== null && typeof result.headers === 'object') {
      for (const [name, value] of Object.entries(result.headers)) {
        if (typeof value === 'string') headers[name] = value;
      }
    }
    const status = result.status;
    if (result.body === undefined) {
      response.writeHead(status, headers);
      response.end();
      return;
    }
    if (typeof result.body === 'string') {
      response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
      response.end(result.body);
      return;
    }
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
    response.end(JSON.stringify(result.body));
    return;
  }

  if (typeof result === 'string') {
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(result);
    return;
  }

  response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(result));
}

// Framework-level error answers. A 500 never carries the underlying message —
// handler errors can quote secrets, file paths, or third-party responses, so
// the client gets a fixed body and the server log gets the detail.
function sendApiErrorResponse(response, statusCode, logger, detail) {
  const body = statusCode === 500
    ? '{"error":"Internal server error"}'
    : `{"error":${JSON.stringify(statusCode === 404 ? 'Not found' : statusCode === 413 ? 'Request body too large' : 'Bad request')}}`;
  if (statusCode === 500 && detail) {
    logger.error(`API handler failed: ${detail}`);
  }
  // A refused upload means the client is mid-body: `Connection: close` tells
  // it the remaining bytes are unwanted rather than left draining.
  const headers = statusCode === 413
    ? { 'Content-Type': 'application/json; charset=utf-8', Connection: 'close' }
    : { 'Content-Type': 'application/json; charset=utf-8' };
  response.writeHead(statusCode, headers);
  response.end(body);
}

// Parses `<projectRoot>/.env.server` into the target environment object
// (process.env by default) without overriding variables the real environment
// already provides. KEY=VALUE lines only; `#` comments and blank lines are
// skipped; surrounding quotes are stripped from values; no interpolation, no
// shell — the file is data, never a script.
function loadServerEnv(projectDirectory, targetEnv = process.env) {
  const envPath = path.join(path.resolve(projectDirectory), '.env.server');
  if (!fs.existsSync(envPath) || !fs.statSync(envPath).isFile()) return 0;

  const contents = fs.readFileSync(envPath, 'utf8');
  let loaded = 0;
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const equalsIndex = line.indexOf('=');
    if (equalsIndex <= 0) continue;
    const key = line.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(equalsIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
      value = value.slice(1, -1);
    }
    if (Object.prototype.hasOwnProperty.call(targetEnv, key)) continue;
    targetEnv[key] = value;
    loaded += 1;
  }
  return loaded;
}

// True when a decoded request path targets the production server output
// directory. Handlers are copied to `dist/server/` by `wizz build` for
// external Node hosts; a dev server pointed at such a dist must never serve
// them as static files.
function isServerOutputPath(requestPath) {
  return requestPath === SERVER_OUTPUT_PREFIX || requestPath.startsWith(`${SERVER_OUTPUT_PREFIX}/`);
}

module.exports = {
  API_ROUTE_PREFIX,
  MAX_BODY_BYTES,
  SERVER_OUTPUT_PREFIX,
  createApiError,
  createApiRequestContext,
  discoverApiRoutes,
  getApiRoutePath,
  isServerOutputPath,
  listJavaScriptFiles,
  loadServerEnv,
  readRequestBody,
  resolveApiRoute,
  sendApiErrorResponse,
  sendApiResult
};

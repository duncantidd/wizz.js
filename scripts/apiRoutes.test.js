const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { URLSearchParams } = require('node:url');
const {
  MAX_BODY_BYTES,
  createApiError,
  createApiRequestContext,
  discoverApiRoutes,
  getApiRoutePath,
  isServerOutputPath,
  loadServerEnv,
  readRequestBody,
  resolveApiRoute,
  sendApiErrorResponse,
  sendApiResult
} = require('./apiRoutes');

function createTemporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wizz-api-routes-test-'));
}

function writeFile(filePath, contents = '') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, 'utf8');
}

function routePaths(apiDirectory) {
  return [...discoverApiRoutes(apiDirectory).keys()];
}

function createResponse() {
  const response = {
    statusCode: null,
    headers: null,
    body: '',
    ended: false,
    writeHead(status, headers) {
      if (this.statusCode !== null) throw new Error('writeHead called twice');
      this.statusCode = status;
      this.headers = headers || {};
    },
    end(chunk) {
      if (this.ended) throw new Error('end called twice');
      this.ended = true;
      if (chunk !== undefined) this.body += chunk;
    }
  };
  return response;
}

test('maps api files to lowercase routes with the index convention', () => {
  const directory = createTemporaryDirectory();
  writeFile(path.join(directory, 'index.js'));
  writeFile(path.join(directory, 'health.js'));
  writeFile(path.join(directory, 'v1', 'users.js'));
  writeFile(path.join(directory, 'v1', 'index.js'));

  assert.deepEqual(routePaths(directory).sort(), ['/api', '/api/health', '/api/v1', '/api/v1/users']);
});

test('private underscore entries are importable but never routable', () => {
  const directory = createTemporaryDirectory();
  writeFile(path.join(directory, '_shared.js'));
  writeFile(path.join(directory, '_lib', 'client.js'));
  writeFile(path.join(directory, 'health.js'));

  assert.deepEqual(routePaths(directory), ['/api/health']);
});

test('non-javascript files are ignored', () => {
  const directory = createTemporaryDirectory();
  writeFile(path.join(directory, 'notes.txt'));
  writeFile(path.join(directory, 'README.md'));
  writeFile(path.join(directory, 'health.js'));

  assert.deepEqual(routePaths(directory), ['/api/health']);
});

test('a missing or non-directory api location yields an empty table', () => {
  assert.equal(discoverApiRoutes(path.join(createTemporaryDirectory(), 'absent')).size, 0);
  const filePath = path.join(createTemporaryDirectory(), 'a-file');
  fs.writeFileSync(filePath, '', 'utf8');
  assert.equal(discoverApiRoutes(filePath).size, 0);
});

test('duplicate route paths throw naming both claimants', () => {
  const directory = createTemporaryDirectory();
  writeFile(path.join(directory, 'Health.js'));
  writeFile(path.join(directory, 'health.js'));

  assert.throws(() => discoverApiRoutes(directory), /Ambiguous API route '\/api\/health'/);
});

test('an index.js beside a colliding sibling name throws', () => {
  const directory = createTemporaryDirectory();
  writeFile(path.join(directory, 'v1.js'));
  writeFile(path.join(directory, 'v1', 'index.js'));

  assert.throws(() => discoverApiRoutes(directory), /Ambiguous API route '\/api\/v1'/);
});

test('getApiRoutePath lowercases segments and strips the trailing slash', () => {
  const directory = path.join(createTemporaryDirectory(), 'api');
  assert.equal(getApiRoutePath(directory, path.join(directory, 'V1', 'Users.js')), '/api/v1/users');
  assert.equal(getApiRoutePath(directory, path.join(directory, 'index.js')), '/api');
});

test('route resolution is a table lookup, never a filesystem join', () => {
  const table = new Map([['/api/health', { routePath: '/api/health' }]]);

  assert.ok(resolveApiRoute(table, '/api/health'));
  assert.equal(resolveApiRoute(table, '/api/health.js'), undefined);
  assert.equal(resolveApiRoute(table, '/api/../secret'), undefined);
  assert.equal(resolveApiRoute(table, '/api/%2e%2e'), undefined);
  assert.equal(resolveApiRoute(null, '/api/health'), undefined);
});

test('readRequestBody collects the body and refuses oversized uploads', async () => {
  const { Readable } = require('node:stream');
  const small = Readable.from(['hello', ' ', 'world']);
  assert.equal(await readRequestBody(small), 'hello world');

  const oversized = Readable.from([Buffer.alloc(MAX_BODY_BYTES + 1)]);
  await assert.rejects(readRequestBody(oversized), (error) => error.statusCode === 413);
});

test('createApiRequestContext exposes a frozen plain surface', () => {
  const url = new URL('http://localhost/api/echo?x=1&x=2');
  const request = { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost' } };
  const context = createApiRequestContext(request, url, '{"a":1}');

  assert.equal(context.method, 'POST');
  assert.equal(context.path, '/api/echo');
  assert.equal(context.query.get('x'), '1');
  assert.deepEqual([...context.query.getAll('x')], ['1', '2']);
  assert.equal(context.headers['content-type'], 'application/json');
  assert.equal(context.body, '{"a":1}');
  assert.deepEqual(context.json(), { a: 1 });
  assert.equal(Object.isFrozen(context), true);
  // Non-strict CommonJS tests cannot observe a frozen-object assignment throw,
  // but the mutation must be a silent no-op either way (ESM handler modules
  // are strict and would throw).
  context.method = 'GET';
  assert.equal(context.method, 'POST');
});

test('an empty body parses to undefined and a malformed body throws a 400', () => {
  const url = new URL('http://localhost/api/echo');
  const empty = createApiRequestContext({ method: 'GET', headers: {} }, url, '');
  assert.equal(empty.body, null);
  assert.equal(empty.json(), undefined);

  const malformed = createApiRequestContext({ method: 'POST', headers: {} }, url, '{nope');
  assert.throws(() => malformed.json(), (error) => error.statusCode === 400);
});

test('a hostile __proto__ key stays inert data', () => {
  const url = new URL('http://localhost/api/echo');
  const context = createApiRequestContext({ method: 'POST', headers: {} }, url, '{"__proto":{"polluted":true}}');
  const parsed = context.json();
  assert.equal(Object.prototype.polluted, undefined);
  assert.deepEqual(parsed.__proto, { polluted: true });
});

test('sendApiResult answers undefined with 204', () => {
  const response = createResponse();
  sendApiResult(response, undefined);
  assert.equal(response.statusCode, 204);
  assert.equal(response.body, '');
});

test('plain values answer 200 as JSON and strings pass through verbatim', () => {
  const jsonResponse = createResponse();
  sendApiResult(jsonResponse, { ok: true });
  assert.equal(jsonResponse.statusCode, 200);
  assert.equal(jsonResponse.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.equal(jsonResponse.body, '{"ok":true}');

  const textResponse = createResponse();
  sendApiResult(textResponse, 'plain body');
  assert.equal(textResponse.statusCode, 200);
  assert.equal(textResponse.body, 'plain body');
});

test('a full response object honors status, headers, and body shapes', () => {
  const object = createResponse();
  sendApiResult(object, { status: 201, headers: { 'x-a': 'a', 'x-b': 9 }, body: { created: true } });
  assert.equal(object.statusCode, 201);
  assert.equal(object.headers['x-a'], 'a');
  assert.equal(object.headers['x-b'], undefined);
  assert.equal(object.body, '{"created":true}');

  const text = createResponse();
  sendApiResult(text, { status: 200, headers: { 'Content-Type': 'text/html' }, body: '<p>hi</p>' });
  assert.equal(text.statusCode, 200);
  assert.equal(text.headers['Content-Type'], 'text/html');
  assert.equal(text.body, '<p>hi</p>');

  const empty = createResponse();
  sendApiResult(empty, { status: 202 });
  assert.equal(empty.statusCode, 202);
  assert.equal(empty.body, '');
});

test('a $-bearing JSON body survives string writing', () => {
  const response = createResponse();
  sendApiResult(response, { value: '$& $\' $$' });
  assert.equal(response.body, '{"value":"$& $\' $$"}');
});

test('sendApiErrorResponse never leaks a 500 detail and labels other statuses', () => {
  const logger = { errors: [], error(message) { this.errors.push(message); } };

  const internal = createResponse();
  sendApiErrorResponse(internal, 500, logger, 'Bearer sk-secret leaked');
  assert.equal(internal.statusCode, 500);
  assert.equal(internal.body, '{"error":"Internal server error"}');
  assert.equal(logger.errors.length, 1);
  assert.match(logger.errors[0], /sk-secret/);

  const missing = createResponse();
  sendApiErrorResponse(missing, 404, logger);
  assert.equal(missing.body, '{"error":"Not found"}');

  const huge = createResponse();
  sendApiErrorResponse(huge, 413, logger);
  assert.equal(huge.body, '{"error":"Request body too large"}');
});

test('loadServerEnv loads KEY=VALUE lines without overriding the real environment', () => {
  const projectDirectory = createTemporaryDirectory();
  fs.writeFileSync(path.join(projectDirectory, '.env.server'), [
    '# comment',
    '',
    'PLAIN=value',
    'QUOTED="double quoted"',
    "SINGLE='single quoted'",
    'SPACED =  spaced value  ',
    'FROM_REAL_ENV=ignored',
    'not a pair',
    '=nokey',
    'BAD KEY=x',
    '9STARTSWITHDIGIT=x'
  ].join('\n'), 'utf8');

  const target = { FROM_REAL_ENV: 'real' };
  const loaded = loadServerEnv(projectDirectory, target);

  assert.equal(loaded, 4);
  assert.equal(target.PLAIN, 'value');
  assert.equal(target.QUOTED, 'double quoted');
  assert.equal(target.SINGLE, 'single quoted');
  assert.equal(target.SPACED, 'spaced value');
  assert.equal(target.FROM_REAL_ENV, 'real');
});

test('a missing .env.server loads nothing', () => {
  const target = {};
  assert.equal(loadServerEnv(createTemporaryDirectory(), target), 0);
  assert.deepEqual(target, {});
});

test('isServerOutputPath guards the production handler directory', () => {
  assert.equal(isServerOutputPath('/server'), true);
  assert.equal(isServerOutputPath('/server/api/echo.js'), true);
  assert.equal(isServerOutputPath('/servers'), false);
  assert.equal(isServerOutputPath('/api/echo'), false);
});

test('createApiError carries its status code', () => {
  assert.equal(createApiError(400, 'bad').statusCode, 400);
});

test('readRequestBody rejects malformed streams without hanging', async () => {
  const { EventEmitter } = require('node:events');
  const failing = new EventEmitter();
  setImmediate(() => failing.emit('error', new Error('socket failure')));
  await assert.rejects(readRequestBody(failing), /socket failure/);
});

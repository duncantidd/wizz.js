// build.js
const fs = require('node:fs');
const path = require('node:path');

// Single public compiler entry point: parsing, analysis, ID assignment, generation.
const { compile, compileServer } = require('./src/compiler');
const { scopeCss } = require('./src/compiler/analyzer/cssScanner');
const { discoverApiRoutes, listJavaScriptFiles } = require('./scripts/apiRoutes');

const STYLESHEET_FILENAME = 'app.css';
const STYLESHEET_HREF_PATTERN = /href\s*=\s*(["'])\/app\.css\1/;

// The envelope `wizz build --json` prints. Versioned so tooling can pin the
// shape it parses: new fields may be added within format version 1, but
// existing fields keep their meaning until the version string changes.
const BUILD_DIAGNOSTICS_FORMAT = 'wizz-build-diagnostics@1';

// The adapters `--adapter <name>` can emit. `node` generates a standalone
// SSR + API host (`server.mjs`) into the build output; a second adapter
// (Vercel, Cloudflare) joins this list with its own emitter.
const KNOWN_ADAPTERS = ['node'];
const NODE_ADAPTER_HOST_FILENAME = 'server.mjs';

const BUILD_USAGE_LINE = 'Usage: node build.js <input-directory> <output-directory> [--json] [--adapter <name>]';

function parseBuildArguments(argv) {
  if (!Array.isArray(argv)) {
    throw new TypeError('Build arguments must be an array.');
  }

  const json = argv.includes('--json');
  const adapterValues = [];
  const directories = [];

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--json') continue;
    if (argument === '--adapter' || argument.startsWith('--adapter=')) {
      const value = argument === '--adapter' ? argv[index + 1] : argument.slice('--adapter='.length);
      if (value === undefined || value === '') {
        throw new Error('Build --adapter requires a value.\n\n' + BUILD_USAGE_LINE);
      }
      adapterValues.push(value);
      if (argument === '--adapter') index++;
      continue;
    }
    directories.push(argument);
  }

  if (adapterValues.length > 1) {
    throw new Error('Build accepts at most one --adapter flag.\n\n' + BUILD_USAGE_LINE);
  }

  const adapter = adapterValues.length > 0 ? adapterValues[0] : null;
  if (adapter !== null && !KNOWN_ADAPTERS.includes(adapter)) {
    throw new Error(`Unknown adapter '${adapter}'. Known adapters: ${KNOWN_ADAPTERS.join(', ')}.\n\n` + BUILD_USAGE_LINE);
  }

  if (directories.length !== 2) {
    throw new Error(BUILD_USAGE_LINE);
  }

  const [inputDirectory, outputDirectory] = directories;
  return { inputDirectory, outputDirectory, json, adapter };
}

function toPosixPath(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function discoverWizzFiles(inputDirectory) {
  const wizzFiles = [];

  function visit(directory) {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile() && path.extname(entry.name) === '.wizz') {
        wizzFiles.push(entryPath);
      }
    }
  }

  visit(inputDirectory);
  return wizzFiles;
}

function getOutputPath(inputDirectory, outputDirectory, inputPath) {
  const relativePath = path.relative(inputDirectory, inputPath);

  if (relativePath === '' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new Error(`Input file must be inside the input directory: ${inputPath}`);
  }

  if (path.extname(relativePath) !== '.wizz') {
    throw new Error(`Input file must have a .wizz extension: ${inputPath}`);
  }

  return path.join(outputDirectory, relativePath.replace(/\.wizz$/, '.js'));
}

function writeGeneratedModule(outputPath, generatedModule, sourceMap) {
  if (sourceMap) {
    const sourceMapPath = `${outputPath}.map`;
    sourceMap.file = path.basename(outputPath);
    fs.writeFileSync(sourceMapPath, JSON.stringify(sourceMap), 'utf-8');
    fs.writeFileSync(
      outputPath,
      `${generatedModule}\n//# sourceMappingURL=${path.basename(sourceMapPath)}`,
      'utf-8'
    );
    return;
  }

  fs.writeFileSync(outputPath, generatedModule, 'utf-8');
}

function firstErrorLine(error) {
  return String(error.message).split('\n', 1)[0];
}

/**
 * Compiles and writes the client module for one .wizz file and returns the
 * artifacts the eligibility graph needs (raw source, analyzed payload).
 * Server and hydratable builds are written separately by writeServerBuilds
 * once import-graph eligibility is known, because whether a file may
 * server-render depends on the files it imports, not on its own template.
 *
 * With `options.diagnostics === 'collect'`, a compile failure is returned as
 * `{ diagnostics: [record] }` instead of thrown — the JSON build mode uses
 * this to aggregate per-file diagnostics — and a success carries
 * `diagnostics: []` alongside the artifacts. `options.filePath` overrides
 * the label compiler errors carry (the JSON mode passes the input-relative
 * path so records stay position-independent).
 */
function compileWizzFile(inputPath, outputPath, options = {}) {
  const rawWizzCode = fs.readFileSync(inputPath, 'utf-8');
  const collect = options.diagnostics === 'collect';
  const result = compile(rawWizzCode, {
    filePath: options.filePath || inputPath,
    ...(collect ? { diagnostics: 'collect' } : {})
  });

  if (collect && result.diagnostics.length > 0) {
    return { diagnostics: result.diagnostics };
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  writeGeneratedModule(outputPath, result.source, result.sourceMap);

  return { rawWizzCode, payload: result.payload, diagnostics: collect ? [] : undefined };
}

/**
 * Resolves a component import source (e.g. "./Counter.wizz") against the
 * importing file. Returns null for anything that is not a .wizz import
 * resolvable to a discovered project file — such imports are not components
 * of this build and are simply never vouched for.
 */
function resolveImportPath(inputPath, importSource, discoveredFiles) {
  if (typeof importSource !== 'string' || !importSource.endsWith('.wizz')) return null;
  const resolved = path.resolve(path.dirname(inputPath), importSource);
  return discoveredFiles.has(resolved) ? resolved : null;
}

/**
 * Computes server-rendering eligibility bottom-up over the import graph with
 * memoization: a file is eligible when its own server and hydratable targets
 * compile — with each rendered import vouched for by that child's own
 * eligibility — and every transitive .wizz import is eligible. This is what
 * lets a static component pulled into an eligible page ship a server build,
 * and what keeps a page whose child fails the gate client-only with the
 * child's own gate failure chained as the underlying reason.
 *
 * The graph is assumed to be a DAG (cyclic component imports have no
 * meaningful render order); a cycle is reported as ineligibility for every
 * file involved rather than recursing forever.
 */
function computeServerEligibility(inputFiles, compiledByInputPath, failureReasonsByInputPath, options = {}) {
  const discoveredFiles = new Set(inputFiles);
  const eligibilityByInputPath = new Map();
  const serverBuildsByInputPath = new Map();
  const visiting = new Set();
  const CYCLE_REASON = 'its import graph contains a cycle.';

  function compute(inputPath) {
    if (eligibilityByInputPath.has(inputPath)) return eligibilityByInputPath.get(inputPath);
    if (visiting.has(inputPath)) return { eligible: false, reason: CYCLE_REASON };
    // A file whose client build failed has no payload to walk and no reason
    // to re-report here; its own build failure was already reported.
    if (!compiledByInputPath.has(inputPath)) {
      return { eligible: false, reason: failureReasonsByInputPath.get(inputPath) || 'its client build failed' };
    }

    visiting.add(inputPath);
    try {
      const { rawWizzCode, payload } = compiledByInputPath.get(inputPath);
      const componentServerRenderable = {};
      const componentIneligibilityReasons = {};

      for (const { name, source } of payload.imports || []) {
        const childPath = resolveImportPath(inputPath, source, discoveredFiles);
        if (!childPath) continue;
        const childResult = compute(childPath);
        if (childResult.eligible) {
          componentServerRenderable[name] = true;
        } else {
          componentIneligibilityReasons[name] = childResult.reason;
        }
      }

      const gateOptions = { componentServerRenderable, componentIneligibilityReasons };
      const serverResult = compileServer(rawWizzCode, {
        filePath: inputPath,
        ...gateOptions,
        // Decorates child import specifiers so a development server's module
        // cache re-evaluates the child graph after a rebuild; empty for
        // production builds.
        moduleQuery: options.moduleQuery
      });
      const hydratableResult = compile(rawWizzCode, { filePath: inputPath, hydratable: true, ...gateOptions });

      serverBuildsByInputPath.set(inputPath, { serverResult, hydratableResult });
      const result = { eligible: true, reason: null };
      eligibilityByInputPath.set(inputPath, result);
      return result;
    } catch (error) {
      const result = { eligible: false, reason: firstErrorLine(error) };
      eligibilityByInputPath.set(inputPath, result);
      return result;
    } finally {
      visiting.delete(inputPath);
    }
  }

  for (const inputPath of inputFiles) compute(inputPath);

  return { eligibilityByInputPath, serverBuildsByInputPath };
}

/**
 * Writes the server and hydratable builds for one eligible file from the
 * artifacts cached during the eligibility walk, so nothing is compiled twice.
 */
function writeEligibleServerBuilds(inputPath, outputPath, serverBuilds) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  // Server output carries no source map (HTML string rendering, not
  // positional DOM artifacts); the hydratable build mirrors the client
  // build's source-map presence.
  writeGeneratedModule(outputPath.replace(/\.js$/, '.server.js'), serverBuilds.serverResult.source, null);
  writeGeneratedModule(outputPath.replace(/\.js$/, '.hydrate.js'), serverBuilds.hydratableResult.source, serverBuilds.hydratableResult.sourceMap);
}

function copyRuntimeModules(outputDirectory) {
  const runtimeSourceDirectory = path.join(__dirname, 'src', 'runtime');
  const runtimeOutputDirectory = path.join(outputDirectory, 'runtime');

  fs.cpSync(runtimeSourceDirectory, runtimeOutputDirectory, { recursive: true });
}

/**
 * Collects every compiled component's scoped CSS in discovery order (the
 * client payloads are cached in the order discoverWizzFiles found them, so
 * the extracted stylesheet is byte-stable across identical builds). Scoping
 * runs through the same scopeCss the generators use, so the extracted
 * stylesheet always agrees with the markup it scopes.
 */
function extractComponentStyles(inputDirectory, compiledByInputPath) {
  const styles = [];

  for (const [inputPath, compiled] of compiledByInputPath) {
    if (!compiled.payload.style) continue;
    styles.push({
      filePath: path.relative(inputDirectory, inputPath).split(path.sep).join('/'),
      css: scopeCss(compiled.payload.style.css, compiled.payload.style.scope)
    });
  }

  return styles;
}

function writeExtractedStyles(outputDirectory, styles) {
  if (styles.length === 0) return false;

  // A per-file header comment keeps the extracted stylesheet debuggable;
  // CSS comments are inert, so delivery semantics are unaffected.
  const stylesheet = styles
    .map(({ filePath, css }) => `/* ${filePath} */\n${css}`)
    .join('\n\n');
  fs.writeFileSync(path.join(outputDirectory, STYLESHEET_FILENAME), `${stylesheet}\n`, 'utf8');
  return true;
}

/**
 * Locates the project's document shell. Projects either keep index.html
 * beside their components (the input directory itself) or at the project
 * root with components in a subdirectory (the conventional `wizz build src
 * dist` layout), so both locations are probed before giving up.
 */
function findDocumentShell(inputDirectory) {
  const inputShell = path.join(inputDirectory, 'index.html');
  if (fs.existsSync(inputShell)) return inputShell;
  const parentShell = path.join(inputDirectory, '..', 'index.html');
  if (fs.existsSync(parentShell)) return parentShell;
  return null;
}

/**
 * Copies the project's document shell into the output directory, injecting
 * the app.css link before </head> when component styles were extracted. A
 * shell that already links /app.css is left untouched (no double link), and
 * a project without a shell keeps today's behavior — the dev server reports
 * the missing shell at serve time.
 *
 * A global App.css beside the shell is part of the document set: shells link
 * it as ./App.css, and the dev server copies it alongside index.html, so a
 * production build copies it too or the shell's link would 404. It is looked
 * up beside the located shell (input directory or its parent), matching both
 * build layouts.
 */
function copyDocumentShell(inputDirectory, outputDirectory, hasStyles, logger = console) {
  const shellPath = findDocumentShell(inputDirectory);
  if (shellPath === null) {
    if (hasStyles) {
      logger.log(`Note: component styles were extracted to ${STYLESHEET_FILENAME}, but no index.html document shell was found (looked in the input directory and its parent) to link it from.`);
    }
    return false;
  }

  let shell = fs.readFileSync(shellPath, 'utf8');
  if (hasStyles && !STYLESHEET_HREF_PATTERN.test(shell)) {
    if (!/<\/head/i.test(shell)) {
      logger.log(`Note: the document shell has no <head> element, so the extracted ${STYLESHEET_FILENAME} is not linked.`);
    } else {
      // Function-form replacement: the shell may contain `$` sequences
      // (`$&`, `$'`, `$$`) that string-form replacement would expand.
      shell = shell.replace(/([ \t]*)<\/head(\s*)?>/i, (match, indent) => (
        `${indent}<link rel="stylesheet" href="/${STYLESHEET_FILENAME}">\n${indent}</head>`
      ));
    }
  }

  fs.writeFileSync(path.join(outputDirectory, 'index.html'), shell, 'utf8');

  const shellStylesheetPath = path.join(path.dirname(shellPath), 'App.css');
  if (fs.existsSync(shellStylesheetPath)) {
    const destAppCssPath = path.join(outputDirectory, 'App.css');
    const destExtractedCssPath = path.join(outputDirectory, STYLESHEET_FILENAME);

    let isSameFile = false;
    if (fs.existsSync(destExtractedCssPath)) {
      try {
        const stat1 = fs.statSync(destAppCssPath);
        const stat2 = fs.statSync(destExtractedCssPath);
        isSameFile = stat1.ino === stat2.ino && stat1.dev === stat2.dev;
      } catch {
        // A failed stat means one of the two paths does not exist, and a
        // missing file cannot be the same file as an existing one — so the
        // copy must proceed. Case-insensitive path comparison would be wrong
        // here: on a case-sensitive filesystem `dist/App.css` and
        // `dist/app.css` are distinct files (the stat fails precisely because
        // `App.css` is not written yet), and merging would drop the shell
        // stylesheet entirely. On case-insensitive filesystems the statSync
        // above resolves the lookup itself, so the ino comparison already
        // answered the same-file question.
        isSameFile = false;
      }
    }

    if (isSameFile) {
      const globalCss = fs.readFileSync(shellStylesheetPath, 'utf8');
      const existingExtractedCss = fs.readFileSync(destExtractedCssPath, 'utf8');
      fs.writeFileSync(destExtractedCssPath, `${globalCss}\n\n${existingExtractedCss}`, 'utf8');
    } else {
      fs.copyFileSync(shellStylesheetPath, destAppCssPath);
    }
  }
  return true;
}

function getRoutePath(inputDirectory, inputPath) {
  const relativePath = path.relative(inputDirectory, inputPath);
  const segments = relativePath.split(path.sep);

  if (segments.length === 1 && segments[0] === 'App.wizz') return '/';
  if (segments[0] !== 'pages' || path.extname(relativePath) !== '.wizz') return null;

  const pageSegments = segments.slice(1, -1);
  const pageName = path.basename(inputPath, '.wizz');
  if (pageName !== 'index') pageSegments.push(pageName);

  return `/${pageSegments.join('/').toLowerCase()}`.replace(/\/$/, '') || '/';
}

function validateRouteEntries(routeEntries) {
  const routes = new Map();

  for (const routeEntry of routeEntries) {
    if (routeEntry.routePath === '/api' || routeEntry.routePath.startsWith('/api/')) {
      const error = new Error(`Route '${routeEntry.routePath}' is reserved for server API routes: ${routeEntry.filePath}`);
      error.filePath = routeEntry.inputPath;
      throw error;
    }

    if (routeEntry.routePath === '/runtime' || routeEntry.routePath.startsWith('/runtime/')) {
      const error = new Error(`Route '${routeEntry.routePath}' is reserved for Wizz runtime files: ${routeEntry.filePath}`);
      error.filePath = routeEntry.inputPath;
      throw error;
    }

    // Handler copies land in `dist/server/` for external Node hosts, and the
    // dev server refuses `/server/**` requests rather than ever serving those
    // copies as static files — so a page routed here would be silently
    // unreachable in development SSR. Fail the build with the page named,
    // like the /api reservation.
    if (routeEntry.routePath === '/server' || routeEntry.routePath.startsWith('/server/')) {
      const error = new Error(`Route '${routeEntry.routePath}' is reserved for server handler output: ${routeEntry.filePath}`);
      error.filePath = routeEntry.inputPath;
      throw error;
    }

    const existingEntry = routes.get(routeEntry.routePath);
    if (existingEntry) {
      const error = new Error(
        `Ambiguous route '${routeEntry.routePath}' is claimed by ${existingEntry.filePath} and ${routeEntry.filePath}`
      );
      error.filePath = routeEntry.inputPath;
      throw error;
    }
    routes.set(routeEntry.routePath, routeEntry);
  }
}

function emitRouteManifest(inputDirectory, outputDirectory, inputFiles, serverRenderableByInputPath = new Map()) {
  const routeFiles = inputFiles.filter((inputPath) => getRoutePath(inputDirectory, inputPath));
  const routeEntries = routeFiles.map((inputPath) => {
    const outputPath = getOutputPath(inputDirectory, outputDirectory, inputPath);
    return {
      inputPath,
      filePath: path.relative(inputDirectory, inputPath).split(path.sep).join('/'),
      modulePath: path.relative(path.join(outputDirectory, 'runtime'), outputPath).split(path.sep).join('/'),
      routePath: getRoutePath(inputDirectory, inputPath)
    };
  });
  validateRouteEntries(routeEntries);
  const pageModules = routeEntries.map(({ filePath, modulePath, routePath, inputPath }) => {
    // Eligibility is a build-time artifact: the manifest field is the single
    // authority on whether a route server-renders, so the dev server never
    // probes the filesystem for stale server modules from earlier builds.
    const serverRenderable = serverRenderableByInputPath.get(inputPath) === true;
    return {
      filePath,
      modulePath,
      routePath,
      serverModulePath: serverRenderable ? modulePath.replace(/\.js$/, '.server.js') : null,
      hydratableModulePath: serverRenderable ? modulePath.replace(/\.js$/, '.hydrate.js') : null
    };
  });
  const manifestPath = path.join(outputDirectory, 'runtime', 'routes.js');

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(
    manifestPath,
    `// Generated by Wizz. Edits will be overwritten.\nexport const pageModules = ${JSON.stringify(pageModules, null, 2)};\n`,
    'utf8'
  );
}

// Milestone 21: server API handlers ship for external Node hosts. The
// authored modules under `<input>/server/**` are copied verbatim — they are
// hand-written zero-dependency ESM, not compiler output — and the manifest
// (`dist/runtime/apiRoutes.js`) advertises routePath -> modulePath for the
// routable `server/api` subset the same way the page manifest does. Private
// `_`-prefixed modules copy too (handlers import them) but never appear in
// the manifest; a relative import reaching outside `src/server` has no copy
// and fails the import with a clear module-not-found. Source mtimes are
// preserved on the copies so the dev server's per-request staleness
// comparison stays stable. Discovery rejects duplicate routes; a secret file
// like `.env.server` lives in the project root and is never touched.
//
// A route collision does not throw: the caller receives `{ error }` and the
// manifest is still written (empty), so neither the dev server nor an
// external host can route an ambiguous handler — and no stale manifest from
// an earlier build can survive. The build counts the failure; nothing routes.
function copyApiHandlers(inputDirectory, outputDirectory) {
  const serverSourceDirectory = path.join(inputDirectory, 'server');
  const apiSourceDirectory = path.join(serverSourceDirectory, 'api');
  const manifestPath = path.join(outputDirectory, 'runtime', 'apiRoutes.js');
  const writeManifest = (entries) => {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(
      manifestPath,
      `// Generated by Wizz. Edits will be overwritten.\nexport const apiModules = ${JSON.stringify(entries, null, 2)};\n`,
      'utf8'
    );
  };

  let routes;
  try {
    routes = discoverApiRoutes(apiSourceDirectory);
  } catch (error) {
    writeManifest([]);
    return { error: firstErrorLine(error), entries: [] };
  }

  for (const modulePath of listJavaScriptFiles(serverSourceDirectory)) {
    const outputPath = path.join(outputDirectory, 'server', path.relative(serverSourceDirectory, modulePath));
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.copyFileSync(modulePath, outputPath);
    // Preserve the source mtime: the dev server compares these timestamps
    // per request to re-copy edited handlers without a rebuild. utimesSync
    // accepts Dates (raw numbers would read as seconds — the *Ms fields are
    // not).
    const { atime, mtime } = fs.statSync(modulePath);
    fs.utimesSync(outputPath, atime, mtime);
  }

  const entries = [...routes.values()].map(({ routePath, modulePath }) => {
    const outputPath = path.join(outputDirectory, 'server', path.relative(serverSourceDirectory, modulePath));
    return {
      filePath: path.relative(inputDirectory, modulePath).split(path.sep).join('/'),
      routePath,
      modulePath: path.relative(path.join(outputDirectory, 'runtime'), outputPath).split(path.sep).join('/')
    };
  });

  writeManifest(entries);
  return { error: null, entries };
}

// The node adapter's generated host: a self-contained SSR + API server for
// this build. It imports only Node builtins and the build's own artifacts
// (runtime/routes.js, runtime/apiRoutes.js, .server.js modules) so the
// deployment contract stays "dist/ is self-contained" — no framework code
// ships with it. The serving protocol mirrors the development server:
// traversal-guarded static files, exact-pathname route rendering with head
// markers and the state script as a sibling of the mount point, /api/**
// handlers behind the same frozen request context and return shapes, a
// 404-JSON answer for unmatched API paths, and the document shell as the SPA
// fallback. /server/** is never served as a static file, so handler source
// and private modules stay unreachable. Known divergences from dev: no
// module cache-busting (a production host is not rebuilt while running),
// no live-reload endpoint, and .env.server loads from the invocation CWD
// (the conservative assumption here; deployment platforms normally provide
// environment variables directly, and real values are never overridden).
// The generated code deliberately avoids template literals: this source is
// one template literal, and generated interpolation would need escaping.
const NODE_ADAPTER_HOST_SOURCE = `// Generated by Wizz (node adapter). Edits will be overwritten.
// A self-contained SSR + API host for this build. Deploy this directory and
// run: node server.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dist = path.dirname(fileURLToPath(import.meta.url));
const runtimeDirectory = path.join(dist, 'runtime');
const API_ROUTE_PREFIX = '/api';
const SERVER_OUTPUT_PREFIX = '/server';
const MAX_BODY_BYTES = 1024 * 1024;
const mountPoint = '<div id="app"></div>';
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

function fail(message) {
  console.error(message);
  process.exit(1);
}

let pageModules;
let apiModules;
try {
  const routesManifest = await import(pathToFileURL(path.join(runtimeDirectory, 'routes.js')).href);
  const apiManifest = await import(pathToFileURL(path.join(runtimeDirectory, 'apiRoutes.js')).href);
  pageModules = routesManifest.pageModules;
  apiModules = apiManifest.apiModules;
} catch (error) {
  fail('This host needs a Wizz build: dist/runtime/routes.js and dist/runtime/apiRoutes.js are missing or unreadable (' + error.message + '). Run \`wizz build\` first.');
}

// Exact pathname lookup mirrors the client router, so the server never
// delivers markup the router would not claim. Table lookups, never
// filesystem joins: '..' segments and encoded traversal have nothing to
// resolve against.
const routeTable = new Map(pageModules.map((moduleEntry) => [moduleEntry.routePath, moduleEntry]));
const apiTable = new Map(apiModules.map((moduleEntry) => [moduleEntry.routePath, moduleEntry]));

// The document shell every route document is assembled into and every
// unmatched extensionless path falls back to.
const shellPath = path.join(dist, 'index.html');
if (!fs.existsSync(shellPath) || !fs.statSync(shellPath).isFile()) {
  fail('dist/index.html is missing: this build copied no document shell.');
}
const shell = fs.readFileSync(shellPath, 'utf8');
if (!shell.includes(mountPoint)) {
  fail('The document shell has no <div id="app"></div> mount point: dist/index.html');
}

// Server secrets for API handlers, loaded once before the first request
// from the directory the host is started in — the file is data, never a
// script, and real environment values are never overridden.
function loadServerEnv(projectDirectory, targetEnv = process.env) {
  const envPath = path.join(path.resolve(projectDirectory), '.env.server');
  if (!fs.existsSync(envPath) || !fs.statSync(envPath).isFile()) return;
  const contents = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of contents.split(/\\r?\\n/)) {
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
  }
}
loadServerEnv(process.cwd());

// A request body larger than this never reaches a handler: this is an
// internet-facing HTTP endpoint, and node:http imposes no body limit.
function readRequestBody(request, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const onData = (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        request.removeListener('data', onData);
        request.pause();
        const error = new Error('Request body exceeds the ' + maxBytes + '-byte limit.');
        error.statusCode = 413;
        reject(error);
        return;
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    };
    request.on('data', onData);
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

// The frozen, platform-plain context a handler receives. Nothing from Node's
// req/res objects leaks through. json() parses lazily with no reviver, so a
// hostile __proto__ key stays inert data on the parsed object.
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
        const error = new Error('Request body is not valid JSON.');
        error.statusCode = 400;
        throw error;
      }
    }
  };
  return Object.freeze(context);
}

// Sends a handler's return value: undefined answers 204; an object carrying
// an integer status 200-599 is a full response ({ status, headers, body });
// anything else answers 200 as JSON; strings pass through verbatim.
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

// A 500 never carries the underlying message — handler errors can quote
// secrets, file paths, or third-party responses, so the client gets a fixed
// body and the server log gets the detail.
function sendApiErrorResponse(response, statusCode, detail) {
  const body = statusCode === 500
    ? '{"error":"Internal server error"}'
    : '{"error":' + JSON.stringify(statusCode === 404 ? 'Not found' : statusCode === 413 ? 'Request body too large' : 'Bad request') + '}';
  if (statusCode === 500 && detail) {
    console.error('API handler failed: ' + detail);
  }
  // A refused upload means the client is mid-body: Connection: close tells
  // it the remaining bytes are unwanted rather than left draining.
  const headers = statusCode === 413
    ? { 'Content-Type': 'application/json; charset=utf-8', Connection: 'close' }
    : { 'Content-Type': 'application/json; charset=utf-8' };
  response.writeHead(statusCode, headers);
  response.end(body);
}

async function handleApiRequest(request, response, url, requestPath) {
  const routeEntry = apiTable.get(requestPath);
  if (!routeEntry) {
    sendApiErrorResponse(response, 404);
    return;
  }

  try {
    const body = await readRequestBody(request);
    const context = createApiRequestContext(request, url, body, requestPath);
    const handlerModule = await import(pathToFileURL(path.resolve(runtimeDirectory, routeEntry.modulePath)).href);
    const handler = handlerModule.default;
    if (typeof handler !== 'function') {
      throw new Error('API module has no default export function: ' + routeEntry.filePath);
    }
    const result = await handler(context);
    sendApiResult(response, result);
  } catch (error) {
    // Framework-level request problems carry the status to answer with;
    // everything else is a 500 whose detail goes to the log, never the client.
    const statusCode = error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    sendApiErrorResponse(response, statusCode, routeEntry.routePath + ': ' + error.message);
  }
}

async function renderDocument(routeEntry) {
  // Manifest paths resolve relative to runtime/. The ESM cache holds the
  // module after its first import, and renderComponent() is stateless, so
  // concurrent requests are safe.
  const serverModulePath = path.resolve(runtimeDirectory, routeEntry.serverModulePath);
  const serverModule = await import(pathToFileURL(serverModulePath).href);
  const { html, state, head } = serverModule.renderComponent();
  const stateScript = serverModule.serializeInitialState(state);
  // Marker-delimited so the client's hydration run can locate the delivered
  // head. html goes INSIDE the mount point; the state script is its sibling —
  // never inside, or the hydration walk's child count is wrong.
  const headRun = head ? '<!--wizz:head-start-->' + head + '<!--wizz:head-end-->' : '';
  // Function-form replacement: rendered HTML may contain '$' sequences
  // ('$&', '$'', '$$') that string-form replacement would expand.
  return shell
    .replace(mountPoint, () => '<div id="app">' + html + '</div>\\n  ' + stateScript)
    .replace('</head>', () => headRun + '</head>');
}

// Realpath containment for static serving: the path.relative prefix check
// is lexical, so a symlink inside dist pointing outside would pass it.
// Resolve the candidate's canonical path and re-check it against the
// canonical dist, resolved once on first use so a symlinked dist ancestor
// keeps serving. Every failure — a dangling symlink, an unreadable
// ancestor, a NUL byte — conservatively answers false: the request falls
// through to the not-a-file paths.
let canonicalDist = null;
function resolveWithinRealDist(candidate) {
  try {
    if (canonicalDist === null) canonicalDist = fs.realpathSync(dist);
    const realPath = fs.realpathSync(candidate);
    return realPath === canonicalDist || realPath.startsWith(canonicalDist + path.sep);
  } catch {
    return false;
  }
}

async function handleRequest(request, response) {
  let requestPath;
  let url;
  try {
    // Concatenated into a fixed origin rather than parsed against a base:
    // a base would re-parse an origin-form target starting with '//' as
    // protocol-relative, silently promoting its first path segment to an
    // authority (dropping path segments, or throwing on an invalid host).
    // This host is not a proxy, so an absolute-form target lands in the
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
  if (requestPath.includes('\\0')) {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Bad request');
    return;
  }

  // Handler copies live in dist/server/ after a build: never served as
  // static files, so handler source and private modules are unreachable.
  if (requestPath === SERVER_OUTPUT_PREFIX || requestPath.startsWith(SERVER_OUTPUT_PREFIX + '/')) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  const filePath = path.resolve(dist, '.' + requestPath);
  const relative = path.relative(dist, filePath);
  const isInsideDist = relative === ''
    || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
  const isFile = isInsideDist
    && fs.existsSync(filePath)
    && fs.statSync(filePath).isFile()
    && resolveWithinRealDist(filePath);

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

  // Unmatched API paths answer 404 JSON — never the SPA shell, which would
  // make an API miss look like a 200 HTML page.
  if (requestPath === API_ROUTE_PREFIX || requestPath.startsWith(API_ROUTE_PREFIX + '/')) {
    await handleApiRequest(request, response, url, requestPath);
    return;
  }

  const routeEntry = routeTable.get(requestPath);
  if (routeEntry && routeEntry.serverModulePath) {
    try {
      const document = await renderDocument(routeEntry);
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(document);
    } catch (error) {
      // A route whose server module fails falls back to the shell, exactly
      // like the development server: hydration picks the page up client-side.
      console.error('Server rendering failed for ' + routeEntry.routePath + ': ' + error.message);
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(shell);
    }
    return;
  }

  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(shell);
}

let port = 8080;
if (process.env.PORT !== undefined) {
  const parsedPort = Number(process.env.PORT);
  if (!/^\\d+$/.test(process.env.PORT) || !Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
    fail('Invalid PORT: must be an integer between 0 and 65535.');
  }
  port = parsedPort;
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    console.error(error.message);
    if (!response.headersSent) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Internal server error');
    } else {
      response.destroy();
    }
  });
});

server.listen(port, () => {
  console.log('wizz node adapter serving http://localhost:' + port + ' from ' + dist);
});
`;

function emitNodeAdapterHost(outputDirectory, logger = console) {
  const outputPath = path.join(outputDirectory, NODE_ADAPTER_HOST_FILENAME);
  fs.writeFileSync(outputPath, NODE_ADAPTER_HOST_SOURCE, 'utf8');
  logger.log(`Generated the node adapter host: ${outputPath}`);
  return outputPath;
}

function buildProject(inputDirectory, outputDirectory, logger = console, options = {}) {
  // JSON mode aggregates per-file diagnostics and a files manifest instead of
  // prose logging; a build-level failure (bad directories, route collision)
  // is returned as an envelope record rather than thrown. Everything else —
  // artifact writing, eligibility, exit-code semantics — is identical.
  const jsonMode = options.json === true;
  // An unknown adapter name from a direct buildProject caller is programmer
  // error, not author error: an uncoded TypeError guard (entry-point argument
  // validation stays uncoded by design, like the other entry-point guards).
  if (options.adapter !== undefined && options.adapter !== null && !KNOWN_ADAPTERS.includes(options.adapter)) {
    throw new TypeError(`Unknown build adapter: ${options.adapter}. Known adapters: ${KNOWN_ADAPTERS.join(', ')}.`);
  }
  const adapterName = options.adapter ?? null;
  const jsonDiagnostics = [];
  const jsonFiles = [];
  let resolvedInputDirectory = null;
  let failedCount = 0;
  let compiledFileCount = 0;

  try {
    const resolvedOutputDirectory = path.resolve(outputDirectory);
    resolvedInputDirectory = path.resolve(inputDirectory);

    if (!fs.existsSync(resolvedInputDirectory) || !fs.statSync(resolvedInputDirectory).isDirectory()) {
      throw new Error(`Input directory does not exist or is not a directory: ${resolvedInputDirectory}`);
    }

    if (resolvedInputDirectory === resolvedOutputDirectory) {
      throw new Error('Input and output directories must be different.');
    }

    const inputFiles = discoverWizzFiles(resolvedInputDirectory);

    // Pass 1 — client builds. Every .wizz file gets its browser module; a
    // client-side failure is reported and recorded so importing files can chain
    // it as their own ineligibility reason.
    const compiledByInputPath = new Map();
    const failureReasonsByInputPath = new Map();
    for (const inputPath of inputFiles) {
      const outputPath = getOutputPath(resolvedInputDirectory, resolvedOutputDirectory, inputPath);

      try {
        if (jsonMode) {
          // Records carry input-relative paths so JSON consumers get
          // position-independent locations.
          const outcome = compileWizzFile(inputPath, outputPath, {
            diagnostics: 'collect',
            filePath: toPosixPath(path.relative(resolvedInputDirectory, inputPath))
          });
          if (outcome.diagnostics.length > 0) {
            failedCount++;
            failureReasonsByInputPath.set(inputPath, outcome.diagnostics[0].message);
            jsonDiagnostics.push(...outcome.diagnostics);
            continue;
          }
          compiledByInputPath.set(inputPath, outcome);
          compiledFileCount++;
        } else {
          compiledByInputPath.set(inputPath, compileWizzFile(inputPath, outputPath));
          compiledFileCount++;
          logger.log(`Compiled ${inputPath} -> ${outputPath}`);
        }
      } catch (error) {
        failedCount++;
        failureReasonsByInputPath.set(inputPath, firstErrorLine(error));
        if (jsonMode) {
          // Not a compiler diagnostic (a filesystem failure, an unexpected
          // throw): an uncoded record keeps the envelope total — every
          // failed file shows up in diagnostics.
          jsonDiagnostics.push({
            code: null,
            severity: 'error',
            message: firstErrorLine(error),
            file: toPosixPath(path.relative(resolvedInputDirectory, inputPath)),
            line: null,
            column: null
          });
        } else {
          logger.error(`Compilation failed for ${inputPath}: ${error.message}`);
        }
      }
    }

    // Pass 2 — eligibility over the import graph, computed bottom-up with the
    // client payloads. Both server targets are compiled here (once per file)
    // and cached for writing, so an eligible page never ships a server module
    // without its hydratable client build.
    const { eligibilityByInputPath, serverBuildsByInputPath } = computeServerEligibility(
      inputFiles,
      compiledByInputPath,
      failureReasonsByInputPath,
      // Threaded through so the development server can decorate child import
      // specifiers per rebuild; production builds leave it empty.
      { moduleQuery: options.moduleQuery }
    );

    // Pass 3 — server artifacts for eligible files (pages AND components: a
    // page's server module imports its components' server modules), and
    // ineligibility notes for everything else.
    const serverRenderableByInputPath = new Map();
    for (const inputPath of inputFiles) {
      if (!compiledByInputPath.has(inputPath)) continue;

      const outputPath = getOutputPath(resolvedInputDirectory, resolvedOutputDirectory, inputPath);
      const eligibility = eligibilityByInputPath.get(inputPath);

      if (eligibility.eligible) {
        writeEligibleServerBuilds(inputPath, outputPath, serverBuildsByInputPath.get(inputPath));
        serverRenderableByInputPath.set(inputPath, true);
      } else {
        serverRenderableByInputPath.set(inputPath, false);
        logger.log(`Note: server rendering skipped for ${inputPath} — ${eligibility.reason} Serving the client build only.`);
      }
    }

    copyRuntimeModules(resolvedOutputDirectory);
    // A collision is a build failure (non-zero exit) but never a crash: the
    // empty manifest is already on disk, so neither the dev server nor an
    // external host routes the ambiguous handler.
    const apiResult = copyApiHandlers(resolvedInputDirectory, resolvedOutputDirectory);
    if (apiResult.error) {
      failedCount++;
      if (jsonMode) {
        jsonDiagnostics.push({
          code: null,
          severity: 'error',
          message: apiResult.error,
          file: null,
          line: null,
          column: null
        });
      } else {
        logger.error(`Server API route discovery failed: ${apiResult.error}`);
      }
    }
    emitRouteManifest(resolvedInputDirectory, resolvedOutputDirectory, inputFiles, serverRenderableByInputPath);

    // Pass 4 — style extraction and shell copy: production builds get one
    // app.css carrying every component's scoped rules, linked from the copied
    // shell so first paint is styled with zero runtime work. The dev server's
    // per-document <style> injection keeps working unchanged on top of this.
    const extractedStyles = extractComponentStyles(resolvedInputDirectory, compiledByInputPath);
    writeExtractedStyles(resolvedOutputDirectory, extractedStyles);
    copyDocumentShell(resolvedInputDirectory, resolvedOutputDirectory, extractedStyles.length > 0, logger);

    // The output directory holds ES modules and their assets, so pin the module
    // type beside the emitted artifacts: Node-side imports — the dev server's
    // SSR imports, and application servers following the SSR recipe — must work
    // on every supported runtime, and Node 18 has no module-syntax detection to
    // fall back on. A package.json the output already carries is respected: it
    // may be the embedding project's deliberate choice.
    const moduleTypeMarkerPath = path.join(resolvedOutputDirectory, 'package.json');
    if (!fs.existsSync(moduleTypeMarkerPath)) {
      fs.writeFileSync(moduleTypeMarkerPath, '{"type":"module"}\n', 'utf8');
    }

    // Adapter emission is build-only and opt-in: the dev server implements
    // the same serving protocol itself and gains nothing from the host file.
    // Emitted unconditionally once requested — even with a route collision —
    // consistent with the manifests, which always write.
    if (adapterName === 'node') {
      emitNodeAdapterHost(resolvedOutputDirectory, logger);
    }

    if (jsonMode) {
      // The files manifest mirrors the route discovery order, so it is
      // byte-stable across identical builds. Files whose client build failed
      // never server-render.
      for (const inputPath of inputFiles) {
        jsonFiles.push({
          file: toPosixPath(path.relative(resolvedInputDirectory, inputPath)),
          serverRenderable: serverRenderableByInputPath.get(inputPath) === true
        });
      }
    }

    return {
      compiledCount: inputFiles.length - failedCount,
      failedCount,
      ...(jsonMode ? { ok: failedCount === 0, diagnostics: jsonDiagnostics, files: jsonFiles } : {})
    };
  } catch (error) {
    if (!jsonMode) throw error;

    // A build-level failure (bad directories, a route collision, an
    // unexpected filesystem error) is returned as an envelope record with a
    // null code instead of thrown, so `--json` output stays machine-parsable
    // on every failure path.
    let file = null;
    if (error && error.filePath && resolvedInputDirectory) {
      file = toPosixPath(path.relative(resolvedInputDirectory, error.filePath)) || null;
    }

    return {
      compiledCount: compiledFileCount,
      failedCount,
      ok: false,
      diagnostics: [{
        code: null,
        severity: 'error',
        message: firstErrorLine(error),
        file,
        line: null,
        column: null
      }],
      files: jsonFiles
    };
  }
}

function main(argv, logger = console) {
  const { inputDirectory, outputDirectory, json, adapter } = parseBuildArguments(argv);
  // In JSON mode stdout carries only the envelope, so the per-file prose the
  // build logs is suppressed at this CLI boundary.
  const result = buildProject(
    inputDirectory,
    outputDirectory,
    json ? { log() {}, error() {} } : logger,
    json ? { json: true, adapter } : { adapter }
  );

  if (json) {
    // The adapter field is additive within format version 1: absent unless
    // an adapter ran, so static-build consumers see an unchanged envelope.
    console.log(JSON.stringify({
      format: BUILD_DIAGNOSTICS_FORMAT,
      ok: result.ok,
      diagnostics: result.diagnostics,
      files: result.files,
      ...(adapter ? { adapter } : {})
    }, null, 2));
  }

  return result.failedCount === 0 && result.ok !== false ? 0 : 1;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  BUILD_DIAGNOSTICS_FORMAT,
  KNOWN_ADAPTERS,
  NODE_ADAPTER_HOST_FILENAME,
  NODE_ADAPTER_HOST_SOURCE,
  emitNodeAdapterHost,
  copyApiHandlers,
  buildProject,
  compileWizzFile,
  computeServerEligibility,
  copyDocumentShell,
  extractComponentStyles,
  findDocumentShell,
  writeExtractedStyles,
  copyRuntimeModules,
  discoverWizzFiles,
  emitRouteManifest,
  getRoutePath,
  validateRouteEntries,
  getOutputPath,
  main,
  parseBuildArguments
};

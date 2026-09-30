#!/usr/bin/env node
const os = require('node:os');
const path = require('node:path');
const { main: buildProject, KNOWN_ADAPTERS } = require('../build');
const { startDevelopmentServer } = require('./dev');
const { startMcpServer } = require('./mcp');
const { initProject } = require('./init');
const { update: updateInstallation } = require('./update');
const { installVscodeExtension } = require('./installVscodeExtension');
const { DEFAULT_REPOSITORY } = require('./releaseAssets');
const { VERSIONS } = require('../src/compiler');

const USAGE = `Usage:
  wizz init [directory] [--force]   Scaffold a starter project
  wizz build [input-directory] [output-directory] [--json] [--adapter <name>]
  wizz dev [--port <n>]             Start the development server
  wizz mcp [--root <dir>] [--allow-write]
                                    Serve Wizz tooling to AI agents over MCP (stdio)
  wizz update                       Update the managed installation to the latest release
  wizz install-vscode-extension     Install the latest VS Code extension from a release
  wizz --version                    Print the compiler and contract versions`;

function parseCommand(argv) {
  if (!Array.isArray(argv)) {
    throw new TypeError('CLI arguments must be an array.');
  }

  const [command, ...argumentsList] = argv;

  if (command === '--version' || command === 'version') {
    if (argumentsList.length !== 0) {
      throw new Error('Version does not accept arguments.\n\n' + USAGE);
    }
    return { command: 'version', argumentsList: [], json: false, force: false, adapter: null };
  }

  if (command !== 'build' && command !== 'dev' && command !== 'init' && command !== 'mcp' &&
      command !== 'update' && command !== 'install-vscode-extension') {
    throw new Error(USAGE);
  }

  // The release-backed commands take no arguments at all: a stray `--json`
  // here is a mistake, not a directory, so it is rejected rather than
  // silently reinterpreted (the same discipline the dev command applies).
  if (command === 'update' || command === 'install-vscode-extension') {
    if (argumentsList.length !== 0) {
      throw new Error(`The ${command} command does not accept arguments.\n\n` + USAGE);
    }
    return { command, argumentsList: [], json: false, force: false, adapter: null };
  }

  // `--json` is a build flag, not a directory: it may appear in any position
  // and is stripped before the positional count check. The build layer
  // re-parses it from argv, so it is re-appended here rather than threaded
  // as an option. Init keeps the strip from the historical contract; every
  // other command sees the flag in its positional list, so the strict
  // argument checks reject it instead of silently ignoring it.
  const stripJson = command === 'build' || command === 'init';
  const json = stripJson && argumentsList.includes('--json');
  const positional = stripJson
    ? argumentsList.filter((argument) => argument !== '--json')
    : argumentsList;

  if (command === 'build') {
    // `--adapter <name>` / `--adapter=<name>` is a build flag like `--json`:
    // any position, stripped before the positional count check, and
    // re-appended for the build layer to re-parse. The name is validated here
    // so a typo fails at the CLI boundary with the known-adapter list.
    let adapter = null;
    const withoutAdapter = [];
    for (let index = 0; index < positional.length; index++) {
      const argument = positional[index];
      if (argument === '--adapter' || argument.startsWith('--adapter=')) {
        const value = argument === '--adapter' ? positional[index + 1] : argument.slice('--adapter='.length);
        if (value === undefined || value === '' || !KNOWN_ADAPTERS.includes(value)) {
          throw new Error(`Build --adapter requires a known adapter name (${KNOWN_ADAPTERS.join(', ')}).\n\n` + USAGE);
        }
        if (adapter !== null) {
          throw new Error('Build accepts at most one --adapter flag.\n\n' + USAGE);
        }
        adapter = value;
        if (argument === '--adapter') index++;
        continue;
      }
      withoutAdapter.push(argument);
    }
    if (withoutAdapter.length !== 0 && withoutAdapter.length !== 2) {
      throw new Error('Build accepts either no directories or both <input-directory> and <output-directory>.\n\n' + USAGE);
    }
    return { command, argumentsList: withoutAdapter, json, force: false, adapter };
  }

  if (command === 'init') {
    // A stray --adapter here is a mistake, not a directory: rejected rather
    // than silently reinterpreted (the same discipline as the strict checks
    // below), since init's own target check would misreport it.
    if (positional.some((argument) => argument === '--adapter' || argument.startsWith('--adapter='))) {
      throw new Error('Init does not accept arguments.\n\n' + USAGE);
    }
  }

  if (command === 'dev') {
    let port = 3000;
    let portSeen = false;
    const remainingArgs = [];
    for (let i = 0; i < positional.length; i++) {
      const arg = positional[i];
      if (arg === '--port') {
        if (i + 1 >= positional.length) {
          throw new Error('Dev --port requires a valid port number.\n\n' + USAGE);
        }
        if (portSeen) {
          throw new Error('Dev accepts at most one --port flag.\n\n' + USAGE);
        }
        portSeen = true;
        const portStr = positional[i + 1];
        i++;
        const parsedPort = Number(portStr);
        if (!/^\d+$/.test(portStr) || !Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
          throw new Error('Dev --port requires a valid port number.\n\n' + USAGE);
        }
        port = parsedPort;
      } else if (arg.startsWith('--port=')) {
        if (portSeen) {
          throw new Error('Dev accepts at most one --port flag.\n\n' + USAGE);
        }
        portSeen = true;
        const portStr = arg.slice(7);
        const parsedPort = Number(portStr);
        if (portStr === '' || !/^\d+$/.test(portStr) || !Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
          throw new Error('Dev --port requires a valid port number.\n\n' + USAGE);
        }
        port = parsedPort;
      } else {
        remainingArgs.push(arg);
      }
    }
    if (remainingArgs.length > 0) {
      throw new Error('Dev does not accept arguments.\n\n' + USAGE);
    }
    return { command: 'dev', argumentsList: [], json: false, force: false, port, adapter: null };
  }

  if (command === 'mcp') {
    // `--root <dir>` / `--root=<dir>` overrides the project root (default:
    // the working directory); `--allow-write` opts the session into
    // component writes. Both are startup configuration — the agent can
    // never change them over the wire — so they live here, not in the
    // protocol or the tool layer.
    let root = null;
    let rootSeen = false;
    let allowWrite = false;
    let allowWriteSeen = false;
    const remainingArgs = [];
    for (let i = 0; i < positional.length; i++) {
      const arg = positional[i];
      if (arg === '--root' || arg.startsWith('--root=')) {
        if (rootSeen) {
          throw new Error('Mcp accepts at most one --root flag.\n\n' + USAGE);
        }
        const value = arg === '--root' ? positional[i + 1] : arg.slice('--root='.length);
        if (value === undefined || value === '') {
          throw new Error('Mcp --root requires a directory.\n\n' + USAGE);
        }
        rootSeen = true;
        root = value;
        if (arg === '--root') i++;
      } else if (arg === '--allow-write') {
        if (allowWriteSeen) {
          throw new Error('Mcp accepts at most one --allow-write flag.\n\n' + USAGE);
        }
        allowWriteSeen = true;
        allowWrite = true;
      } else {
        remainingArgs.push(arg);
      }
    }
    if (remainingArgs.length > 0) {
      throw new Error('Mcp does not accept arguments.\n\n' + USAGE);
    }
    return { command, argumentsList: [], json: false, force: false, port: null, adapter: null, root, allowWrite };
  }

  if (command === 'init') {
    // `--force` relaxes only the non-empty-directory check; existing files
    // still refuse the scaffold, with or without it.
    const force = positional.includes('--force');
    const targets = positional.filter((argument) => argument !== '--force');
    if (targets.length > 1) {
      throw new Error('Init accepts at most one [directory].\n\n' + USAGE);
    }
    return { command: 'init', argumentsList: targets, json: false, force, adapter: null };
  }

  return { command, argumentsList: positional, json };
}

function runCli(argv, dependencies = {}) {
  const { command, argumentsList, json, force, port, adapter, root, allowWrite } = parseCommand(argv);
  const build = dependencies.build || buildProject;
  const startDev = dependencies.startDev || startDevelopmentServer;
  const startMcp = dependencies.startMcp || startMcpServer;
  const init = dependencies.init || initProject;
  const updateCommand = dependencies.update || updateInstallation;
  const installExtension = dependencies.installVscodeExtension || installVscodeExtension;
  const logger = dependencies.logger || console;

  if (command === 'version') {
    logger.log(`wizz ${VERSIONS.compiler} (compiler ${VERSIONS.compiler}, syntax ${VERSIONS.syntax}, output ${VERSIONS.output})`);
    return 0;
  }

  if (command === 'build') {
    const directories = argumentsList.length === 0 ? ['src', 'dist'] : argumentsList;
    // The build layer re-parses its flags from argv, so both are re-appended
    // here rather than threaded as options (the established contract).
    const buildArguments = [...directories];
    if (json) buildArguments.push('--json');
    if (adapter) buildArguments.push('--adapter', adapter);
    return build(buildArguments, logger);
  }

  if (command === 'init') {
    const target = argumentsList.length === 0 ? '.' : argumentsList[0];
    const created = init(target, { force });
    // Print exactly what was created, relative to the invocation point, as
    // posix-style paths so the list reads the same everywhere.
    for (const templatePath of created) {
      logger.log(`Created ${path.join(target, templatePath).split(path.sep).join('/')}`);
    }
    logger.log('Next: run `wizz dev` to start editing.');
    return 0;
  }

  if (command === 'update') {
    // Both arms must receive the join: an env override replaces the root,
    // not the installation directory itself (installer layout, XDG-based).
    const dataRoot = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    const dataDirectory = path.join(dataRoot, 'wizz');
    const repository = process.env.WIZZ_INSTALL_REPOSITORY || DEFAULT_REPOSITORY;
    logger.log('Resolving the latest Wizz release from GitHub...');
    return updateCommand({ dataDirectory, repository }).then((result) => {
      if (result.status === 'updated') {
        logger.log(`Updated Wizz ${result.fromVersion} to ${result.toVersion} (${result.dataDirectory}).`);
      } else if (result.status === 'newer-local') {
        logger.log(`Installed Wizz ${result.fromVersion} is newer than the latest release (${result.latestVersion}); refusing to downgrade.`);
      } else {
        logger.log(`Wizz ${result.fromVersion} is already up to date.`);
      }
      return 0;
    });
  }

  if (command === 'install-vscode-extension') {
    const repository = process.env.WIZZ_INSTALL_REPOSITORY || DEFAULT_REPOSITORY;
    logger.log('Installing the Wizz VS Code extension from the latest release...');
    return installExtension({ repository }).then((result) => {
      logger.log(`Installed the Wizz VS Code extension ${result.version} via code.`);
      return 0;
    });
  }

  if (command === 'mcp') {
    // The root is fixed for the server's lifetime and resolved here so the
    // protocol layer and the tools never see a relative path.
    const projectRoot = path.resolve(root === null ? process.cwd() : root);
    return startMcp({ projectRoot, allowWrite, logger }).then(
      () => 0,
      (error) => {
        logger.error(error.message);
        return 1;
      }
    );
  }

  const developmentServer = startDev({ projectDirectory: process.cwd(), port, logger });
  return developmentServer.listen().then(
    () => 0,
    (error) => {
      // Release the watcher's fs.watch handle and polling interval before
      // reporting: without this they keep the event loop alive and the
      // process hangs forever instead of exiting with the code below.
      developmentServer.close();
      logger.error(error.message);
      return 1;
    }
  );
}

if (require.main === module) {
  try {
    const result = runCli(process.argv.slice(2));
    // The release-backed commands resolve asynchronously: their contract is
    // a promise of an exit code, which this entry block settles once the
    // network work completes. Synchronous commands still return a number.
    if (result && typeof result.then === 'function') {
      result.then(
        (code) => { process.exitCode = code; },
        (error) => { console.error(error.message); process.exitCode = 1; }
      );
    } else {
      process.exitCode = result;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { USAGE, parseCommand, runCli };
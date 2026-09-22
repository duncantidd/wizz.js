#!/usr/bin/env node
const os = require('node:os');
const path = require('node:path');
const { main: buildProject } = require('../build');
const { startDevelopmentServer } = require('./dev');
const { initProject } = require('./init');
const { update: updateInstallation } = require('./update');
const { installVscodeExtension } = require('./installVscodeExtension');
const { DEFAULT_REPOSITORY } = require('./releaseAssets');
const { VERSIONS } = require('../src/compiler');

const USAGE = `Usage:
  wizz init [directory] [--force]   Scaffold a starter project
  wizz build [input-directory] [output-directory] [--json]
  wizz dev                          Start the development server
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
    return { command: 'version', argumentsList: [], json: false, force: false };
  }

  if (command !== 'build' && command !== 'dev' && command !== 'init' &&
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
    return { command, argumentsList: [], json: false, force: false };
  }

  // `--json` is a build flag, not a directory: it may appear in any position
  // and is stripped before the positional count check. The build layer
  // re-parses it from argv, so it is re-appended here rather than threaded
  // as an option.
  const json = argumentsList.includes('--json');
  const positional = argumentsList.filter((argument) => argument !== '--json');

  if (command === 'build' && positional.length !== 0 && positional.length !== 2) {
    throw new Error('Build accepts either no directories or both <input-directory> and <output-directory>.\n\n' + USAGE);
  }

  if (command === 'dev' && argumentsList.length !== 0) {
    throw new Error('Dev does not accept arguments.\n\n' + USAGE);
  }

  if (command === 'init') {
    // `--force` relaxes only the non-empty-directory check; existing files
    // still refuse the scaffold, with or without it.
    const force = positional.includes('--force');
    const targets = positional.filter((argument) => argument !== '--force');
    if (targets.length > 1) {
      throw new Error('Init accepts at most one [directory].\n\n' + USAGE);
    }
    return { command: 'init', argumentsList: targets, json: false, force };
  }

  return { command, argumentsList: positional, json };
}

function runCli(argv, dependencies = {}) {
  const { command, argumentsList, json, force } = parseCommand(argv);
  const build = dependencies.build || buildProject;
  const startDev = dependencies.startDev || startDevelopmentServer;
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
    return build(json ? [...directories, '--json'] : directories, logger);
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

  const developmentServer = startDev({ projectDirectory: process.cwd(), logger });
  void developmentServer.listen();
  return 0;
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
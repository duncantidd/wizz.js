#!/usr/bin/env node
const { main: buildProject } = require('../build');
const { startDevelopmentServer } = require('./dev');

const USAGE = `Usage:
  wizz build [input-directory] [output-directory]
  wizz dev`;

function parseCommand(argv) {
  if (!Array.isArray(argv)) {
    throw new TypeError('CLI arguments must be an array.');
  }

  const [command, ...argumentsList] = argv;
  if (command !== 'build' && command !== 'dev') {
    throw new Error(USAGE);
  }

  if (command === 'build' && argumentsList.length !== 0 && argumentsList.length !== 2) {
    throw new Error('Build accepts either no directories or both <input-directory> and <output-directory>.\n\n' + USAGE);
  }

  if (command === 'dev' && argumentsList.length !== 0) {
    throw new Error('Dev does not accept arguments.\n\n' + USAGE);
  }

  return { command, argumentsList };
}

function runCli(argv, dependencies = {}) {
  const { command, argumentsList } = parseCommand(argv);
  const build = dependencies.build || buildProject;
  const startDev = dependencies.startDev || startDevelopmentServer;
  const logger = dependencies.logger || console;

  if (command === 'build') {
    return build(argumentsList.length === 0 ? ['src', 'dist'] : argumentsList, logger);
  }

  const developmentServer = startDev({ projectDirectory: process.cwd(), logger });
  void developmentServer.listen();
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { USAGE, parseCommand, runCli };
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const usage = 'Usage: npm run validate:fhir -- <bundle.json> [--ig <package-id#version>]';

function parseArgs(args) {
  if (!args.length) throw new Error(usage);
  const [bundleArg, ...options] = args;
  const igs = [];

  for (let i = 0; i < options.length; i++) {
    if (options[i] !== '--ig' || !options[i + 1] || options[i + 1].startsWith('--')) {
      throw new Error(usage);
    }
    igs.push(options[++i]);
  }

  return { bundlePath: path.resolve(bundleArg), igs };
}

function requireFile(filePath, label) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${label} file not found: ${filePath}`);
  }
}

function runValidator(bundlePath, igs) {
  const jarPath = process.env.FHIR_VALIDATOR_JAR;
  if (!jarPath) throw new Error('Set FHIR_VALIDATOR_JAR to the path of the HL7 validator_cli.jar.');

  const resolvedJar = path.resolve(jarPath);
  requireFile(resolvedJar, 'FHIR validator');
  requireFile(bundlePath, 'FHIR bundle');

  const args = ['-jar', resolvedJar, bundlePath, '-version', '4.0.1'];
  for (const ig of igs) args.push('-ig', ig);

  return new Promise((resolve, reject) => {
    const child = spawn(process.env.JAVA || 'java', args, { stdio: 'inherit' });
    child.on('error', (error) => reject(new Error(`Could not start the HL7 FHIR validator: ${error.message}`)));
    child.on('close', (code, signal) => {
      if (signal) return reject(new Error(`HL7 FHIR validator stopped by signal ${signal}`));
      process.exitCode = code ?? 1;
      resolve();
    });
  });
}

async function main() {
  const { bundlePath, igs } = parseArgs(process.argv.slice(2));
  await runValidator(bundlePath, igs);
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });

#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { serializeEnvironment } from './dotenv.js';

function isEnvironmentMap(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const exec = promisify(execFile);
const [input, output, ...extra] = process.argv.slice(2);
let temporary: string | undefined;

try {
  if (!input || !output || extra.length)
    throw new Error('Usage: varlock-workload-pull <input-directory> <output-file>');
  const inputDirectory = await realpath(input);
  if (!(await stat(inputDirectory)).isDirectory()) throw new Error('Input must be a dedicated Varlock directory.');
  const outputFile = resolve(output);
  const outputDirectory = await realpath(dirname(outputFile));
  const pathFromInput = relative(inputDirectory, outputDirectory);
  if (
    pathFromInput === '' ||
    (!pathFromInput.startsWith(`..${sep}`) && pathFromInput !== '..' && !isAbsolute(pathFromInput))
  ) {
    throw new Error(
      'Output must be outside the Varlock input directory so generated values cannot be read back as overrides.',
    );
  }
  const cli = fileURLToPath(new URL('../bin/cli.js', import.meta.resolve('varlock')));
  let stdout: string;
  try {
    const result = await exec(
      process.execPath,
      [cli, 'load', '--path', inputDirectory, '--format', 'json', '--skip-cache'],
      {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        timeout: 60_000,
      },
    );
    stdout = result.stdout;
  } catch {
    throw new Error(
      'Varlock load failed; the existing output was preserved. Diagnose with varlock load --agent --path <input-directory>.',
    );
  }
  let values: unknown;
  try {
    values = JSON.parse(stdout);
  } catch {
    throw new Error('Varlock returned invalid JSON; the existing output was preserved.');
  }
  if (!isEnvironmentMap(values)) throw new Error('Unexpected Varlock output; the existing output was preserved.');
  const contents = serializeEnvironment(values);
  // The temporary file must share the destination directory for an atomic rename.
  temporary = resolve(outputDirectory, `.varlock-env-${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(contents);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, outputFile);
  temporary = undefined;
  process.stdout.write('Environment file updated.\n');
} catch (error) {
  // Child process stdout/stderr may contain secrets; do not forward them on failures.
  process.stderr.write(`${error instanceof Error ? error.message : 'Environment export failed.'}\n`);
  process.exitCode = 1;
} finally {
  if (temporary) await rm(temporary, { force: true });
}

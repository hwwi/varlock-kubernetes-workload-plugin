import { execFile } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value) || /^0+$/.test(value)) {
    throw new Error('Missing comparison commit.');
  }
  return value;
}

export async function shouldRunChecks(): Promise<boolean> {
  if (process.env.CI_FULL_CHECK === 'true') return true;
  const event = process.env.GITHUB_EVENT_NAME;
  if (event !== 'push' && event !== 'pull_request') return true;
  try {
    const payload: unknown = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH ?? '', 'utf8'));
    if (!object(payload)) throw new Error('Missing event payload.');
    let range: string;
    if (event === 'pull_request') {
      const pr = payload.pull_request;
      if (!object(pr) || !object(pr.base) || !object(pr.head)) throw new Error('Missing PR comparison.');
      // PR changes are relative to the merge base, not changes made on the base branch.
      range = `${sha(pr.base.sha)}...${sha(pr.head.sha)}`;
    } else {
      range = `${sha(payload.before)}..${sha(payload.after)}`;
    }
    // Include both paths of renames and use NUL delimiters for arbitrary filenames.
    const { stdout } = await exec('git', ['diff', '--name-only', '--no-renames', '-z', range, '--'], {
      maxBuffer: 16 * 1024 * 1024, timeout: 15_000,
    });
    const paths = stdout.split('\0').filter(Boolean);
    return paths.length === 0 || paths.some((path) => path !== 'README.md' && path !== 'AGENTS.md' && !path.startsWith('docs/'));
  } catch {
    console.warn('Changed paths could not be determined; running all checks.');
    return true;
  }
}

async function main(): Promise<void> {
  const runTests = await shouldRunChecks();
  console.log(runTests ? 'Running all checks.' : 'Only documentation changed; skipping tests.');
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required.');
  await appendFile(process.env.GITHUB_OUTPUT, `run-tests=${runTests}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) {
    console.error(error instanceof Error ? error.message : 'CI change detection failed.');
    process.exitCode = 1;
  }
}

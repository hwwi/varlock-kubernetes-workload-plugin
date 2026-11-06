import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { afterEach, expect, test } from 'vitest';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const script = join(root, 'scripts/ci-changes.ts');
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'workload-ci-'));
  directories.push(directory);
  const cwd = join(directory, 'repo');
  await mkdir(cwd);
  const git = (...args: string[]) => exec('git', args, { cwd });
  const write = async (path: string, text = 'changed\n') => {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), text);
  };
  const commit = async () => {
    await git('add', '-A');
    await git('-c', 'user.name=CI Test', '-c', 'user.email=ci@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'test: change fixture');
    return (await git('rev-parse', 'HEAD')).stdout.trim();
  };
  await git('init', '-q', '-b', 'main');
  await git('config', 'core.hooksPath', '/dev/null');
  for (const path of ['README.md', 'AGENTS.md', 'docs/guide.md', 'src/plugin.ts']) await write(path, 'initial\n');
  const base = await commit();
  const eventPath = join(directory, 'event.json');
  const output = join(directory, 'output');
  const run = async (event = 'push', overrides: Record<string, string> = {}, payload?: unknown) => {
    const head = (await git('rev-parse', 'HEAD')).stdout.trim();
    await writeFile(eventPath, JSON.stringify(payload ?? (event === 'pull_request'
      ? { pull_request: { base: { sha: base }, head: { sha: head } } }
      : { before: base, after: head })));
    await writeFile(output, '');
    const result = await exec(process.execPath, [script], {
      cwd, timeout: 20_000,
      env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: output, CI_FULL_CHECK: 'false', ...overrides },
    });
    return { output: await readFile(output, 'utf8'), ...result };
  };
  return { cwd, git, write, commit, base, run };
}

test.each(['push', 'pull_request'])('skips tests for documentation-only %s changes', async (event) => {
  const f = await fixture();
  await f.write('README.md');
  await f.write('AGENTS.md');
  await f.write('docs/a guide\nwith spaces.md');
  await f.commit();
  expect((await f.run(event)).output).toBe('run-tests=false\n');
});

test.each(['src/plugin.ts', 'package.json', 'pnpm-lock.yaml', '.node-version', '.github/workflows/ci.yml', 'scripts/release.ts', 'examples/env/.env.schema', 'CHANGELOG.md'])('runs tests when %s changes alongside documentation', async (path) => {
  const f = await fixture();
  await f.write('README.md');
  await f.write(path);
  await f.commit();
  expect((await f.run()).output).toBe('run-tests=true\n');
});

test('compares the entire push instead of only its last commit', async () => {
  const f = await fixture();
  await f.write('src/plugin.ts');
  await f.commit();
  await f.write('README.md');
  await f.commit();
  expect((await f.run()).output).toBe('run-tests=true\n');
});

test('compares a PR against its merge base without unrelated changes on main', async () => {
  const f = await fixture();
  await f.git('checkout', '-qb', 'feature');
  await f.write('README.md');
  const head = await f.commit();
  await f.git('checkout', '-q', 'main');
  await f.write('src/plugin.ts');
  const base = await f.commit();
  await f.git('checkout', '-q', 'feature');
  expect((await f.run('pull_request', {}, { pull_request: { base: { sha: base }, head: { sha: head } } })).output).toBe('run-tests=false\n');
});

test.each([
  ['src/plugin.ts', 'docs/plugin.md', 'true'],
  ['docs/guide.md', 'src/guide.ts', 'true'],
  ['docs/guide.md', 'docs/new-guide.md', 'false'],
])('handles renamed paths from %s to %s', async (from, to, expected) => {
  const f = await fixture();
  await f.git('mv', from, to);
  await f.commit();
  expect((await f.run()).output).toBe(`run-tests=${expected}\n`);
});

test.each([['src/plugin.ts', 'true'], ['docs/guide.md', 'false']])('handles deletion of %s', async (path, expected) => {
  const f = await fixture();
  await f.git('rm', path);
  await f.commit();
  expect((await f.run()).output).toBe(`run-tests=${expected}\n`);
});

test('does not truncate large diffs to the first 300 files', async () => {
  const f = await fixture();
  await Promise.all(Array.from({ length: 305 }, (_, index) => f.write(`docs/page-${index}.md`)));
  await f.write('src/plugin.ts');
  await f.commit();
  expect((await f.run()).output).toBe('run-tests=true\n');
});

test('forces all release checks even with documentation-only or unavailable event data', async () => {
  const f = await fixture();
  await f.write('README.md');
  await f.commit();
  expect((await f.run('push', { CI_FULL_CHECK: 'true' })).output).toBe('run-tests=true\n');
  expect((await f.run('workflow_dispatch', { CI_FULL_CHECK: 'true', GITHUB_EVENT_PATH: '/missing' })).output).toBe('run-tests=true\n');
});

test.each([
  { before: '0'.repeat(40), after: '1'.repeat(40) },
  { before: '1'.repeat(40), after: '2'.repeat(40) },
  { pull_request: {} },
  [],
])('runs all checks when comparison data is unavailable %#', async (payload) => {
  const f = await fixture();
  expect((await f.run('push', {}, payload)).output).toBe('run-tests=true\n');
});

test('runs all checks when the event file is unavailable or no paths changed', async () => {
  const f = await fixture();
  expect((await f.run()).output).toBe('run-tests=true\n');
  expect((await f.run('pull_request', { GITHUB_EVENT_PATH: '/missing' })).output).toBe('run-tests=true\n');
});

test.each([
  ['true', 'success', 'success', 'success', true],
  ['false', 'success', 'skipped', 'skipped', true],
  ['true', 'success', 'failure', 'success', false],
  ['true', 'success', 'success', 'cancelled', false],
  ['true', 'success', 'skipped', 'skipped', false],
  ['false', 'failure', 'skipped', 'skipped', false],
  ['', 'cancelled', 'skipped', 'skipped', false],
])('reports CI results for tests=%s changes=%s check=%s kind=%s', async (runTests, changes, check, kind, success) => {
  const workflow = await readFile(join(root, '.github/workflows/ci.yml'), 'utf8');
  const marker = '        run: |\n';
  const start = workflow.lastIndexOf(marker);
  if (start < 0) throw new Error('Missing CI result command');
  const command = workflow.slice(start + marker.length).split('\n').map((line) => line.slice(10)).join('\n');
  const result = exec('bash', ['-e', '-c', command], {
    env: { ...process.env, RUN_TESTS: String(runTests), CHANGES_RESULT: String(changes), CHECK_RESULT: String(check), KUBERNETES_RESULT: String(kind) },
  });
  if (success) await expect(result).resolves.toBeDefined();
  else await expect(result).rejects.toThrow();
});

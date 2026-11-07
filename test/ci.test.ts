import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { afterEach, expect, test } from 'vitest';
import { createApi } from './api.js';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const script = join(root, 'scripts/ci-changes.ts');
const directories: string[] = [];
const apis: Awaited<ReturnType<typeof createApi>>[] = [];
afterEach(async () => {
  await Promise.all([
    ...directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    ...apis.splice(0).map((api) => api.close()),
  ]);
});

const repository = 'hwwi/varlock-kubernetes-workload-plugin';
const releasePull = {
  user: { login: 'hwwi-release-bot[bot]', type: 'Bot' },
  base: { ref: 'main', repo: { full_name: repository } },
  head: {
    ref: 'release-please--branches--main--components--kubernetes-workload-plugin',
    repo: { full_name: repository },
  },
};

function packageJson(version: string, fields: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ name: 'fixture', version, ...fields }, null, 2)}\n`;
}

async function fixture(packageFields = {}, version = '0.1.0-beta.2') {
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
    await git(
      '-c',
      'user.name=CI Test',
      '-c',
      'user.email=ci@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'test: change fixture',
    );
    return (await git('rev-parse', 'HEAD')).stdout.trim();
  };
  const mergePreview = async (base: string, head: string) => {
    const tree = (await git('merge-tree', '--write-tree', base, head)).stdout.trim();
    return (
      await git(
        '-c',
        'user.name=CI Test',
        '-c',
        'user.email=ci@example.test',
        'commit-tree',
        tree,
        '-p',
        base,
        '-p',
        head,
        '-m',
        'test: preview merge',
      )
    ).stdout.trim();
  };
  await git('init', '-q', '-b', 'main');
  await git('config', 'core.hooksPath', '/dev/null');
  for (const path of ['README.md', 'AGENTS.md', 'docs/guide.md', 'src/plugin.ts']) await write(path, 'initial\n');
  await write('package.json', packageJson(version, packageFields));
  await write('.release-please-manifest.json', JSON.stringify({ '.': version }));
  await write('CHANGELOG.md', `# Changelog\n\n## ${version}\n`);
  const base = await commit();
  const eventPath = join(directory, 'event.json');
  const output = join(directory, 'output');
  const run = async (event = 'push', overrides: Record<string, string> = {}, payload?: unknown) => {
    const head = (await git('rev-parse', 'HEAD')).stdout.trim();
    await writeFile(
      eventPath,
      JSON.stringify(
        payload ??
          (event === 'pull_request'
            ? { pull_request: { base: { sha: base }, head: { sha: head } } }
            : { before: base, after: head }),
      ),
    );
    await writeFile(output, '');
    const result = await exec(process.execPath, [script], {
      cwd,
      timeout: 20_000,
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: event,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: output,
        CI_FULL_CHECK: 'false',
        ...overrides,
      },
    });
    return { output: await readFile(output, 'utf8'), ...result };
  };
  return { cwd, git, write, commit, mergePreview, base, run };
}

async function releaseFixture({
  packageFields = {},
  previousPackageFields = {},
  previousVersion = '0.1.0-beta.2',
  version = '0.1.0',
  manifestVersion = version,
  rewritePackage = (text) => text,
}: {
  packageFields?: Record<string, unknown>;
  previousPackageFields?: Record<string, unknown>;
  previousVersion?: string;
  version?: string;
  manifestVersion?: string;
  rewritePackage?: (text: string) => string;
} = {}) {
  const f = await fixture(previousPackageFields, previousVersion);
  await f.write('package.json', rewritePackage(packageJson(version, packageFields)));
  await f.write('.release-please-manifest.json', JSON.stringify({ '.': manifestVersion }));
  await f.write('CHANGELOG.md', `# Changelog\n\n## [${version}](https://example.test)\n\n## ${previousVersion}\n`);
  const head = await f.commit();
  const env = { GITHUB_REPOSITORY: repository, GITHUB_SHA: await f.mergePreview(f.base, head) };
  const pull = { ...releasePull, base: { ...releasePull.base, sha: f.base }, head: { ...releasePull.head, sha: head } };
  return { ...f, head, env, pull };
}

test('skips heavy tests on a version-only release PR unless full checks are requested', async () => {
  const f = await releaseFixture();
  const payload = { pull_request: f.pull };
  expect((await f.run('pull_request', f.env, payload)).output).toBe('run-tests=false\n');
  expect((await f.run('pull_request', { ...f.env, CI_FULL_CHECK: 'true' }, payload)).output).toBe('run-tests=true\n');
});

test.each(['README.md', 'package.json'])(
  'checks the release PR against the current base after %s changes there',
  async (path) => {
    const f = await releaseFixture();
    await f.git('checkout', '-qb', 'new-base', f.base);
    if (path === 'package.json') {
      await f.write('package.json', packageJson('0.1.0'));
      await f.write('.release-please-manifest.json', JSON.stringify({ '.': '0.1.0' }));
    } else {
      await f.write(path);
    }
    const base = await f.commit();
    const pull = { ...f.pull, base: { ...f.pull.base, sha: base } };
    const env = { ...f.env, GITHUB_SHA: await f.mergePreview(base, f.head) };
    expect((await f.run('pull_request', env, { pull_request: pull })).output).toBe(
      `run-tests=${path === 'package.json'}\n`,
    );
  },
);

test('runs all checks when the release PR merge preview does not match its head', async () => {
  const f = await releaseFixture();
  expect((await f.run('pull_request', { ...f.env, GITHUB_SHA: f.head }, { pull_request: f.pull })).output).toBe(
    'run-tests=true\n',
  );
});

test.each([
  ['dependencies changed', { packageFields: { dependencies: { other: '1.0.0' } } }],
  ['versions differ', { manifestVersion: '0.2.0' }],
  ['the version decreases', { previousVersion: '0.2.0' }],
  ['a version component exceeds the SemVer limit', { version: '9007199254740992.0.0' }],
  [
    'conditional exports change order',
    {
      previousPackageFields: { exports: { import: './import.js', default: './fallback.js' } },
      packageFields: { exports: { default: './fallback.js', import: './import.js' } },
    },
  ],
  [
    'the exports key is escaped',
    {
      previousPackageFields: { exports: './entry.js' },
      packageFields: { exports: './entry.js' },
      rewritePackage: (text: string) => text.replace('"exports"', '"expor\\u0074s"'),
    },
  ],
  [
    'a blocked export changes to an invalid target',
    {
      previousPackageFields: { exports: { '.': null } },
      packageFields: { exports: { '.': null } },
      rewritePackage: (text: string) => text.replace('null', '1e400'),
    },
  ],
])('runs all checks on a release PR when %s', async (_reason, options) => {
  const f = await releaseFixture(options);
  expect((await f.run('pull_request', f.env, { pull_request: f.pull })).output).toBe('run-tests=true\n');
});

test('runs all checks when a release PR also changes a file mode', async () => {
  const f = await releaseFixture();
  await f.git('update-index', '--chmod=+x', 'package.json');
  await f.git(
    '-c',
    'user.name=CI Test',
    '-c',
    'user.email=ci@example.test',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'test: change package file mode',
  );
  const head = (await f.git('rev-parse', 'HEAD')).stdout.trim();
  const pull = { ...f.pull, head: { ...f.pull.head, sha: head } };
  const env = { ...f.env, GITHUB_SHA: await f.mergePreview(f.base, head) };
  expect((await f.run('pull_request', env, { pull_request: pull })).output).toBe('run-tests=true\n');
});

test('runs all checks when a human opens an otherwise identical version-only PR', async () => {
  const f = await releaseFixture();
  const pull = { ...f.pull, user: { login: 'contributor', type: 'User' } };
  expect((await f.run('pull_request', f.env, { pull_request: pull })).output).toBe('run-tests=true\n');
});

test('skips heavy tests only for a verified release PR merge on push', async () => {
  const f = await releaseFixture();
  const api = await createApi();
  apis.push(api);
  const path = `/repos/${repository}/commits/${f.head}/pulls`;
  const env = { ...f.env, GITHUB_API_URL: api.serverUrl, GH_TOKEN: 'fake-token' };
  const payload = { before: f.base, after: f.head, ref: 'refs/heads/main', forced: false };
  const pull = { ...f.pull, merged_at: '2026-11-07T00:00:00Z', merge_commit_sha: f.head };
  api.responses.set(path, { body: [pull] });
  expect((await f.run('push', env, payload)).output).toBe('run-tests=false\n');
  expect((await f.run('push', env, { ...payload, forced: true })).output).toBe('run-tests=true\n');
  expect(api.requests).toEqual([{ method: 'GET', path, authorization: 'Bearer fake-token' }]);
  for (const body of [[], [{ ...pull, merge_commit_sha: f.base }]]) {
    api.responses.set(path, { body });
    expect((await f.run('push', env, payload)).output).toBe('run-tests=true\n');
  }
  api.responses.set(path, { status: 403, body: {} });
  expect((await f.run('push', env, payload)).output).toBe('run-tests=true\n');
});

test('runs all checks when a release-looking push also contains a code change', async () => {
  const f = await releaseFixture();
  await f.write('src/plugin.ts');
  const head = await f.commit();
  const api = await createApi();
  apis.push(api);
  const env = { ...f.env, GITHUB_API_URL: api.serverUrl, GH_TOKEN: 'fake-token' };
  expect(
    (await f.run('push', env, { before: f.base, after: head, ref: 'refs/heads/main', forced: false })).output,
  ).toBe('run-tests=true\n');
  expect(api.requests).toEqual([]);
});

test('runs all checks when a release merge is pushed together with an earlier manual version change', async () => {
  const f = await releaseFixture();
  await f.write('package.json', packageJson('0.1.1'));
  await f.write('.release-please-manifest.json', JSON.stringify({ '.': '0.1.1' }));
  await f.write('CHANGELOG.md', '# Changelog\n\n## [0.1.1](https://example.test)\n');
  const head = await f.commit();
  const api = await createApi();
  apis.push(api);
  const path = `/repos/${repository}/commits/${head}/pulls`;
  api.responses.set(path, { body: [{ ...f.pull, merged_at: '2026-11-07T00:00:00Z', merge_commit_sha: head }] });
  const env = { ...f.env, GITHUB_API_URL: api.serverUrl, GH_TOKEN: 'fake-token' };
  const payload = { before: f.base, after: head, ref: 'refs/heads/main', forced: false };
  expect((await f.run('push', env, payload)).output).toBe('run-tests=true\n');
  expect(api.requests).toEqual([]);
});

test.each(['push', 'pull_request'])('skips tests for documentation-only %s changes', async (event) => {
  const f = await fixture();
  await f.write('README.md');
  await f.write('AGENTS.md');
  await f.write('docs/a guide\nwith spaces.md');
  await f.commit();
  expect((await f.run(event)).output).toBe('run-tests=false\n');
});

test.each([
  'src/plugin.ts',
  'package.json',
  'pnpm-lock.yaml',
  '.node-version',
  '.github/workflows/ci.yml',
  'scripts/release.ts',
  'examples/env/.env.schema',
  'CHANGELOG.md',
])('runs tests when %s changes alongside documentation', async (path) => {
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
  expect((await f.run('pull_request', {}, { pull_request: { base: { sha: base }, head: { sha: head } } })).output).toBe(
    'run-tests=false\n',
  );
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

test.each([
  ['src/plugin.ts', 'true'],
  ['docs/guide.md', 'false'],
])('handles deletion of %s', async (path, expected) => {
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
  expect((await f.run('workflow_dispatch', { CI_FULL_CHECK: 'true', GITHUB_EVENT_PATH: '/missing' })).output).toBe(
    'run-tests=true\n',
  );
});

test('runs all checks on a manual CI dispatch without requiring a full-check input', async () => {
  const f = await fixture();
  await f.write('README.md');
  await f.commit();
  expect((await f.run('workflow_dispatch')).output).toBe('run-tests=true\n');
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
  const command = workflow
    .slice(start + marker.length)
    .split('\n')
    .map((line) => line.slice(10))
    .join('\n');
  const result = exec('bash', ['-e', '-c', command], {
    env: {
      ...process.env,
      RUN_TESTS: String(runTests),
      CHANGES_RESULT: String(changes),
      CHECK_RESULT: String(check),
      KUBERNETES_RESULT: String(kind),
    },
  });
  if (success) await expect(result).resolves.toBeDefined();
  else await expect(result).rejects.toThrow();
});

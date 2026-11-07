import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { afterEach, describe, expect, test } from 'vitest';
import { releaseVersion, compareReleaseToLatest, publicationDecision } from '../scripts/release.js';
import { createApi } from './api.js';
import type { TestApi } from './api.js';

const exec = promisify(execFile);
const script = resolve(import.meta.dirname, '../scripts/release.ts');
const name = '@hwwi/kubernetes-workload-plugin';
const version = '0.1.0';
const releasePath = `/repos/hwwi/varlock-kubernetes-workload-plugin/releases/tags/v${version}`;
const registryPath = `/${encodeURIComponent(name)}`;
const activeApis: TestApi[] = [];
afterEach(async () => {
  await Promise.all(activeApis.splice(0).map((api) => api.close()));
});

function registry(latest = '0.0.0-stage', versions: Record<string, unknown> = {}) {
  return { 'dist-tags': { latest }, versions };
}

describe('release publication decisions', () => {
  test.each([
    ['0.1.0', '0.0.0-stage', 1],
    ['0.1.0', '0.1.0-beta.2', 1],
    ['0.1.0', '0.1.0-beta.99999999999999999999', 1],
    ['0.1.0', '0.1.0', 0],
    ['0.1.0', '0.1.0+build.1', 0],
    ['0.1.0', '0.1.1', -1],
    ['0.1.0', '0.2.0-beta.1', -1],
    ['1.0.0', '0.99.99', 1],
    ['0.1.10', '0.1.9', 1],
  ])('compares release %s against latest %s', (candidate, latest, expected) => {
    if (typeof candidate !== 'string' || typeof latest !== 'string') throw new Error('Invalid test case');
    expect(compareReleaseToLatest(candidate, latest)).toBe(expected);
  });

  test.each([
    'v0.1.0',
    '0.1.0-beta.1',
    '0.1.0-alpha.1',
    '0.1.0+build',
    '0.1',
    '0.1.0\n',
    '00.1.0',
    '9007199254740992.0.0',
  ])('rejects unsupported release %s', (value) => {
    expect(() => releaseVersion(value)).toThrow();
    expect(() => publicationDecision(undefined, value, 'sha512-new')).toThrow();
  });

  test.each(['0.1.0-beta.01', '0.1.0-', '0.1.0-stage\n', '0.1.0+build..1', 'v0.1.0', '9007199254740992.0.0'])(
    'rejects invalid latest version %s',
    (latest) => {
      expect(() => compareReleaseToLatest(version, latest)).toThrow();
    },
  );

  test('publishes a new release ahead of latest without depending on beta', () => {
    expect(publicationDecision(undefined, version, 'sha512-new')).toBe(true);
    expect(publicationDecision(registry(), version, 'sha512-new')).toBe(true);
    expect(publicationDecision({ versions: {}, 'dist-tags': { beta: '9.0.0-beta.1' } }, version, 'sha512-new')).toBe(
      true,
    );
    expect(() => publicationDecision(registry('0.1.1'), version, 'sha512-new')).toThrow('backwards');
    expect(() => publicationDecision(registry(version), version, 'sha512-new')).toThrow('backwards');
  });

  test('skips an identical published tarball without changing a newer latest', () => {
    const metadata = registry('0.1.1', { [version]: { name, version, dist: { integrity: 'sha512-same' } } });
    expect(publicationDecision(metadata, version, 'sha512-same')).toBe(false);
    expect(() => publicationDecision(metadata, version, 'sha512-different')).toThrow('integrity');
  });

  test.each([
    null,
    { versions: {}, 'dist-tags': { latest: 123 } },
    registry('0.0.0-stage', { [version]: { name: 'wrong-package', version, dist: { integrity: 'sha512-same' } } }),
  ])('rejects invalid registry metadata %#', (metadata) => {
    expect(() => publicationDecision(metadata, version, 'sha512-same')).toThrow();
  });
});

async function fixture(manifestVersion = version, tarballVersion = version) {
  const api = await createApi();
  activeApis.push(api);
  const cwd = join(api.directory, 'repo');
  const artifacts = join(cwd, 'artifacts');
  const packageDirectory = join(api.directory, 'tarball', 'package');
  await mkdir(artifacts, { recursive: true });
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ name, version }));
  await writeFile(join(cwd, '.release-please-manifest.json'), JSON.stringify({ '.': manifestVersion }));
  await exec('git', ['init', '-q', '-b', 'main'], { cwd });
  await exec('git', ['config', 'core.hooksPath', '/dev/null'], { cwd });
  await exec('git', ['add', 'package.json', '.release-please-manifest.json'], { cwd });
  await exec(
    'git',
    [
      '-c',
      'user.name=Release Test',
      '-c',
      'user.email=release@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '-m',
      'chore: release',
    ],
    { cwd },
  );
  const sha = (await exec('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
  await exec('git', ['tag', `v${version}`], { cwd });
  await exec('git', ['update-ref', 'refs/remotes/origin/main', sha], { cwd });
  await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({ name, version: tarballVersion }));
  const tarball = join(artifacts, 'release.tgz');
  await exec('tar', ['-czf', tarball, '-C', join(api.directory, 'tarball'), 'package']);
  const integrity = `sha512-${createHash('sha512')
    .update(await readFile(tarball))
    .digest('base64')}`;
  const output = join(api.directory, 'output');
  api.responses.set(releasePath, { body: { tag_name: `v${version}`, draft: false, prerelease: false } });
  api.responses.set(registryPath, { body: registry() });
  const env = {
    ...process.env,
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: `refs/tags/v${version}`,
    GITHUB_SHA: sha,
    GITHUB_REPOSITORY: 'hwwi/varlock-kubernetes-workload-plugin',
    GH_TOKEN: 'fake-token',
    GITHUB_API_URL: api.serverUrl,
    RELEASE_REGISTRY_URL: api.serverUrl,
    GITHUB_OUTPUT: output,
  };
  const run = (mode = 'check', overrides: Record<string, string> = {}) =>
    exec(process.execPath, [script, mode], {
      cwd,
      env: { ...env, ...overrides },
      timeout: 20_000,
    });
  return { api, cwd, tarball, integrity, output, run };
}

test('validates a real git tag and checks the actual archive through read-only HTTP requests', async () => {
  const f = await fixture();
  await f.run('validate');
  await f.run();
  const outputs = await readFile(f.output, 'utf8');
  expect(outputs).toContain(`version=${version}\n`);
  expect(outputs).toContain('publish=true\n');
  expect(outputs).toContain(`tarball=${await realpath(f.tarball)}\n`);
  expect(f.api.requests.every((request) => request.method === 'GET')).toBe(true);
  expect(f.api.requests.find((request) => request.path === releasePath)?.authorization).toBe('Bearer fake-token');
});

test('rejects an older release using fresh metadata even when the cached response permits it', async () => {
  const f = await fixture();
  f.api.responses.set(registryPath, { body: registry('0.0.0-stage') });
  f.api.responses.set(`${registryPath}?write=true`, { body: registry('0.1.1') });
  await expect(f.run()).rejects.toThrow('backwards');
  await expect(readFile(f.output)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('recognizes an identical published archive missing from cached metadata', async () => {
  const f = await fixture();
  f.api.responses.set(registryPath, { body: registry('0.0.0-stage') });
  f.api.responses.set(`${registryPath}?write=true`, {
    body: registry(version, {
      [version]: { name, version, dist: { integrity: f.integrity } },
    }),
  });
  await f.run();
  expect(await readFile(f.output, 'utf8')).toContain('publish=false\n');
});

test('skips a previously published identical archive on retry', async () => {
  const f = await fixture();
  f.api.responses.set(registryPath, {
    body: registry('0.1.1', {
      [version]: { name, version, dist: { integrity: f.integrity } },
    }),
  });
  await f.run();
  expect(await readFile(f.output, 'utf8')).toContain('publish=false\n');
});

test.each([
  { GITHUB_REF: 'refs/heads/main' },
  { GITHUB_REF: 'refs/tags/v0.1.0-beta.1' },
  { GITHUB_EVENT_NAME: 'push' },
  { GITHUB_SHA: '0'.repeat(40) },
  { GITHUB_REPOSITORY: 'other/repository' },
])('rejects an invalid release execution context %#', async (overrides) => {
  const f = await fixture();
  await expect(f.run('validate', overrides)).rejects.toThrow();
  await expect(readFile(f.output)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('rejects mismatched manifest and tarball versions', async () => {
  const manifest = await fixture('0.0.0-stage');
  await expect(manifest.run()).rejects.toThrow('manifest version');
  const tarball = await fixture(version, '0.0.0-stage');
  await expect(tarball.run()).rejects.toThrow('Package name or version');
});

test('rejects a tag outside main and a moved tag', async () => {
  const f = await fixture();
  await writeFile(join(f.cwd, 'new-file'), 'new commit');
  await exec('git', ['add', 'new-file'], { cwd: f.cwd });
  await exec(
    'git',
    [
      '-c',
      'user.name=Release Test',
      '-c',
      'user.email=release@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '-m',
      'feat: unmerged',
    ],
    { cwd: f.cwd },
  );
  const sha = (await exec('git', ['rev-parse', 'HEAD'], { cwd: f.cwd })).stdout.trim();
  await expect(f.run('validate', { GITHUB_SHA: sha })).rejects.toThrow('must match');
  await exec('git', ['tag', '-f', `v${version}`], { cwd: f.cwd });
  await expect(f.run('validate', { GITHUB_SHA: sha })).rejects.toThrow('merge-base');
});

test.each([
  { tag_name: `v${version}`, draft: true, prerelease: false },
  { tag_name: `v${version}`, draft: false, prerelease: true },
  { tag_name: 'v0.0.0-stage', draft: false, prerelease: false },
])('rejects invalid GitHub release metadata %#', async (body) => {
  const f = await fixture();
  f.api.responses.set(releasePath, { body });
  await expect(f.run()).rejects.toThrow('published GitHub release');
});

test.each([403, 500])('does not treat registry HTTP %s as an unpublished version', async (status) => {
  const f = await fixture();
  f.api.responses.set(registryPath, { status, body: {} });
  await expect(f.run()).rejects.toThrow(`HTTP ${status}`);
});

test('does not publish when latest has advanced or archive integrity differs', async () => {
  const f = await fixture();
  f.api.responses.set(registryPath, { body: registry('0.1.1') });
  await expect(f.run()).rejects.toThrow('backwards');
  f.api.responses.set(registryPath, {
    body: registry(version, { [version]: { name, version, dist: { integrity: 'sha512-other' } } }),
  });
  await expect(f.run()).rejects.toThrow('integrity');
});

test.each(['missing', 'multiple'])('rejects %s archives', async (mode) => {
  const f = await fixture();
  if (mode === 'missing') await rm(f.tarball);
  else await copyFile(f.tarball, join(f.cwd, 'artifacts', 'second.tgz'));
  await expect(f.run()).rejects.toThrow('exactly one');
});

test('dispatches the actual workflow command to its release tag with the expected JSON body', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'release-dispatch-'));
  let received: unknown;
  let receivedPath: string | undefined;
  let receivedMethod: string | undefined;
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: unknown) => {
      if (typeof chunk === 'string') body += chunk;
    });
    request.on('end', () => {
      receivedPath = request.url;
      receivedMethod = request.method;
      try {
        received = JSON.parse(body);
      } catch {
        received = body;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ html_url: 'https://example.test/actions/runs/1' }));
    });
  });
  try {
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address !== 'object') throw new Error('Missing dispatch server address');
    const workflow = await readFile(resolve(import.meta.dirname, '../.github/workflows/release.yml'), 'utf8');
    const lines = workflow.split('\n');
    const start = lines.findIndex((line) => line.trim().startsWith('release_run_url=$(gh api'));
    if (start < 0) throw new Error('Missing dispatch command');
    const commands: string[] = [];
    for (const line of lines.slice(start)) {
      if (!line.startsWith('          ')) break;
      commands.push(line.slice(10));
    }
    const summary = join(directory, 'summary');
    await exec('bash', ['-e', '-c', commands.join('\n')], {
      env: {
        ...process.env,
        GH_TOKEN: 'fake-token',
        GH_ENTERPRISE_TOKEN: 'fake-token',
        GH_CONFIG_DIR: directory,
        GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
        GITHUB_REPOSITORY: 'hwwi/varlock-kubernetes-workload-plugin',
        RELEASE_TAG: `v${version}`,
        GITHUB_STEP_SUMMARY: summary,
      },
      timeout: 10_000,
    });
    expect(receivedMethod).toBe('POST');
    expect(receivedPath).toBe(
      '/repos/hwwi/varlock-kubernetes-workload-plugin/actions/workflows/release.yml/dispatches',
    );
    expect(received).toEqual({ ref: `v${version}`, return_run_details: true });
    expect(await readFile(summary, 'utf8')).toContain('https://example.test/actions/runs/1');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
    await rm(directory, { recursive: true, force: true });
  }
});

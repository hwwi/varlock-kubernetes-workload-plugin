import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, onTestFinished, test } from 'vitest';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const path = 'src/example.ts';
const invalid = 'export const answer=42;\n';
const formatted = 'export const answer = 42;\n';

async function hookFixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'workload-hook-'));
  onTestFinished(() => rm(cwd, { force: true, recursive: true }));
  const env = {
    ...process.env,
    CI: '',
    HUSKY: '1',
    NODE_ENV: 'development',
    npm_config_production: 'false',
    GIT_CONFIG_GLOBAL: join(cwd, 'global.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_EDITOR: ':',
    PATH: [dirname(process.execPath), process.env.PATH].join(delimiter),
    XDG_CONFIG_HOME: cwd,
  };
  const git = (...args: string[]) => exec('git', args, { cwd, env });
  const commit = (...options: string[]) => git('commit', ...options, '-qm', 'test: update fixture');

  await git('init', '-qb', 'main');
  await git('config', 'user.name', 'Hook Test');
  await git('config', 'user.email', 'hook@example.test');
  for (const directory of ['.husky', 'scripts', 'src']) await mkdir(join(cwd, directory));
  for (const file of [
    '.editorconfig',
    '.gitattributes',
    '.husky/pre-commit',
    '.husky/pre-merge-commit',
    'biome.json',
    'package.json',
    'scripts/install-hooks.mjs',
  ]) {
    await copyFile(join(root, file), join(cwd, file));
  }
  await symlink(join(root, 'node_modules'), join(cwd, 'node_modules'), 'junction');
  await writeFile(join(cwd, path), 'export const answer = 0;\n');
  await git('add', '--', '.editorconfig', '.gitattributes', '.husky', 'biome.json', 'package.json', 'scripts', 'src');
  return { cwd, env, git, commit };
}

test('hook installation respects existing hooks and packaging', async () => {
  const { cwd, env, git } = await hookFixture();
  await git('config', 'core.autocrlf', 'true');
  await git('checkout-index', '--force', '--', '.husky/pre-commit', path);
  expect(await readFile(join(cwd, '.husky/pre-commit'), 'utf8')).toBe(
    await readFile(join(root, '.husky/pre-commit'), 'utf8'),
  );
  expect(await readFile(join(cwd, path), 'utf8')).toBe('export const answer = 0;\n');
  await exec(process.execPath, ['scripts/install-hooks.mjs'], { cwd, env: { ...env, npm_command: 'pack' } });
  await expect(git('config', '--local', '--get', 'core.hooksPath')).rejects.toMatchObject({ code: 1 });

  const legacyHook = join(cwd, '.git', 'hooks', 'pre-commit');
  await mkdir(dirname(legacyHook), { recursive: true });
  await writeFile(legacyHook, '#!/bin/sh\nexit 19\n');
  await chmod(legacyHook, 0o755);
  await expect(exec(process.execPath, ['scripts/install-hooks.mjs'], { cwd, env })).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('pre-commit'),
  });
  await expect(git('config', '--local', '--get', 'core.hooksPath')).rejects.toMatchObject({ code: 1 });
  await expect(git('hook', 'run', 'pre-commit')).rejects.toMatchObject({ code: 19 });
  await rm(legacyHook);

  await exec(process.execPath, ['scripts/install-hooks.mjs'], { cwd, env });
  expect((await git('config', '--local', '--get', 'core.hooksPath')).stdout.trim()).toBe('.husky/_');

  await git('config', '--local', 'core.hooksPath', 'custom-hooks');
  await expect(exec(process.execPath, ['scripts/install-hooks.mjs'], { cwd, env })).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('custom-hooks'),
  });
  expect((await git('config', '--local', '--get', 'core.hooksPath')).stdout.trim()).toBe('custom-hooks');
});

test.each([
  ['lint', 'export const answer = 42 == 1;\n', 'noDoubleEquals'],
  ['format', invalid, 'Formatter would have'],
] as const)(
  'pre-commit rejects %s errors in unstaged files and preserves edits',
  async (_check, invalidContent, diagnostic) => {
    const { cwd, env, git, commit } = await hookFixture();
    await commit();
    await exec(process.execPath, ['scripts/install-hooks.mjs'], { cwd, env });
    await writeFile(join(cwd, 'README.md'), '# Fixture\n');
    await git('add', '--', 'README.md');
    await writeFile(join(cwd, path), invalidContent);

    await expect(commit()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(diagnostic) });
    expect((await git('diff', '--cached', '--name-only')).stdout.trim()).toBe('README.md');
    expect(await readFile(join(cwd, path), 'utf8')).toBe(invalidContent);

    await writeFile(join(cwd, path), formatted);
    await commit();
    expect((await git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD')).stdout.trim()).toBe('README.md');
    expect(await readFile(join(cwd, path), 'utf8')).toBe(formatted);
    expect((await git('stash', 'list')).stdout).toBe('');
  },
);

test.each([
  ['invalid', invalid],
  ['formatted', formatted],
] as const)('automatic merge checks %s merged files', async (status, content) => {
  const { cwd, env, git, commit } = await hookFixture();
  await writeFile(join(cwd, 'README.md'), '# Fixture\n');
  await git('add', '--', 'README.md');
  await commit();
  const before = (await git('rev-parse', 'HEAD')).stdout.trim();
  await git('switch', '-qc', 'side');
  await writeFile(join(cwd, path), content);
  await git('add', '--', path);
  await commit();
  const side = (await git('rev-parse', 'HEAD')).stdout.trim();
  await git('switch', '-q', 'main');
  await exec(process.execPath, ['scripts/install-hooks.mjs'], { cwd, env });
  await writeFile(join(cwd, 'README.md'), '# Unstaged\n');

  const merge = git('merge', '--no-ff', '--no-edit', 'side');
  if (status === 'invalid') {
    await expect(merge).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Formatter would have') });
    expect((await git('rev-parse', 'HEAD')).stdout.trim()).toBe(before);
    expect((await git('rev-parse', '--verify', 'MERGE_HEAD')).stdout.trim()).toBe(side);
    expect((await git('show', `:${path}`)).stdout).toBe(invalid);
  } else {
    await merge;
    expect((await git('show', '-s', '--format=%P', 'HEAD')).stdout.trim()).toBe(`${before} ${side}`);
    expect((await git('show', `HEAD:${path}`)).stdout).toBe(formatted);
  }
  expect(await readFile(join(cwd, 'README.md'), 'utf8')).toBe('# Unstaged\n');
});

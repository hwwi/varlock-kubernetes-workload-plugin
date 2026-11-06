import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { createApi } from './api.js';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');

test('installs the tarball and checks the release command', async () => {
  const api = await createApi();
  try {
    api.workload('Deployment', [{ name: 'app', env: [{ name: 'PACKAGE_TEST', value: 'installed-tarball' }] }]);
    const artifacts = join(api.directory, 'artifacts');
    await mkdir(artifacts);
    await exec('pnpm', ['pack', '--pack-destination', artifacts], {
      cwd: root, timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    });
    const tarballs = (await readdir(artifacts)).filter((file) => file.endsWith('.tgz'));
    expect(tarballs).toHaveLength(1);
    const tarball = tarballs[0];
    if (!tarball) throw new Error('Package tarball was not generated.');

    const consumer = join(api.directory, 'consumer');
    await mkdir(consumer);
    await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true }));
    await exec('pnpm', [
      'add', '-D', join(artifacts, tarball), 'varlock@1.24.0', '--ignore-scripts',
      '--store-dir', process.env.WORKLOAD_PNPM_STORE ?? join(api.directory, 'store'),
    ], { cwd: consumer, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });

    const input = join(consumer, 'env');
    await mkdir(input);
    await writeFile(join(input, '.env.schema'), [
      '# @plugin(@hwwi/kubernetes-workload-plugin)',
      `# @initK8sWorkload(kubeconfig=${JSON.stringify(api.kubeconfig)})`,
      '# @setValuesBulk(k8sWorkloadEnv(kind=Deployment,name=app),format=json)',
      '# ---',
      'PACKAGE_TEST=',
      'LOCAL_PACKAGE_TEST=k8sWorkloadEnvValue(kind=Deployment, name=app, key=PACKAGE_TEST)',
      '',
    ].join('\n'));

    const output = join(consumer, '.env.local');
    const result = await exec('pnpm', ['exec', 'varlock-workload-pull', input, output], {
      cwd: consumer, env: { ...process.env, DO_NOT_TRACK: '1' }, timeout: 30_000,
    });
    expect(result.stdout).not.toContain('installed-tarball');
    expect(await readFile(output, 'utf8')).toBe("PACKAGE_TEST='installed-tarball'\nLOCAL_PACKAGE_TEST='installed-tarball'\n");
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]).toMatchObject({ method: 'GET', path: '/apis/apps/v1/namespaces/test/deployments/app' });

    // Exercise the workflow commands without rewriting their relative tarball paths.
    const workflow = await readFile(join(root, '.github/workflows/release.yml'), 'utf8');
    const publishCommands = workflow.split('\n').map((line) => line.trim().replace(/^run:\s*/, ''))
      .filter((line) => /^npm (?:stage )?publish /.test(line));
    expect(publishCommands).toHaveLength(1);
    const npmrc = join(api.directory, 'empty.npmrc');
    await writeFile(npmrc, '');
    for (const command of publishCommands) {
      const result = await exec('bash', ['-e', '-c', `${command} --dry-run --json --registry "$TEST_NPM_REGISTRY" --userconfig "$TEST_NPM_USERCONFIG" --cache "$TEST_NPM_CACHE"`], {
        cwd: api.directory,
        env: {
          ...process.env, NODE_AUTH_TOKEN: '', GIT_SSH_COMMAND: 'false',
          RELEASE_TARBALL: `./artifacts/${tarball}`,
          TEST_NPM_REGISTRY: api.serverUrl, TEST_NPM_USERCONFIG: npmrc,
          TEST_NPM_CACHE: join(api.directory, 'npm-cache'),
        },
        timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
      });
      const publication: unknown = JSON.parse(result.stdout);
      const packageName = '@hwwi/kubernetes-workload-plugin';
      // npm 10 returns one package directly; npm 11 keys results by package name.
      const publishedPackage = publication && typeof publication === 'object' && packageName in publication
        ? publication[packageName] : publication;
      expect(publishedPackage).toMatchObject({ name: packageName });
      expect(result.stderr).toContain('tag beta and public access (dry-run)');
    }
    expect(api.requests.every((request) => request.method === 'GET')).toBe(true);
  } finally {
    await api.close();
  }
});

import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { createApi } from './api.js';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');

test('installs a tarball in a separate project and runs the packaged plugin and CLI', async () => {
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
      '',
    ].join('\n'));

    const output = join(consumer, '.env.local');
    const result = await exec('pnpm', ['exec', 'varlock-workload-pull', input, output], {
      cwd: consumer, env: { ...process.env, DO_NOT_TRACK: '1' }, timeout: 30_000,
    });
    expect(result.stdout).not.toContain('installed-tarball');
    expect(await readFile(output, 'utf8')).toBe("PACKAGE_TEST='installed-tarball'\n");
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]).toMatchObject({ method: 'GET', path: '/apis/apps/v1/namespaces/test/deployments/app' });
  } finally {
    await api.close();
  }
});

import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
  V1ConfigMap, V1CronJob, V1DaemonSet, V1Deployment, V1Job, V1PodTemplateSpec, V1Secret, V1StatefulSet,
} from '@kubernetes/client-node';
import { expect, test } from 'vitest';
import { workloadKinds } from '../src/model.js';
import type { WorkloadKind } from '../src/model.js';

type TestResource = V1ConfigMap | V1Secret | V1Deployment | V1StatefulSet | V1DaemonSet | V1Job | V1CronJob;

const root = resolve(import.meta.dirname, '..');

function isEnvironmentMap(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function podTemplate(restartPolicy: 'Always' | 'Never'): V1PodTemplateSpec {
  return {
    metadata: { labels: { app: 'varlock-test' } },
    spec: {
      nodeSelector: { 'varlock-test/no-such-node': 'true' },
      containers: [{
        name: 'app', image: 'registry.k8s.io/pause:3.10',
        envFrom: [
          { configMapRef: { name: 'config-v1' } },
          { secretRef: { name: 'credentials' }, prefix: 'SECRET_' },
        ],
        env: [{ name: 'OVERRIDE', value: 'explicit' }],
      }],
      restartPolicy,
    },
  };
}

function workload(kind: WorkloadKind, namespace: string): TestResource {
  const metadata = { name: kind.toLowerCase(), namespace };
  const selector = { matchLabels: { app: 'varlock-test' } };
  switch (kind) {
    case 'Deployment':
      return { apiVersion: 'apps/v1', kind, metadata, spec: { replicas: 0, selector, template: podTemplate('Always') } };
    case 'StatefulSet':
      return { apiVersion: 'apps/v1', kind, metadata, spec: { replicas: 0, serviceName: 'unused', selector, template: podTemplate('Always') } };
    case 'DaemonSet':
      return { apiVersion: 'apps/v1', kind, metadata, spec: { selector, template: podTemplate('Always') } };
    case 'Job':
      return { apiVersion: 'batch/v1', kind, metadata, spec: { suspend: true, template: podTemplate('Never') } };
    case 'CronJob':
      return { apiVersion: 'batch/v1', kind, metadata, spec: { schedule: '0 0 * * *', suspend: true, jobTemplate: { spec: { template: podTemplate('Never') } } } };
  }
}

test('reads five real workload kinds and follows a replaced ConfigMap reference', async () => {
  const context = process.env.WORKLOAD_TEST_CONTEXT;
  if (context !== 'kind-varlock-workload') {
    throw new Error('WORKLOAD_TEST_CONTEXT must be kind-varlock-workload. Production contexts are not supported.');
  }
  const namespace = `varlock-test-${Date.now()}`;
  const directory = await mkdtemp(join(tmpdir(), 'varlock-cluster-test-'));
  const kubectl = (args: string[], input?: string): string => execFileSync('kubectl', [
    '--context', context, '--request-timeout=15s', ...args,
  ], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });

  let created = false;
  try {
    kubectl(['create', 'namespace', namespace]);
    created = true;
    const items: TestResource[] = [
      {
        apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'config-v1', namespace },
        data: { VALUE: 'first', OVERRIDE: 'source' }, binaryData: { EXCLUDED: Buffer.from('file').toString('base64') },
      },
      {
        apiVersion: 'v1', kind: 'Secret', metadata: { name: 'credentials', namespace },
        stringData: { TOKEN: 'synthetic-cluster-secret' },
      },
      ...workloadKinds.map((kind) => workload(kind, namespace)),
    ];
    kubectl(['apply', '-f', '-'], JSON.stringify({ apiVersion: 'v1', kind: 'List', items }));

    const cli = join(root, 'node_modules/varlock/bin/cli.js');
    const schema = join(directory, '.env.schema');
    const load = async (kind: WorkloadKind): Promise<Record<string, unknown>> => {
      await writeFile(schema, [
        `# @plugin(${JSON.stringify(join(root, 'dist/plugin.cjs'))})`,
        `# @initK8sWorkload(context=${context}, namespace=${namespace}, defaultKind=${kind}, defaultName=${kind.toLowerCase()}, defaultContainer=app)`,
        `# @setValuesBulk(k8sWorkloadEnv(), format=json)`,
        '# ---', 'VALUE=', 'OVERRIDE=', 'SECRET_TOKEN=',
        'LOCAL_TOKEN=k8sWorkloadEnvValue(key=SECRET_TOKEN)',
        '# @required=false', 'ABSENT=k8sWorkloadEnvValue(allowMissing=true)',
        'LOG_LEVEL=fallback(k8sWorkloadEnvValue(allowMissing=true), "info")', '',
      ].join('\n'));
      const value: unknown = JSON.parse(execFileSync(process.execPath, [
        cli, 'load', '--path', directory, '--format', 'json', '--skip-cache',
      ], { encoding: 'utf8', env: { ...process.env, DO_NOT_TRACK: '1' }, stdio: ['pipe', 'pipe', 'pipe'] }));
      if (!isEnvironmentMap(value)) throw new Error('Invalid environment response.');
      return value;
    };

    for (const kind of workloadKinds) {
      expect(await load(kind)).toEqual({ VALUE: 'first', OVERRIDE: 'explicit', SECRET_TOKEN: 'synthetic-cluster-secret', LOCAL_TOKEN: 'synthetic-cluster-secret', LOG_LEVEL: 'info' });
    }
    kubectl(['apply', '-f', '-'], JSON.stringify({
      apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'config-v2', namespace }, data: { VALUE: 'second' },
    }));
    kubectl(['-n', namespace, 'patch', 'deployment', 'deployment', '--type=json', '-p', JSON.stringify([
      { op: 'replace', path: '/spec/template/spec/containers/0/envFrom/0/configMapRef/name', value: 'config-v2' },
    ])]);
    expect((await load('Deployment')).VALUE).toBe('second');
  } finally {
    try {
      if (created) kubectl(['delete', 'namespace', namespace, '--wait=false']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

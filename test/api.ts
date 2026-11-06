import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { V1Container } from '@kubernetes/client-node';
import type { WorkloadKind } from '../src/model.js';

const resourcePaths: Record<WorkloadKind, string> = {
  Deployment: '/apis/apps/v1/namespaces',
  StatefulSet: '/apis/apps/v1/namespaces',
  DaemonSet: '/apis/apps/v1/namespaces',
  Job: '/apis/batch/v1/namespaces',
  CronJob: '/apis/batch/v1/namespaces',
};
const plurals: Record<WorkloadKind, string> = {
  Deployment: 'deployments', StatefulSet: 'statefulsets', DaemonSet: 'daemonsets', Job: 'jobs', CronJob: 'cronjobs',
};

export interface ApiResponse {
  status?: number;
  body: unknown;
  delayMs?: number;
}

export async function createApi() {
  const directory = await mkdtemp(join(tmpdir(), 'varlock-workload-test-'));
  const responses = new Map<string, ApiResponse>();
  const requests: { method: string | undefined; path: string; authorization: string | undefined }[] = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;
    requests.push({ method: request.method, path, authorization: request.headers.authorization });
    const entry = responses.get(`${path}${url.search}`) ?? responses.get(path) ?? { status: 404, body: { kind: 'Status', message: 'not found', code: 404 } };
    const send = () => {
      response.writeHead(entry.status ?? 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(entry.body));
    };
    if (entry.delayMs) setTimeout(send, entry.delayMs).unref();
    else send();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || !address) throw new Error('No test server address');
  const serverUrl = `http://127.0.0.1:${address.port}`;
  const kubeconfig = join(directory, 'kubeconfig.json');
  await writeFile(kubeconfig, JSON.stringify({
    apiVersion: 'v1', kind: 'Config',
    clusters: [{ name: 'test', cluster: { server: serverUrl, 'insecure-skip-tls-verify': true } }],
    users: [{ name: 'test', user: { token: 'test-token' } }],
    contexts: [
      { name: 'test', context: { cluster: 'test', user: 'test', namespace: 'test' } },
      { name: 'other', context: { cluster: 'test', user: 'test', namespace: 'other' } },
    ],
    'current-context': 'test',
  }));

  return {
    directory, kubeconfig, serverUrl, requests, responses,
    openConnections(): Promise<number> {
      return new Promise((resolve, reject) => server.getConnections((error, count) => error ? reject(error) : resolve(count)));
    },
    workload(kind: WorkloadKind, containers: V1Container[], namespace = 'test', name = 'app') {
      const template = { spec: { containers, initContainers: [{ name: 'init', env: [{ name: 'INIT_ONLY', value: 'excluded' }] }] } };
      const resourcePath = `${resourcePaths[kind]}/${namespace}/${plurals[kind]}/${name}`;
      responses.set(resourcePath, { body: {
        apiVersion: kind === 'CronJob' || kind === 'Job' ? 'batch/v1' : 'apps/v1', kind,
        metadata: { name, namespace },
        spec: kind === 'CronJob' ? { jobTemplate: { spec: { template } } } : { template },
      } });
      return resourcePath;
    },
    configMap(name: string, data: Record<string, string>, binaryData: Record<string, string> = {}, namespace = 'test') {
      responses.set(`/api/v1/namespaces/${namespace}/configmaps/${name}`, { body: { apiVersion: 'v1', kind: 'ConfigMap', data, binaryData } });
    },
    secret(name: string, data: Record<string, string>, namespace = 'test') {
      responses.set(`/api/v1/namespaces/${namespace}/secrets/${name}`, { body: { apiVersion: 'v1', kind: 'Secret', data: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, Buffer.from(value).toString('base64')])) } });
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export type TestApi = Awaited<ReturnType<typeof createApi>>;

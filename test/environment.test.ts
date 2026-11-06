import { afterEach, describe, expect, test } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { V1Container, V1EnvVar } from '@kubernetes/client-node';
import { KubernetesConnection } from '../src/kubernetes.js';
import { readWorkloadEnvironment } from '../src/environment.js';
import { parseWorkloadKind, workloadKinds } from '../src/model.js';
import { createApi } from './api.js';
import type { TestApi } from './api.js';

const activeApis: TestApi[] = [];
afterEach(async () => { await Promise.all(activeApis.splice(0).map((api) => api.close())); });

async function setup(container: V1Container = { name: 'app' }) {
  const api = await createApi();
  activeApis.push(api);
  api.workload('Deployment', [container]);
  return { api, connection: new KubernetesConnection({ kubeconfig: api.kubeconfig }) };
}

const target = { kind: parseWorkloadKind('Deployment'), name: 'app' };

describe('workload templates', () => {
  test.each(workloadKinds)('reads %s without looking up Pods', async (kind) => {
    const { api, connection } = await setup();
    api.workload(kind, [{ name: 'app', env: [{ name: 'VALUE', value: kind }] }]);
    await expect(readWorkloadEnvironment(connection, { kind, name: 'app' })).resolves.toEqual({ VALUE: kind });
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]?.method).toBe('GET');
    expect(api.requests[0]?.authorization).toBe('Bearer test-token');
  });

  test('requires an explicit container for multiple app containers', async () => {
    const { api, connection } = await setup();
    api.workload('Deployment', [{ name: 'app' }, { name: 'sidecar', env: [{ name: 'ONLY', value: 'sidecar' }] }]);
    await expect(readWorkloadEnvironment(connection, target)).rejects.toThrow('Multiple containers');
    await expect(readWorkloadEnvironment(connection, { ...target, container: 'sidecar' })).resolves.toEqual({ ONLY: 'sidecar' });
    await expect(readWorkloadEnvironment(connection, { ...target, container: 'init' })).rejects.toThrow('was not found');
  });

  test('uses the selected context namespace and supports an explicit override', async () => {
    const { api } = await setup();
    api.workload('Deployment', [{ name: 'app', env: [{ name: 'VALUE', value: 'other' }] }], 'other');
    await expect(readWorkloadEnvironment(new KubernetesConnection({ kubeconfig: api.kubeconfig, context: 'other' }), target)).resolves.toEqual({ VALUE: 'other' });
    await expect(readWorkloadEnvironment(new KubernetesConnection({ kubeconfig: api.kubeconfig, context: 'other', namespace: 'test' }), target)).resolves.toEqual({});
  });

  test('rejects invalid configuration before sending requests', async () => {
    const { api } = await setup();
    expect(() => new KubernetesConnection({ kubeconfig: api.kubeconfig, context: 'missing' })).toThrow('context "missing"');
    for (const timeoutMs of [0, -1, 0.1, Infinity, 300001]) expect(() => new KubernetesConnection({ kubeconfig: api.kubeconfig, timeoutMs })).toThrow('timeoutMs');
    expect(() => parseWorkloadKind('Pod')).toThrow('Unsupported workload kind');
    expect(api.requests).toHaveLength(0);
  });
});

describe('container environment semantics', () => {
  test.each(['ConfigMap', 'Secret'])('preserves a __proto__ data key from %s when envFrom prefixes its name', async (kind) => {
    const { api, connection } = await setup({ name: 'app', envFrom: [kind === 'ConfigMap'
      ? { configMapRef: { name: 'data' }, prefix: 'APP_' }
      : { secretRef: { name: 'data' }, prefix: 'APP_' }] });
    const data = Object.fromEntries([['__proto__', 'preserved-value']]);
    if (kind === 'ConfigMap') api.configMap('data', data);
    else api.secret('data', data);
    await expect(readWorkloadEnvironment(connection, target)).resolves.toEqual({ APP___proto__: 'preserved-value' });
  });

  test.each(['constructor', 'toString', '__proto__'])('rejects final env key %s that Varlock would silently discard', async (name) => {
    const { connection } = await setup({ name: 'app', env: [{ name, value: 'must-not-be-silently-lost' }] });
    await expect(readWorkloadEnvironment(connection, target)).rejects.toMatchObject({ code: 'unsupported' });
  });

  test.each(['envFrom', 'env'])('validates final values after a later %s overrides binary Secret data', async (override) => {
    const container: V1Container = { name: 'app', envFrom: [{ secretRef: { name: 'binary' } }] };
    if (override === 'envFrom') container.envFrom?.push({ configMapRef: { name: 'replacement' } });
    else container.env = [{ name: 'TOKEN', value: 'usable-text' }];
    const { api, connection } = await setup(container);
    api.responses.set('/api/v1/namespaces/test/secrets/binary', { body: { data: { TOKEN: '/w==' } } });
    api.configMap('replacement', { TOKEN: 'usable-text' });
    await expect(readWorkloadEnvironment(connection, target)).resolves.toEqual({ TOKEN: 'usable-text' });
  });

  test('merges sources in order, adds prefixes, and lets explicit env override all envFrom sources', async () => {
    const { api, connection } = await setup({ name: 'app', envFrom: [
      { configMapRef: { name: 'config-hash123' } }, { secretRef: { name: 'secrets' } },
      { configMapRef: { name: 'config-hash123' }, prefix: 'COPY_' },
    ], env: [{ name: 'SHARED', value: 'explicit' }, { name: 'EMPTY', value: '' }, { name: 'UNSET' }] });
    api.configMap('config-hash123', { SHARED: 'config', URL: 'localhost', EMPTY: 'nonempty' }, { FILE: Buffer.from('excluded').toString('base64') });
    api.secret('secrets', { SHARED: 'secret', TOKEN: 'token', EXPRESSION: '$(literal)' });
    await expect(readWorkloadEnvironment(connection, target)).resolves.toEqual({
      SHARED: 'explicit', URL: 'localhost', EMPTY: '', TOKEN: 'token', EXPRESSION: '$(literal)',
      COPY_SHARED: 'config', COPY_URL: 'localhost', COPY_EMPTY: 'nonempty', UNSET: '',
    });
    expect(api.requests.filter((request) => request.path.includes('configmaps'))).toHaveLength(1);
  });

  test('reads only the selected key, preserving UTF-8, BOM, newlines, and whitespace', async () => {
    const { api, connection } = await setup({ name: 'app', env: [
      { name: 'VALUE', valueFrom: { configMapKeyRef: { name: 'config', key: 'value' } } },
      { name: 'TOKEN', valueFrom: { secretKeyRef: { name: 'secret', key: 'token' } } },
    ] });
    const token = '\uFEFF 한국어\n"quote" # $ = \\ end ';
    api.configMap('config', { value: '', irrelevant: '\0' });
    api.responses.set('/api/v1/namespaces/test/secrets/secret', { body: { data: { token: Buffer.from(token).toString('base64'), binary: '/w==' } } });
    await expect(readWorkloadEnvironment(connection, target)).resolves.toEqual({ VALUE: '', TOKEN: token });
  });

  test('preserves a prefixed constructor key as data without mutating the result prototype', async () => {
    const { api, connection } = await setup({ name: 'app', envFrom: [{ configMapRef: { name: 'config' }, prefix: 'APP_' }] });
    api.configMap('config', { constructor: 'safe' });
    const result = await readWorkloadEnvironment(connection, target);
    expect(Object.hasOwn(result, 'APP_constructor')).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(JSON.stringify(result)).toBe('{"APP_constructor":"safe"}');
  });

  test('skips optional missing resources and keys without erasing earlier envFrom values', async () => {
    const { api, connection } = await setup({ name: 'app', envFrom: [
      { configMapRef: { name: 'config' } }, { secretRef: { name: 'missing', optional: true } },
    ], env: [
      { name: 'KEEP', valueFrom: { secretKeyRef: { name: 'missing', key: 'key', optional: true } } },
      { name: 'KEEP', valueFrom: { configMapKeyRef: { name: 'config', key: 'missing', optional: true } } },
    ] });
    api.configMap('config', { KEEP: 'present' });
    await expect(readWorkloadEnvironment(connection, target)).resolves.toEqual({ KEEP: 'present' });
    expect(api.requests.filter((request) => request.path.endsWith('/secrets/missing'))).toHaveLength(1);
  });

  test('rejects required missing keys, including binaryData-only ConfigMap keys', async () => {
    const { api, connection } = await setup({ name: 'app', env: [{ name: 'FILE', valueFrom: { configMapKeyRef: { name: 'config', key: 'FILE' } } }] });
    api.configMap('config', {}, { FILE: Buffer.from('file').toString('base64') });
    await expect(readWorkloadEnvironment(connection, target)).rejects.toThrow('Key "FILE" was not found');
  });

  const unsupportedItems: V1EnvVar[] = [
    { name: 'VALUE', value: '$(OTHER)' },
    { name: 'VALUE', value: '$$(OTHER)' },
    { name: 'VALUE', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } },
    { name: 'VALUE', valueFrom: { resourceFieldRef: { resource: 'limits.cpu' } } },
  ];
  test.each(unsupportedItems)('rejects unsupported env declaration %#', async (item) => {
    const { connection } = await setup({ name: 'app', env: [item] });
    await expect(readWorkloadEnvironment(connection, target)).rejects.toMatchObject({ code: 'unsupported' });
  });

  test.each([
    { data: { TOKEN: '/w==' }, message: 'not UTF-8' },
    { data: { TOKEN: 'not base64!' }, message: 'not valid base64' },
    { data: { TOKEN: Buffer.from('before\0after').toString('base64') }, message: 'NUL byte' },
  ])('rejects unexportable Secret values %#', async ({ data, message }) => {
    const { api, connection } = await setup({ name: 'app', envFrom: [{ secretRef: { name: 'secret' } }] });
    api.responses.set('/api/v1/namespaces/test/secrets/secret', { body: { data } });
    await expect(readWorkloadEnvironment(connection, target)).rejects.toThrow(message);
  });

  test('fetches current resources again on the next resolution', async () => {
    const { api, connection } = await setup({ name: 'app', envFrom: [{ configMapRef: { name: 'old-hash' } }] });
    api.configMap('old-hash', { VALUE: 'old' });
    await expect(readWorkloadEnvironment(connection, target)).resolves.toEqual({ VALUE: 'old' });
    api.workload('Deployment', [{ name: 'app', envFrom: [{ configMapRef: { name: 'new-hash' } }] }]);
    api.configMap('new-hash', { VALUE: 'new' });
    await expect(readWorkloadEnvironment(connection, target)).resolves.toEqual({ VALUE: 'new' });
  });
});

describe('API failures', () => {
  test.each([
    { body: { data: { TOKEN: { value: 'DO_NOT_LEAK_RESPONSE' } } } },
    { body: ['DO_NOT_LEAK_RESPONSE'] },
  ])('rejects malformed successful resource data without leaking it or retaining connections %#', async ({ body }) => {
    const { api, connection } = await setup({ name: 'app', envFrom: [{ secretRef: { name: 'secret' } }] });
    api.responses.set('/api/v1/namespaces/test/secrets/secret', { body });
    const failure = await readWorkloadEnvironment(connection, target).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'value' });
    expect(String(failure)).not.toContain('DO_NOT_LEAK_RESPONSE');
    await expect.poll(() => api.openConnections(), { timeout: 500 }).toBe(0);
  });

  test.each([200, 403])('releases request-owned connections after HTTP %s', async (status) => {
    const { api, connection } = await setup();
    if (status === 403) {
      const path = api.workload('Deployment', [{ name: 'app' }]);
      api.responses.set(path, { status, body: { code: status } });
      await expect(readWorkloadEnvironment(connection, target)).rejects.toMatchObject({ code: 'forbidden' });
    } else {
      await expect(readWorkloadEnvironment(connection, target)).resolves.toEqual({});
    }
    await expect.poll(() => api.openConnections(), { timeout: 500 }).toBe(0);
  });

  test('starts the HTTP timeout after exec credentials are refreshed', async () => {
    const { api } = await setup();
    const command = join(api.directory, 'credential.mjs');
    await writeFile(command, `setTimeout(() => process.stdout.write(JSON.stringify({apiVersion:'client.authentication.k8s.io/v1beta1',kind:'ExecCredential',status:{token:'test-token'}})), 200);`);
    const kubeconfig: unknown = JSON.parse(await readFile(api.kubeconfig, 'utf8'));
    if (!kubeconfig || typeof kubeconfig !== 'object' || !('clusters' in kubeconfig)) throw new Error('Invalid kubeconfig fixture');
    await writeFile(api.kubeconfig, JSON.stringify({
      ...kubeconfig,
      users: [{ name: 'test', user: { exec: { apiVersion: 'client.authentication.k8s.io/v1beta1', command: process.execPath, args: [command], interactiveMode: 'Never' } } }],
    }));
    const connection = new KubernetesConnection({ kubeconfig: api.kubeconfig, timeoutMs: 50 });
    await expect(readWorkloadEnvironment(connection, target)).resolves.toEqual({});
    expect(api.requests[0]?.authorization).toBe('Bearer test-token');
  });

  test.each([401, 403, 404, 500])('fails on HTTP %s without leaking the response body', async (status) => {
    const { api, connection } = await setup({ name: 'app', envFrom: [{ secretRef: { name: 'secret' } }] });
    api.responses.set('/api/v1/namespaces/test/secrets/secret', { status, body: { message: 'DO_NOT_LEAK_SECRET', code: status } });
    await expect(readWorkloadEnvironment(connection, target)).rejects.toThrow(/Secret "secret"/);
    try { await readWorkloadEnvironment(connection, target); } catch (error) { expect(String(error)).not.toContain('DO_NOT_LEAK_SECRET'); }
  });

  test.each([401, 403, 500])('does not suppress HTTP %s for optional references', async (status) => {
    const { api, connection } = await setup({ name: 'app', envFrom: [{ secretRef: { name: 'secret', optional: true } }] });
    api.responses.set('/api/v1/namespaces/test/secrets/secret', { status, body: { code: status } });
    await expect(readWorkloadEnvironment(connection, target)).rejects.toThrow();
  });

  test('aborts a slow API request', async () => {
    const { api } = await setup();
    const path = api.workload('Deployment', [{ name: 'app' }]);
    const original = api.responses.get(path);
    if (!original) throw new Error('Missing fixture');
    api.responses.set(path, { ...original, delayMs: 1000 });
    const started = Date.now();
    await expect(readWorkloadEnvironment(new KubernetesConnection({ kubeconfig: api.kubeconfig, timeoutMs: 30 }), target)).rejects.toMatchObject({ code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(900);
  });
});

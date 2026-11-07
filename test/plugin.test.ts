import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, test } from 'vitest';
import { createApi } from './api.js';
import type { TestApi } from './api.js';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const cli = join(root, 'node_modules/varlock/bin/cli.js');
const activeApis: TestApi[] = [];
afterEach(async () => {
  await Promise.all(activeApis.splice(0).map((api) => api.close()));
});

async function fixture(extraHeader = '', items = 'VALUE=\nTOKEN=', initOptions = '') {
  const api = await createApi();
  activeApis.push(api);
  api.workload('Deployment', [
    { name: 'app', envFrom: [{ configMapRef: { name: 'config-hash' } }, { secretRef: { name: 'secret' } }] },
  ]);
  api.configMap('config-hash', { VALUE: 'cluster', UNDECLARED: 'excluded' });
  api.secret('secret', { TOKEN: 'fake-secret' });
  const input = join(api.directory, 'env');
  await mkdir(input);
  await writeFile(
    join(input, '.env.schema'),
    `# @plugin(${JSON.stringify(join(root, 'dist/plugin.cjs'))})\n# @initK8sWorkload(kubeconfig=${JSON.stringify(api.kubeconfig)}${initOptions ? `, ${initOptions}` : ''})\n# @setValuesBulk(k8sWorkloadEnv(kind=Deployment, name=app), format=json)\n# @defaultSensitive=true\n${extraHeader}\n# ---\n${items}\n`,
  );
  return { api, input };
}

async function load(input: string, format = 'json', extra: string[] = []) {
  return exec(process.execPath, [cli, 'load', '--path', input, '--format', format, '--skip-cache', ...extra], {
    cwd: root,
    env: { ...process.env, DO_NOT_TRACK: '1' },
    maxBuffer: 4 * 1024 * 1024,
  });
}

test('loads the actual bundled plugin through the published Varlock CLI and applies schema filtering', async () => {
  const { api, input } = await fixture();
  const result = await load(input);
  expect(JSON.parse(result.stdout)).toEqual({ VALUE: 'cluster', TOKEN: 'fake-secret' });
  expect(api.requests.every((request) => request.method === 'GET')).toBe(true);
  expect(api.requests).toHaveLength(3);
});

test('allows Varlock local overrides and process environment precedence', async () => {
  const { input } = await fixture();
  await writeFile(join(input, '.env.local'), 'VALUE=local\n');
  expect(JSON.parse((await load(input)).stdout).VALUE).toBe('local');
  const result = await exec(process.execPath, [cli, 'load', '--path', input, '--format', 'json'], {
    env: { ...process.env, DO_NOT_TRACK: '1', VALUE: 'process' },
  });
  expect(JSON.parse(result.stdout).VALUE).toBe('process');
});

test('keeps secrets redacted in agent output', async () => {
  const { input } = await fixture();
  const result = await load(input, 'json', ['--agent']);
  expect(result.stdout).not.toContain('fake-secret');
  expect(result.stderr).not.toContain('fake-secret');
});

test('round-trips dotenv-special values through the file exporter and the actual Next.js loader', async () => {
  const { api, input } = await fixture();
  const token = ' 한국어\n"double" \'single\' #hash $value = \\path ';
  api.secret('secret', { TOKEN: token });
  const reload = join(api.directory, 'reload');
  await mkdir(reload);
  const output = join(reload, '.env.local');
  await exec(process.execPath, [join(root, 'dist/pull-env.mjs'), input, output]);
  const nextLoader = join(root, 'node_modules/@next/env/dist/index.js');
  const script = `const {loadEnvConfig}=require(${JSON.stringify(nextLoader)});const result=loadEnvConfig(process.argv[1],true);console.log(JSON.stringify(result.parsedEnv));`;
  const result = await exec(process.execPath, ['-e', script, reload], {
    env: { ...process.env, NODE_ENV: 'development' },
  });
  expect(JSON.parse(result.stdout)).toEqual({ VALUE: 'cluster', TOKEN: token });
});

test('preserves dollar references, literal escapes, empty/whitespace values, and each supported quoting form for Next.js', async () => {
  const samples = {
    PLAIN: 'plain',
    EMPTY: '',
    SPACE: '  padded  ',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: This fixture tests a literal dotenv reference.
    DOLLAR: '$HOME ${UNSET} $(literal)',
    ESCAPED_DOLLAR: '\\$HOME \\\\$HOME',
    LITERAL_NEWLINE: 'literal\\nnot-newline',
    QUOTES: 'both \'single\' and "double"',
    BACKTICK: "`tick` and apostrophe'",
    CRLF: 'line\r\nnext',
    MULTILINE: 'line\nnext',
    BACKSLASH: '\\directory\\file',
    TRAILING_BACKSLASH: 'C:\\workspace\\',
    MIXED_QUOTES: 'pa\'ss"wo`rd',
    TRAILING_BACKSLASH_WITH_SPACES: 'C:\\Program Files\\app\\',
    MIXED_QUOTES_AND_DOLLAR: 'pa\'ss"wo`rd $HOME \\$literal',
    LITERAL_ESCAPE_AND_TRAILING_BACKSLASH: '\\n\\',
  };
  const { api, input } = await fixture(
    '',
    Object.keys(samples)
      .map((key) => `# @required=false\n${key}=`)
      .join('\n'),
  );
  api.secret('secret', samples);
  const reload = join(api.directory, 'reload');
  await mkdir(reload);
  const output = join(reload, '.env.local');
  await exec(process.execPath, [join(root, 'dist/pull-env.mjs'), input, output]);
  const nextLoader = join(root, 'node_modules/@next/env/dist/index.js');
  const script = `const {loadEnvConfig}=require(${JSON.stringify(nextLoader)});console.log(JSON.stringify(loadEnvConfig(process.argv[1],true).parsedEnv));`;
  const result = await exec(process.execPath, ['-e', script, reload], {
    env: { ...process.env, NODE_ENV: 'development' },
  });
  expect(JSON.parse(result.stdout)).toEqual(samples);
});

test.each([
  ' all \' " ` delimiters ',
  '\'mixed"`starts',
  'mixed\'"`#comment',
  'mixed\'"`\nnext',
  'mixed\'"`\u2028next',
])('preserves the existing file when a value cannot be represented losslessly %#', async (token) => {
  const { api, input } = await fixture();
  api.secret('secret', { TOKEN: token });
  const output = join(api.directory, '.env.local');
  await writeFile(output, 'EXISTING=keep\n');
  await expect(exec(process.execPath, [join(root, 'dist/pull-env.mjs'), input, output])).rejects.toThrow();
  expect(await readFile(output, 'utf8')).toBe('EXISTING=keep\n');
});

test('fails and preserves the existing file instead of silently dropping a prototype-property env key', async () => {
  const { api, input } = await fixture('', 'constructor=\nVALUE=');
  api.workload('Deployment', [
    {
      name: 'app',
      env: [
        { name: 'constructor', value: 'must-be-preserved-or-rejected' },
        { name: 'VALUE', value: 'normal-value' },
      ],
    },
  ]);
  const output = join(api.directory, '.env.local');
  await writeFile(output, 'EXISTING=keep\n');
  await expect(exec(process.execPath, [join(root, 'dist/pull-env.mjs'), input, output])).rejects.toThrow();
  expect(await readFile(output, 'utf8')).toBe('EXISTING=keep\n');
});

test('supports named Kubernetes instances without colliding with the default instance', async () => {
  const { api, input } = await fixture(
    `# @initK8sWorkload(id=other, kubeconfig=PLACEHOLDER, context=other)`,
    'VALUE=\nTOKEN=\nOTHER=',
  );
  api.workload('Deployment', [{ name: 'app', env: [{ name: 'OTHER', value: 'other-namespace' }] }], 'other');
  const schemaFile = join(input, '.env.schema');
  const original = await readFile(schemaFile, 'utf8');
  await writeFile(
    schemaFile,
    original
      .replace('PLACEHOLDER', JSON.stringify(api.kubeconfig))
      .replace('# ---', '# @setValuesBulk(k8sWorkloadEnv(id=other, kind=Deployment, name=app), format=json)\n# ---'),
  );
  expect(JSON.parse((await load(input)).stdout)).toEqual({
    VALUE: 'cluster',
    TOKEN: 'fake-secret',
    OTHER: 'other-namespace',
  });
});

test.each([
  { search: 'kind=Deployment', replacement: 'kind=Service', error: 'Unsupported workload kind' },
  { search: 'name=app', replacement: 'name=app, typo=true', error: 'Unknown argument' },
  { search: 'name=app', replacement: 'name=app, container=missing', error: 'was not found' },
])(
  'reports configuration failure without silently exporting a partial result %#',
  async ({ search, replacement, error }) => {
    const { input } = await fixture();
    const schemaFile = join(input, '.env.schema');
    await writeFile(schemaFile, (await readFile(schemaFile, 'utf8')).replace(search, replacement));
    await expect(load(input)).rejects.toThrow();
    const diagnosis = await exec(process.execPath, [cli, 'load', '--path', input, '--agent'], {
      env: { ...process.env, DO_NOT_TRACK: '1' },
    }).catch((reason: unknown) => reason);
    expect(String(diagnosis)).toContain(error);
  },
);

test('atomically writes a private output and preserves it when the cluster read fails', async () => {
  const { api, input } = await fixture();
  const output = join(api.directory, '.env.local');
  const command = [join(root, 'dist/pull-env.mjs'), input, output];
  const first = await exec(process.execPath, command, { env: { ...process.env, DO_NOT_TRACK: '1' } });
  expect(first.stdout).not.toContain('fake-secret');
  expect((await stat(output)).mode & 0o777).toBe(0o600);
  const before = await readFile(output, 'utf8');
  expect(before).toContain('fake-secret');
  api.secret('secret', { TOKEN: 'updated-secret' });
  await exec(process.execPath, command, { env: { ...process.env, DO_NOT_TRACK: '1' } });
  const updated = await readFile(output, 'utf8');
  expect(updated).toContain('updated-secret');
  expect(updated).not.toContain('fake-secret');
  api.responses.set('/api/v1/namespaces/test/secrets/secret', { status: 403, body: { message: 'DO_NOT_LEAK' } });
  await expect(exec(process.execPath, command)).rejects.toThrow('existing output was preserved');
  expect(await readFile(output, 'utf8')).toBe(updated);
  expect((await readdir(api.directory)).some((name) => name.startsWith('.varlock-env-'))).toBe(false);
});

test('rejects output inside the input directory, including a symlink alias', async () => {
  const { api, input } = await fixture();
  const alias = join(api.directory, 'alias');
  await symlink(input, alias);
  for (const directory of [input, alias]) {
    await expect(
      exec(process.execPath, [join(root, 'dist/pull-env.mjs'), input, join(directory, '.env.local')]),
    ).rejects.toThrow('outside the Varlock input');
  }
  expect(api.requests).toHaveLength(0);
});

async function scalarFixture(items: string, extraHeader = '', initOptions = '') {
  const result = await fixture(extraHeader, items, initOptions);
  const schemaFile = join(result.input, '.env.schema');
  await writeFile(
    schemaFile,
    (await readFile(schemaFile, 'utf8')).replace(
      '# @setValuesBulk(k8sWorkloadEnv(kind=Deployment, name=app), format=json)\n',
      '',
    ),
  );
  return result;
}

test('loads individual values with inferred and mapped keys, sharing reads and refreshing the next load', async () => {
  const { api, input } = await scalarFixture(
    [
      'VALUE=k8sWorkloadEnvValue(kind=Deployment, name=app)',
      'LOCAL_TOKEN=k8sWorkloadEnvValue(kind=Deployment, name=app, key=TOKEN)',
      'TOKEN_COPY=k8sWorkloadEnvValue(kind=Deployment, name=app, key=TOKEN)',
    ].join('\n'),
  );
  expect(JSON.parse((await load(input)).stdout)).toEqual({
    VALUE: 'cluster',
    LOCAL_TOKEN: 'fake-secret',
    TOKEN_COPY: 'fake-secret',
  });
  expect(api.requests).toHaveLength(3);
  api.secret('secret', { TOKEN: 'updated' });
  expect(JSON.parse((await load(input)).stdout)).toEqual({
    VALUE: 'cluster',
    LOCAL_TOKEN: 'updated',
    TOKEN_COPY: 'updated',
  });
  expect(api.requests).toHaveLength(6);
});

test('exports individual mappings while ignoring unrelated unsupported and binary values', async () => {
  const { api, input } = await scalarFixture(
    [
      'LOCAL_TOKEN=k8sWorkloadEnvValue(kind=Deployment, name=app, key=TOKEN)',
      '# @required=false',
      'EMPTY=k8sWorkloadEnvValue(kind=Deployment, name=app)',
    ].join('\n'),
  );
  api.workload('Deployment', [
    {
      name: 'app',
      envFrom: [{ secretRef: { name: 'secret' } }],
      env: [{ name: 'POD_IP', valueFrom: { fieldRef: { fieldPath: 'status.podIP' } } }],
    },
  ]);
  api.responses.set('/api/v1/namespaces/test/secrets/secret', {
    body: { data: { TOKEN: Buffer.from('mapped').toString('base64'), EMPTY: '', BINARY: '/w==' } },
  });
  const output = join(api.directory, '.env.local');
  await exec(process.execPath, [join(root, 'dist/pull-env.mjs'), input, output]);
  expect(await readFile(output, 'utf8')).toBe("LOCAL_TOKEN='mapped'\nEMPTY=''\n");
  expect(api.requests).toHaveLength(2);
});

test('shares workload and resource reads between bulk and individual resolvers', async () => {
  const { api, input } = await fixture(
    '',
    'VALUE=\nTOKEN=\nLOCAL_TOKEN=k8sWorkloadEnvValue(kind=Deployment, name=app, key=TOKEN)',
  );
  expect(JSON.parse((await load(input)).stdout)).toEqual({
    VALUE: 'cluster',
    TOKEN: 'fake-secret',
    LOCAL_TOKEN: 'fake-secret',
  });
  expect(api.requests).toHaveLength(3);
});

test('supports named connections and schema overrides for individual resolvers', async () => {
  const { api, input } = await scalarFixture(
    'VALUE=k8sWorkloadEnvValue(id=other, kind=Deployment, name=app)',
    '# @initK8sWorkload(id=other, kubeconfig=PLACEHOLDER, context=other)',
  );
  const schemaFile = join(input, '.env.schema');
  await writeFile(
    schemaFile,
    (await readFile(schemaFile, 'utf8')).replace('PLACEHOLDER', JSON.stringify(api.kubeconfig)),
  );
  api.workload('Deployment', [{ name: 'app', env: [{ name: 'VALUE', value: 'other' }] }], 'other');
  expect(JSON.parse((await load(input)).stdout)).toEqual({ VALUE: 'other' });
  await writeFile(join(input, '.env.local'), 'VALUE=local\n');
  expect(JSON.parse((await load(input)).stdout)).toEqual({ VALUE: 'local' });
});

test.each([
  { query: 'kind=Deployment, name=app, key=ABSENT', error: 'Environment variable "ABSENT" was not found' },
  { query: 'kind=Deployment, name=app, key=""', error: 'key must be a non-empty string' },
  { query: 'kind=Deployment, name=app, typo=true', error: 'Unknown argument "typo"' },
  { query: 'kind=Pod, name=app', error: 'Unsupported workload kind' },
  { query: 'kind=Deployment, name=app, container=missing', error: 'Container "missing" was not found' },
  { query: 'id=missing, kind=Deployment, name=app', error: 'Initialize Kubernetes workload instance "missing"' },
])('rejects invalid individual queries: $query', async ({ query, error }) => {
  const { input } = await scalarFixture(`# @required=false\nVALUE=k8sWorkloadEnvValue(${query})`);
  await expect(load(input)).rejects.toThrow(error);
});

test('does not reuse resource reads or connection state across loads in the same process', async () => {
  const { api, input } = await scalarFixture('VALUE=k8sWorkloadEnvValue(kind=Deployment, name=app)');
  const script = `
    import { internal } from ${JSON.stringify(join(root, 'node_modules/varlock/dist/index.mjs'))};
    const values = [];
    for (let i = 0; i < 2; i++) {
      const graph = await internal.loadEnvGraph({ basePath: process.argv[1], skipCache: true, checkGitIgnored: false });
      await graph.resolveEnvValues();
      values.push(graph.configSchema.VALUE.resolvedValue);
    }
    console.log(JSON.stringify(values));
  `;
  const result = await exec(process.execPath, ['--input-type=module', '-e', script, input], {
    cwd: root,
    env: { ...process.env, DO_NOT_TRACK: '1' },
  });
  expect(JSON.parse(result.stdout)).toEqual(['cluster', 'cluster']);
  expect(api.requests).toHaveLength(6);
});

test('infers the enclosing config item name inside nested value expressions', async () => {
  const { api, input } = await scalarFixture(
    [
      'VALUE=concat("prefix:", k8sWorkloadEnvValue(kind=Deployment, name=app))',
      'TOKEN_COPY=concat(k8sWorkloadEnvValue(kind=Deployment, name=app, key=TOKEN), ":suffix")',
    ].join('\n'),
  );
  expect(JSON.parse((await load(input)).stdout)).toEqual({ VALUE: 'prefix:cluster', TOKEN_COPY: 'fake-secret:suffix' });
  expect(api.requests).toHaveLength(3);
});

test('requires an explicit key outside config item value expressions', async () => {
  const { api, input } = await scalarFixture(
    'VALUE=',
    '# @setValuesBulk(k8sWorkloadEnvValue(kind=Deployment, name=app), format=json)',
  );
  await expect(load(input)).rejects.toThrow('requires key outside a config item value expression');
  expect(api.requests).toHaveLength(0);
});

test('maps prototype-property source names to safe schema names through the actual CLI', async () => {
  const { api, input } = await scalarFixture(
    [
      'LOCAL_PROTO=k8sWorkloadEnvValue(kind=Deployment, name=app, key=__proto__)',
      'LOCAL_CONSTRUCTOR=k8sWorkloadEnvValue(kind=Deployment, name=app, key=constructor)',
      'LOCAL_TO_STRING=k8sWorkloadEnvValue(kind=Deployment, name=app, key=toString)',
    ].join('\n'),
  );
  api.workload('Deployment', [{ name: 'app', envFrom: [{ secretRef: { name: 'secret' } }] }]);
  api.secret(
    'secret',
    Object.fromEntries([
      ['__proto__', 'proto'],
      ['constructor', 'constructor'],
      ['toString', 'string'],
    ]),
  );
  expect(JSON.parse((await load(input)).stdout)).toEqual({
    LOCAL_PROTO: 'proto',
    LOCAL_CONSTRUCTOR: 'constructor',
    LOCAL_TO_STRING: 'string',
  });
  expect(api.requests).toHaveLength(2);
});

test('uses a default workload for individual and bulk reads while sharing requests', async () => {
  const { api, input } = await scalarFixture(
    'VALUE=k8sWorkloadEnvValue()\nTOKEN=',
    '# @setValuesBulk(k8sWorkloadEnv(), format=json)',
    'defaultKind=Deployment, defaultName=app, defaultContainer=app',
  );
  expect(JSON.parse((await load(input)).stdout)).toEqual({ VALUE: 'cluster', TOKEN: 'fake-secret' });
  expect(api.requests).toHaveLength(3);
});

test('allows optional missing variables and Varlock fallbacks without changing empty strings', async () => {
  const { api, input } = await scalarFixture(
    [
      '# @required=false',
      'ABSENT=k8sWorkloadEnvValue(allowMissing=true)',
      'LOG_LEVEL=fallback(k8sWorkloadEnvValue(allowMissing=true), "info")',
      '# @required=false',
      'EMPTY=k8sWorkloadEnvValue(allowMissing=true)',
    ].join('\n'),
    '',
    'defaultKind=Deployment, defaultName=app',
  );
  api.secret('secret', { EMPTY: '' });
  expect(JSON.parse((await load(input)).stdout)).toEqual({ LOG_LEVEL: 'info', EMPTY: '' });
  const output = join(api.directory, '.env.local');
  await exec(process.execPath, [join(root, 'dist/pull-env.mjs'), input, output]);
  expect(await readFile(output, 'utf8')).toBe("LOG_LEVEL='info'\nEMPTY=''\n");
});

test('lets explicit workload arguments override each default', async () => {
  const { api, input } = await scalarFixture(
    [
      'VALUE=k8sWorkloadEnvValue()',
      'EXPLICIT=k8sWorkloadEnvValue(kind=StatefulSet, name=second, container=other, key=VALUE)',
    ].join('\n'),
    '',
    'defaultKind=Deployment, defaultName=app, defaultContainer=app',
  );
  api.workload(
    'StatefulSet',
    [{ name: 'other', env: [{ name: 'VALUE', value: 'second' }] }, { name: 'sidecar' }],
    'test',
    'second',
  );
  expect(JSON.parse((await load(input)).stdout)).toEqual({ VALUE: 'cluster', EXPLICIT: 'second' });
  expect(api.requests).toHaveLength(4);
});

test('keeps defaults and allowMissing separate across connection IDs', async () => {
  const { api, input } = await scalarFixture(
    [
      'VALUE=k8sWorkloadEnvValue()',
      'OTHER=k8sWorkloadEnvValue(id=other, key=VALUE)',
      '# @required=false',
      'MISSING=k8sWorkloadEnvValue()',
    ].join('\n'),
    '# @initK8sWorkload(id=other, kubeconfig=PLACEHOLDER, defaultKind=StatefulSet, defaultName=second)',
    'defaultKind=Deployment, defaultName=app, allowMissing=true',
  );
  const schema = join(input, '.env.schema');
  await writeFile(schema, (await readFile(schema, 'utf8')).replace('PLACEHOLDER', JSON.stringify(api.kubeconfig)));
  api.workload('StatefulSet', [{ name: 'app', env: [{ name: 'VALUE', value: 'other' }] }], 'test', 'second');
  expect(JSON.parse((await load(input)).stdout)).toEqual({ VALUE: 'cluster', OTHER: 'other' });
  await writeFile(
    schema,
    (await readFile(schema, 'utf8')).replace('MISSING=k8sWorkloadEnvValue()', 'MISSING=k8sWorkloadEnvValue(id=other)'),
  );
  await expect(load(input)).rejects.toThrow('Environment variable "MISSING" was not found');
});

test('allows a resolver to require a key even when the connection allows missing keys', async () => {
  const { input } = await scalarFixture(
    '# @required=false\nABSENT=k8sWorkloadEnvValue(allowMissing=false)',
    '',
    'defaultKind=Deployment, defaultName=app, allowMissing=true',
  );
  await expect(load(input)).rejects.toThrow('Environment variable "ABSENT" was not found');
});

test('still applies required validation when an allowed missing key resolves to undefined', async () => {
  const { input } = await scalarFixture(
    'ABSENT=k8sWorkloadEnvValue(allowMissing=true)',
    '',
    'defaultKind=Deployment, defaultName=app',
  );
  await expect(load(input)).rejects.toThrow('ABSENT');
});

test.each([
  { options: 'defaultKind=Pod', query: '', error: 'Unsupported workload kind' },
  { options: 'defaultName=""', query: 'kind=Deployment, name=app', error: 'defaultName must be a non-empty string' },
  {
    options: 'defaultContainer=123',
    query: 'kind=Deployment, name=app',
    error: 'defaultContainer must be a non-empty string',
  },
  { options: 'allowMissing="true"', query: 'kind=Deployment, name=app', error: 'allowMissing must be a boolean' },
  { options: '', query: 'kind=Deployment, name=app, allowMissing="false"', error: 'allowMissing must be a boolean' },
  { options: 'defaultKind=Deployment', query: '', error: 'kind and name are required' },
  { options: 'defaultName=app', query: '', error: 'kind and name are required' },
])('validates default and optional arguments: $options / $query', async ({ options, query, error }) => {
  const { api, input } = await scalarFixture(`VALUE=k8sWorkloadEnvValue(${query})`, '', options);
  await expect(load(input)).rejects.toThrow(error);
  expect(api.requests).toHaveLength(0);
});

test.each([401, 403, 404, 500])('does not suppress source HTTP %s with allowMissing=true', async (status) => {
  const { api, input } = await scalarFixture(
    '# @required=false\nVALUE=k8sWorkloadEnvValue(allowMissing=true)',
    '',
    'defaultKind=Deployment, defaultName=app',
  );
  api.responses.set('/api/v1/namespaces/test/secrets/secret', {
    status,
    body: { message: 'synthetic-private-response' },
  });
  const result = await load(input).catch((error: unknown) => error);
  expect(result).toBeInstanceOf(Error);
  if (!(result instanceof Error)) throw new Error('Expected source read failure');
  expect(result.message).not.toContain('synthetic-private-response');
  expect(api.requests.some((request) => request.path.endsWith('/secrets/secret'))).toBe(true);
});

test('does not hide missing workloads, containers, required key refs, or invalid selected values', async () => {
  const { api, input } = await scalarFixture(
    '# @required=false\nVALUE=k8sWorkloadEnvValue(allowMissing=true)',
    '',
    'defaultKind=Deployment, defaultName=app',
  );
  api.responses.set('/apis/apps/v1/namespaces/test/deployments/app', { status: 404, body: {} });
  await expect(load(input)).rejects.toThrow('Deployment "app"');
  api.workload('Deployment', [{ name: 'app' }, { name: 'sidecar' }]);
  await expect(load(input)).rejects.toThrow('Multiple containers');
  api.workload('Deployment', [
    { name: 'app', env: [{ name: 'VALUE', valueFrom: { secretKeyRef: { name: 'secret', key: 'absent' } } }] },
  ]);
  await expect(load(input)).rejects.toThrow('Key "absent"');
  api.workload('Deployment', [{ name: 'app', envFrom: [{ secretRef: { name: 'secret' } }] }]);
  api.responses.set('/api/v1/namespaces/test/secrets/secret', { body: { data: { VALUE: '/w==' } } });
  await expect(load(input)).rejects.toThrow('not UTF-8');
  api.workload('Deployment', [
    { name: 'app', env: [{ name: 'VALUE', valueFrom: { fieldRef: { fieldPath: 'status.podIP' } } }] },
  ]);
  await expect(load(input)).rejects.toThrow('unsupported valueFrom');
});

test('does not let a connection allowMissing setting hide a broken bulk source', async () => {
  const { api, input } = await fixture('', '# @required=false\nVALUE=', 'allowMissing=true');
  api.responses.set('/api/v1/namespaces/test/secrets/secret', { status: 404, body: {} });
  await expect(load(input)).rejects.toThrow('Secret "secret"');
});

test.each([
  { defaults: 'defaultKind=Deployment', query: 'name=app' },
  { defaults: 'defaultName=app', query: 'kind=Deployment' },
])('combines partial defaults with explicit arguments: $defaults', async ({ defaults, query }) => {
  const { input } = await scalarFixture(`VALUE=k8sWorkloadEnvValue(${query})`, '', defaults);
  expect(JSON.parse((await load(input)).stdout)).toEqual({ VALUE: 'cluster' });
});

test.each(['kind', 'name', 'container'])(
  'rejects unresolved explicit %s instead of reading the default workload',
  async (argument) => {
    const { api, input } = await scalarFixture(
      ['# @required=false', 'UNSET_TARGET=', `VALUE=k8sWorkloadEnvValue(${argument}=ref(UNSET_TARGET))`].join('\n'),
      '',
      'defaultKind=Deployment, defaultName=app, defaultContainer=app',
    );
    await expect(load(input)).rejects.toThrow(`${argument} must be a non-empty string`);
    expect(api.requests).toHaveLength(0);
  },
);

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
afterEach(async () => { await Promise.all(activeApis.splice(0).map((api) => api.close())); });

async function fixture(extraHeader = '', items = 'VALUE=\nTOKEN=') {
  const api = await createApi();
  activeApis.push(api);
  api.workload('Deployment', [{ name: 'app', envFrom: [{ configMapRef: { name: 'config-hash' } }, { secretRef: { name: 'secret' } }] }]);
  api.configMap('config-hash', { VALUE: 'cluster', UNDECLARED: 'excluded' });
  api.secret('secret', { TOKEN: 'fake-secret' });
  const input = join(api.directory, 'env');
  await mkdir(input);
  await writeFile(join(input, '.env.schema'), `# @plugin(${JSON.stringify(join(root, 'dist/plugin.cjs'))})\n# @initK8sWorkload(kubeconfig=${JSON.stringify(api.kubeconfig)})\n# @setValuesBulk(k8sWorkloadEnv(kind=Deployment, name=app), format=json)\n# @defaultSensitive=true\n${extraHeader}\n# ---\n${items}\n`);
  return { api, input };
}

async function load(input: string, format = 'json', extra: string[] = []) {
  return exec(process.execPath, [cli, 'load', '--path', input, '--format', format, '--skip-cache', ...extra], {
    cwd: root, env: { ...process.env, DO_NOT_TRACK: '1' }, maxBuffer: 4 * 1024 * 1024,
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
  const result = await exec(process.execPath, ['-e', script, reload], { env: { ...process.env, NODE_ENV: 'development' } });
  expect(JSON.parse(result.stdout)).toEqual({ VALUE: 'cluster', TOKEN: token });
});

test('preserves dollar references, literal escapes, empty/whitespace values, and each supported quoting form for Next.js', async () => {
  const samples = {
    PLAIN: 'plain', EMPTY: '', SPACE: '  padded  ', DOLLAR: '$HOME ${UNSET} $(literal)',
    ESCAPED_DOLLAR: '\\$HOME \\\\$HOME', LITERAL_NEWLINE: 'literal\\nnot-newline',
    QUOTES: 'both \'single\' and "double"', BACKTICK: '`tick` and apostrophe\'',
    CRLF: 'line\r\nnext', MULTILINE: 'line\nnext', BACKSLASH: '\\directory\\file',
    TRAILING_BACKSLASH: 'C:\\workspace\\', MIXED_QUOTES: 'pa\'ss"wo`rd',
    TRAILING_BACKSLASH_WITH_SPACES: 'C:\\Program Files\\app\\',
    MIXED_QUOTES_AND_DOLLAR: 'pa\'ss"wo`rd $HOME \\$literal',
    LITERAL_ESCAPE_AND_TRAILING_BACKSLASH: '\\n\\',
  };
  const { api, input } = await fixture('', Object.keys(samples).map((key) => `# @required=false\n${key}=`).join('\n'));
  api.secret('secret', samples);
  const reload = join(api.directory, 'reload');
  await mkdir(reload);
  const output = join(reload, '.env.local');
  await exec(process.execPath, [join(root, 'dist/pull-env.mjs'), input, output]);
  const nextLoader = join(root, 'node_modules/@next/env/dist/index.js');
  const script = `const {loadEnvConfig}=require(${JSON.stringify(nextLoader)});console.log(JSON.stringify(loadEnvConfig(process.argv[1],true).parsedEnv));`;
  const result = await exec(process.execPath, ['-e', script, reload], { env: { ...process.env, NODE_ENV: 'development' } });
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
  api.workload('Deployment', [{ name: 'app', env: [
    { name: 'constructor', value: 'must-be-preserved-or-rejected' },
    { name: 'VALUE', value: 'normal-value' },
  ] }]);
  const output = join(api.directory, '.env.local');
  await writeFile(output, 'EXISTING=keep\n');
  await expect(exec(process.execPath, [join(root, 'dist/pull-env.mjs'), input, output])).rejects.toThrow();
  expect(await readFile(output, 'utf8')).toBe('EXISTING=keep\n');
});

test('supports named Kubernetes instances without colliding with the default instance', async () => {
  const { api, input } = await fixture(`# @initK8sWorkload(id=other, kubeconfig=PLACEHOLDER, context=other)`, 'VALUE=\nTOKEN=\nOTHER=');
  api.workload('Deployment', [{ name: 'app', env: [{ name: 'OTHER', value: 'other-namespace' }] }], 'other');
  const schemaFile = join(input, '.env.schema');
  const original = await readFile(schemaFile, 'utf8');
  await writeFile(schemaFile, original.replace('PLACEHOLDER', JSON.stringify(api.kubeconfig)).replace('# ---', '# @setValuesBulk(k8sWorkloadEnv(id=other, kind=Deployment, name=app), format=json)\n# ---'));
  expect(JSON.parse((await load(input)).stdout)).toEqual({ VALUE: 'cluster', TOKEN: 'fake-secret', OTHER: 'other-namespace' });
});

test.each([
  { search: 'kind=Deployment', replacement: 'kind=Service', error: 'Unsupported workload kind' },
  { search: 'name=app', replacement: 'name=app, typo=true', error: 'Unknown argument' },
  { search: 'name=app', replacement: 'name=app, container=missing', error: 'was not found' },
])('reports configuration failure without silently exporting a partial result %#', async ({ search, replacement, error }) => {
  const { input } = await fixture();
  const schemaFile = join(input, '.env.schema');
  await writeFile(schemaFile, (await readFile(schemaFile, 'utf8')).replace(search, replacement));
  await expect(load(input)).rejects.toThrow();
  const diagnosis = await exec(process.execPath, [cli, 'load', '--path', input, '--agent'], { env: { ...process.env, DO_NOT_TRACK: '1' } }).catch((reason: unknown) => reason);
  expect(String(diagnosis)).toContain(error);
});

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
    await expect(exec(process.execPath, [join(root, 'dist/pull-env.mjs'), input, join(directory, '.env.local')])).rejects.toThrow('outside the Varlock input');
  }
  expect(api.requests).toHaveLength(0);
});

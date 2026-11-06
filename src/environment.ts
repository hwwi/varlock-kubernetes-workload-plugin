import type { V1Container, V1EnvFromSource, V1EnvVar, V1PodSpec } from '@kubernetes/client-node';
import { KubernetesConnection } from './kubernetes.js';
import { WorkloadError } from './model.js';
import type { WorkloadTarget } from './model.js';

type SourceKind = 'ConfigMap' | 'Secret';

type EnvironmentValue =
  | { kind: 'text'; value: string; location: string }
  | { kind: 'secret'; encoded: string; name: string; key: string };

function referenceValue(kind: SourceKind, name: string, key: string, value: string): EnvironmentValue {
  if (kind === 'Secret') return { kind: 'secret', encoded: value, name, key };
  return { kind: 'text', value, location: `ConfigMap "${name}" key "${key}"` };
}

function textValue(value: string, location: string): string {
  if (value.includes('\0')) throw new WorkloadError('value', `${location} contains a NUL byte and cannot be an environment value.`);
  return value;
}

function decodeSecret(value: string, name: string, key: string): string {
  const location = `Secret "${name}" key "${key}"`;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new WorkloadError('value', `${location} is not valid base64.`);
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new WorkloadError('value', `${location} is not UTF-8 text and cannot be exported losslessly.`);
  }
  return textValue(decoded, location);
}

function decodeValue(value: EnvironmentValue): string {
  return value.kind === 'secret'
    ? decodeSecret(value.encoded, value.name, value.key)
    : textValue(value.value, value.location);
}

function selectContainer(spec: V1PodSpec, name: string | undefined): V1Container {
  let container: V1Container | undefined;
  if (name) container = spec.containers.find((candidate) => candidate.name === name);
  else if (spec.containers.length === 1) container = spec.containers[0];
  if (!container) {
    throw new WorkloadError('configuration', name
      ? `Container "${name}" was not found. Available containers: ${spec.containers.map((item) => item.name).join(', ')}.`
      : `Multiple containers found. Specify container: ${spec.containers.map((item) => item.name).join(', ')}.`);
  }
  return container;
}

export class WorkloadEnvironmentReader {
  // One reader belongs to one initialized connection in a Varlock load. Share in-flight
  // reads across resolvers without persisting cluster values between loads.
  private readonly templates = new Map<string, Promise<V1PodSpec>>();
  private readonly resources = new Map<string, Promise<Map<string, string>>>();

  constructor(private readonly connection: KubernetesConnection) {}

  private async container(target: WorkloadTarget): Promise<V1Container> {
    const key = JSON.stringify([target.kind, target.name]);
    let pending = this.templates.get(key);
    if (!pending) {
      pending = this.connection.podSpec(target);
      this.templates.set(key, pending);
    }
    return selectContainer(await pending, target.container);
  }

  private data(kind: SourceKind, name: string): Promise<Map<string, string>> {
    const cacheKey = `${kind}/${name}`;
    const cached = this.resources.get(cacheKey);
    if (cached) return cached;
    const pending = (async () => {
      if (kind === 'ConfigMap') {
        const resource = await this.connection.configMap(name);
        // Kubelet uses data for env injection. binaryData is only for file projections.
        return new Map(Object.entries(resource.data ?? {}));
      }
      const resource = await this.connection.secret(name);
      return new Map(Object.entries(resource.data ?? {}));
    })();
    this.resources.set(cacheKey, pending);
    return pending;
  }

  private async optionalData(kind: SourceKind, name: string, optional: boolean | undefined): Promise<Map<string, string> | undefined> {
    if (!name) throw new WorkloadError('value', `${kind} reference has no name.`);
    try {
      return await this.data(kind, name);
    } catch (error) {
      if (optional && error instanceof WorkloadError && error.code === 'not-found') return undefined;
      throw error;
    }
  }

  private async from(source: V1EnvFromSource, values: Map<string, EnvironmentValue>, selectedKey?: string): Promise<void> {
    const ref = source.configMapRef ?? source.secretRef;
    if (!ref || (source.configMapRef && source.secretRef)) throw new WorkloadError('unsupported', 'envFrom must reference exactly one ConfigMap or Secret.');
    const prefix = source.prefix ?? '';
    if (selectedKey !== undefined && !selectedKey.startsWith(prefix)) return;
    const kind = source.configMapRef ? 'ConfigMap' : 'Secret';
    const data = await this.optionalData(kind, ref.name ?? '', ref.optional);
    if (selectedKey !== undefined) {
      const key = selectedKey.slice(prefix.length);
      const value = data?.get(key);
      if (value !== undefined) values.set(selectedKey, referenceValue(kind, ref.name ?? '', key, value));
    } else {
      for (const [key, value] of data ?? []) {
        values.set(`${prefix}${key}`, referenceValue(kind, ref.name ?? '', key, value));
      }
    }
  }

  private async item(item: V1EnvVar, values: Map<string, EnvironmentValue>): Promise<void> {
    const location = `Environment variable "${item.name}"`;
    if (!item.valueFrom) {
      const value = item.value ?? '';
      if (value.includes('$(')) throw new WorkloadError('unsupported', `${location} uses $(VAR) expansion, which is not supported.`);
      values.set(item.name, { kind: 'text', value, location });
      return;
    }
    if (item.value !== undefined && item.value !== '') throw new WorkloadError('value', `${location} defines both value and valueFrom.`);
    const sources = Object.values(item.valueFrom).filter((value) => value !== undefined);
    const ref = item.valueFrom.configMapKeyRef ?? item.valueFrom.secretKeyRef;
    if (sources.length !== 1 || !ref) throw new WorkloadError('unsupported', `${location} uses an unsupported valueFrom. Only configMapKeyRef and secretKeyRef are supported.`);
    const kind = item.valueFrom.configMapKeyRef ? 'ConfigMap' : 'Secret';
    const name = ref.name ?? '';
    const data = await this.optionalData(kind, name, ref.optional);
    if (!data) return;
    const value = data.get(ref.key);
    if (value === undefined) {
      if (ref.optional) return;
      throw new WorkloadError('not-found', `Key "${ref.key}" was not found in ${kind} "${name}" for environment variable "${item.name}".`);
    }
    values.set(item.name, referenceValue(kind, name, ref.key, value));
  }

  async read(target: WorkloadTarget): Promise<Record<string, string>> {
    const container = await this.container(target);
    const values = new Map<string, EnvironmentValue>();
    for (const source of container.envFrom ?? []) await this.from(source, values);
    for (const item of container.env ?? []) await this.item(item, values);
    // Only the merged environment is exported. Earlier, overridden binary values are irrelevant.
    const decoded = new Map<string, string>();
    for (const [key, value] of values) {
      if (Object.hasOwn(Object.prototype, key)) {
        throw new WorkloadError('unsupported', `Environment key "${key}" cannot be loaded reliably by Varlock. Rename it or use an envFrom prefix.`);
      }
      decoded.set(key, decodeValue(value));
    }
    return Object.fromEntries(decoded);
  }

  async readValue(target: WorkloadTarget, key: string): Promise<string> {
    const container = await this.container(target);
    const values = new Map<string, EnvironmentValue>();
    // Walk precedence backwards so unrelated declarations and shadowed sources
    // cannot block a selected value. Optional misses leave lower-priority values available.
    for (const item of (container.env ?? []).toReversed()) {
      if (item.name !== key) continue;
      await this.item(item, values);
      const value = values.get(key);
      if (value !== undefined) return decodeValue(value);
    }
    for (const source of (container.envFrom ?? []).toReversed()) {
      await this.from(source, values, key);
      const value = values.get(key);
      if (value !== undefined) return decodeValue(value);
    }
    throw new WorkloadError('not-found', `Environment variable "${key}" was not found in ${target.kind} "${target.name}" container "${container.name}".`);
  }
}

export async function readWorkloadEnvironment(connection: KubernetesConnection, target: WorkloadTarget): Promise<Record<string, string>> {
  return new WorkloadEnvironmentReader(connection).read(target);
}

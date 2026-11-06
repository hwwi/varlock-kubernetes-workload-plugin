import { plugin } from 'varlock/plugin-lib';
import type { Resolver } from 'varlock/plugin-lib';
import { KubernetesConnection } from './kubernetes.js';
import { WorkloadEnvironmentReader } from './environment.js';
import { parseWorkloadKind, WorkloadError } from './model.js';
import type { WorkloadTarget } from './model.js';

const { SchemaError, ResolutionError } = plugin.ERRORS;
const readers = new Map<string, WorkloadEnvironmentReader | undefined>();

plugin.name = 'kubernetes-workload';
plugin.icon = 'mdi:kubernetes';

function staticId(resolver: Resolver | undefined): string {
  if (!resolver) return '_default';
  if (!resolver.isStatic || typeof resolver.staticValue !== 'string' || !resolver.staticValue) {
    throw new SchemaError('id must be a non-empty static string.');
  }
  return resolver.staticValue;
}

async function stringArg(resolver: Resolver | undefined, label: string, required = false): Promise<string | undefined> {
  const value: unknown = await resolver?.resolve();
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new SchemaError(`${label} must be a non-empty string.`);
  return value;
}

async function workloadTarget(args: Record<string, Resolver> | undefined): Promise<WorkloadTarget> {
  const kind = await stringArg(args?.kind, 'kind', true);
  const name = await stringArg(args?.name, 'name', true);
  if (!kind || !name) throw new SchemaError('kind and name are required.');
  return {
    kind: parseWorkloadKind(kind),
    name,
    container: await stringArg(args?.container, 'container'),
  };
}

function inferItemKey(context: unknown): string {
  // Varlock 1.24 uses this parent link for its own Kubernetes key inference,
  // but does not expose it in Resolver's public types. Validate the boundary.
  if (context && typeof context === 'object' && 'parent' in context) {
    const parent = context.parent;
    if (parent && typeof parent === 'object' && 'key' in parent && typeof parent.key === 'string') {
      return parent.key;
    }
  }
  throw new SchemaError('k8sWorkloadEnvValue() requires key outside a config item value expression.');
}

function assertArgs(args: Record<string, Resolver> | undefined, allowed: readonly string[]): void {
  for (const key of Object.keys(args ?? {})) {
    if (!allowed.includes(key)) throw new SchemaError(`Unknown argument "${key}". Expected ${allowed.join(', ')}.`);
  }
}

function report(error: unknown): never {
  if (error instanceof WorkloadError) {
    if (error.code === 'configuration') throw new SchemaError(error.message);
    throw new ResolutionError(error.message);
  }
  if (error instanceof SchemaError || error instanceof ResolutionError) throw error;
  throw new ResolutionError('Failed to resolve Kubernetes workload environment. Check the workload configuration and cluster connectivity.');
}

plugin.registerRootDecorator({
  name: 'initK8sWorkload',
  description: 'Initialize read-only Kubernetes workload access using kubeconfig',
  isFunction: true,
  process(args) {
    if (args.arrArgs?.length) throw new SchemaError('initK8sWorkload() accepts named arguments only.');
    assertArgs(args.objArgs, ['id', 'context', 'namespace', 'kubeconfig', 'timeoutMs']);
    const id = staticId(args.objArgs?.id);
    if (readers.has(id)) throw new SchemaError(`Kubernetes workload instance "${id}" is already initialized.`);
    readers.set(id, undefined);
    return { id, args: args.objArgs };
  },
  async execute({ id, args }) {
    try {
      const rawTimeout: unknown = await args?.timeoutMs?.resolve();
      if (rawTimeout !== undefined && typeof rawTimeout !== 'number') throw new SchemaError('timeoutMs must be a number.');
      readers.set(id, new WorkloadEnvironmentReader(new KubernetesConnection({
        context: await stringArg(args?.context, 'context'),
        namespace: await stringArg(args?.namespace, 'namespace'),
        kubeconfig: await stringArg(args?.kubeconfig, 'kubeconfig'),
        timeoutMs: rawTimeout,
      })));
    } catch (error) { report(error); }
  },
});

plugin.registerResolverFunction({
  name: 'k8sWorkloadEnv',
  label: 'Read environment variables from a Kubernetes workload template',
  argsSchema: { type: 'mixed', arrayMinLength: 0, arrayMaxLength: 0 },
  process() {
    assertArgs(this.objArgs, ['id', 'kind', 'name', 'container']);
    const id = staticId(this.objArgs?.id);
    if (!readers.has(id)) throw new SchemaError(`Initialize Kubernetes workload instance "${id}" with @initK8sWorkload() first.`);
    return { id, args: this.objArgs };
  },
  async resolve({ id, args }) {
    try {
      const reader = readers.get(id);
      if (!reader) throw new SchemaError(`Kubernetes workload instance "${id}" is not initialized.`);
      return JSON.stringify(await reader.read(await workloadTarget(args)));
    } catch (error) { report(error); }
  },
});

plugin.registerResolverFunction({
  name: 'k8sWorkloadEnvValue',
  label: 'Read one environment variable from a Kubernetes workload template',
  argsSchema: { type: 'mixed', arrayMinLength: 0, arrayMaxLength: 0 },
  process() {
    assertArgs(this.objArgs, ['id', 'kind', 'name', 'container', 'key']);
    const id = staticId(this.objArgs?.id);
    if (!readers.has(id)) throw new SchemaError(`Initialize Kubernetes workload instance "${id}" with @initK8sWorkload() first.`);
    const inferredKey = this.objArgs?.key ? undefined : inferItemKey(this);
    return { id, args: this.objArgs, inferredKey };
  },
  async resolve({ id, args, inferredKey }) {
    try {
      const reader = readers.get(id);
      if (!reader) throw new SchemaError(`Kubernetes workload instance "${id}" is not initialized.`);
      const key = args?.key ? await stringArg(args.key, 'key', true) : inferredKey;
      if (!key) throw new SchemaError('key is required.');
      return await reader.readValue(await workloadTarget(args), key);
    } catch (error) { report(error); }
  },
});

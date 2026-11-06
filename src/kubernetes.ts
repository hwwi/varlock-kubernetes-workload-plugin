import { AppsV1Api, BatchV1Api, CoreV1Api, KubeConfig, Observable, SelfDecodingBody } from '@kubernetes/client-node';
import type { ConfigurationOptions, RequestContext, V1ConfigMap, V1PodSpec, V1Secret } from '@kubernetes/client-node';
import { WorkloadError } from './model.js';
import type { ConnectionOptions, WorkloadTarget } from './model.js';

function statusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  if ('code' in error && typeof error.code === 'number') return error.code;
  if ('statusCode' in error && typeof error.statusCode === 'number') return error.statusCode;
  return undefined;
}

type RequestDispatcher = NonNullable<ReturnType<RequestContext['getDispatcher']>>;
type DataObserver = (data: Record<string, string> | undefined) => void;

function isStringMap(value: unknown): value is Record<string, string> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value).every((item: unknown) => typeof item === 'string');
}

function resourceData(raw: string): Record<string, string> | undefined {
  const resource: unknown = JSON.parse(raw);
  if (!resource || typeof resource !== 'object' || Array.isArray(resource)) {
    throw new WorkloadError('value', 'Kubernetes returned an invalid resource object.');
  }
  if (!('data' in resource) || resource.data === null || resource.data === undefined) return undefined;
  if (!isStringMap(resource.data)) throw new WorkloadError('value', 'Kubernetes resource data must be a string map.');
  return resource.data;
}

class ApiRequest {
  private signal: AbortSignal | undefined;
  private readonly dispatchers = new Set<RequestDispatcher>();
  readonly options: ConfigurationOptions;

  constructor(timeoutMs: number, observeData?: DataObserver) {
    this.options = {
      middlewareMergeStrategy: 'append',
      middleware: [{
        pre: (context) => {
          // Credential refresh completes before middleware runs; time only the HTTP request.
          this.signal = AbortSignal.timeout(timeoutMs);
          context.setSignal(this.signal);
          const dispatcher = context.getDispatcher();
          if (dispatcher) this.dispatchers.add(dispatcher);
          return new Observable(Promise.resolve(context));
        },
        post(context) {
          if (!observeData || context.httpStatusCode !== 200) return new Observable(Promise.resolve(context));
          const prepared = context.body.text().then((raw) => {
            // The SDK deserializer assigns map keys to {}, losing __proto__. Keep the JSON map intact.
            // Buffer the consumed body so the SDK can still deserialize metadata and other fields.
            context.body = new SelfDecodingBody(Promise.resolve(Buffer.from(raw, 'utf8')));
            observeData(resourceData(raw));
            return context;
          });
          return new Observable(prepared);
        },
      }],
    };
  }

  get timedOut(): boolean { return this.signal?.aborted ?? false; }

  async close(): Promise<void> {
    // KubeConfig creates these dispatchers per request. Dispose after body parsing, including errors.
    // An absent dispatcher means the SDK used its shared default pool, which we do not own.
    await Promise.all([...this.dispatchers].map((dispatcher) => dispatcher.destroy()));
  }
}

export class KubernetesConnection {
  private readonly kubeconfig: KubeConfig;
  readonly namespace: string;
  private readonly timeoutMs: number;

  constructor(options: ConnectionOptions = {}) {
    this.kubeconfig = new KubeConfig();
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300_000) {
      throw new WorkloadError('configuration', 'timeoutMs must be an integer between 1 and 300000.');
    }

    try {
      if (options.kubeconfig) this.kubeconfig.loadFromFile(options.kubeconfig);
      else this.kubeconfig.loadFromDefault();
      if (options.context) {
        if (!this.kubeconfig.getContextObject(options.context)) {
          throw new WorkloadError('configuration', `Kubernetes context "${options.context}" was not found.`);
        }
        this.kubeconfig.setCurrentContext(options.context);
      }
      const context = this.kubeconfig.getContextObject(this.kubeconfig.getCurrentContext());
      if (!context || !this.kubeconfig.getCurrentCluster()) {
        throw new WorkloadError('configuration', 'No usable Kubernetes context found. Configure kubeconfig and context.');
      }
      this.namespace = options.namespace ?? context.namespace ?? 'default';
    } catch (error) {
      if (error instanceof WorkloadError) throw error;
      // API / credential errors can contain credentials or response bodies. Never forward them.
      throw new WorkloadError('configuration', 'Failed to load kubeconfig. Check its path, context, and credentials.');
    }
  }

  private async read<T>(kind: string, name: string, operation: (options: ConfigurationOptions) => Promise<T>, observeData?: DataObserver): Promise<T> {
    const request = new ApiRequest(this.timeoutMs, observeData);
    const location = `${kind} "${name}" in namespace "${this.namespace}"`;
    try {
      return await operation(request.options);
    } catch (error) {
      if (error instanceof WorkloadError) throw error;
      if (request.timedOut) throw new WorkloadError('timeout', `Timed out reading ${location}.`);
      switch (statusCode(error)) {
        case 404: throw new WorkloadError('not-found', `${location} was not found.`);
        case 401: throw new WorkloadError('unauthorized', `Authentication failed reading ${location}. Check kubeconfig credentials.`);
        case 403: throw new WorkloadError('forbidden', `Permission denied reading ${location}. Grant get access to this resource.`);
        default: throw new WorkloadError('read', `Failed to read ${location}. Check connectivity, TLS, and kubeconfig authentication.`);
      }
    } finally {
      await request.close();
    }
  }

  private async readDataResource<T extends { data?: Record<string, string> }>(
    kind: 'ConfigMap' | 'Secret', name: string, operation: (options: ConfigurationOptions) => Promise<T>,
  ): Promise<T> {
    let data: Record<string, string> | undefined;
    const resource = await this.read(kind, name, operation, (value) => { data = value; });
    if (data !== undefined) resource.data = data;
    return resource;
  }

  async podSpec(target: WorkloadTarget): Promise<V1PodSpec> {
    const namespace = this.namespace;
    const name = target.name;
    const apps = this.kubeconfig.makeApiClient(AppsV1Api);
    const batch = this.kubeconfig.makeApiClient(BatchV1Api);
    return this.read(target.kind, name, async (options) => {
      const request = { name, namespace };
      let spec: V1PodSpec | undefined;
      switch (target.kind) {
        case 'Deployment': spec = (await apps.readNamespacedDeployment(request, options)).spec?.template.spec; break;
        case 'StatefulSet': spec = (await apps.readNamespacedStatefulSet(request, options)).spec?.template.spec; break;
        case 'DaemonSet': spec = (await apps.readNamespacedDaemonSet(request, options)).spec?.template.spec; break;
        case 'Job': spec = (await batch.readNamespacedJob(request, options)).spec?.template.spec; break;
        case 'CronJob': spec = (await batch.readNamespacedCronJob(request, options)).spec?.jobTemplate.spec?.template.spec; break;
      }
      if (!spec || !Array.isArray(spec.containers) || spec.containers.length === 0) {
        throw new WorkloadError('value', `${target.kind} "${name}" has no usable Pod template containers.`);
      }
      return spec;
    });
  }

  configMap(name: string): Promise<V1ConfigMap> {
    const client = this.kubeconfig.makeApiClient(CoreV1Api);
    return this.readDataResource('ConfigMap', name, (options) => client.readNamespacedConfigMap({ name, namespace: this.namespace }, options));
  }

  secret(name: string): Promise<V1Secret> {
    const client = this.kubeconfig.makeApiClient(CoreV1Api);
    return this.readDataResource('Secret', name, (options) => client.readNamespacedSecret({ name, namespace: this.namespace }, options));
  }
}

# Kubernetes Workload Plugin for Varlock

[![npm beta](https://img.shields.io/npm/v/@hwwi/kubernetes-workload-plugin/beta)](https://www.npmjs.com/package/@hwwi/kubernetes-workload-plugin)

An unofficial Varlock plugin that loads environment variables from Kubernetes workload Pod templates.
The plugin follows ConfigMap and Secret references, including ConfigMap names with Kustomize hashes.

The [official Kubernetes plugin](https://varlock.dev/plugins/kubernetes/) reads Secrets and ConfigMaps by name.
This plugin starts from a workload and reads the environment declared for one of its containers.

## Install

Requires Node.js 22.19+ and Varlock 1.24.x.

Install the beta:

```sh
pnpm add -D varlock@1.24.0 @hwwi/kubernetes-workload-plugin@beta
```

## Usage

Keep Varlock input files separate from the generated file:

```text
env/
  .env.schema       # Commit this
  .env.local        # Local overrides, ignored by Git
.env.local          # Generated output, ignored by Git
```

For an application that receives `API_URL`, `DATABASE_URL`, and `LOG_LEVEL` through Kubernetes,
create `env/.env.schema`:

```dotenv
# @plugin(@hwwi/kubernetes-workload-plugin)
# @initK8sWorkload(context=dev-cluster, namespace=example)
# @setValuesBulk(k8sWorkloadEnv(kind=Deployment, name=example-app, container=app), format=json)
# @defaultSensitive=true
# ---

# @type=url @sensitive=false
API_URL=

DATABASE_URL=

# @sensitive=false
LOG_LEVEL=
```

Replace the context, namespace, workload, container, and variable names with your own.
The [example schema](examples/env/.env.schema) uses the same configuration.

To override cluster values locally, create `env/.env.local`:

```dotenv
API_URL=http://localhost:8080
LOG_LEVEL=debug
```

Generate the app's `.env.local`:

```sh
pnpm exec varlock-workload-pull ./env ./.env.local
```

Or add an npm script:

```json
{
  "scripts": {
    "env:pull": "varlock-workload-pull ./env ./.env.local"
  }
}
```

Varlock applies schema validation and its usual override order: bulk values override defaults in the same file;
higher-priority files and `process.env` can override bulk values.
Only declared variables are loaded unless you set `createMissing=true` on `@setValuesBulk()`.
Mark secrets with `@sensitive`, or use `@defaultSensitive=true`.
The plugin does not infer sensitivity from Secret references.

### Individual keys and local names

`k8sWorkloadEnvValue()` reads one variable from the selected container's environment.
Requires version 0.1.0-beta.2 or later.
Use it instead of `@setValuesBulk()` when selecting individual variables or renaming them:

```dotenv
# @plugin(@hwwi/kubernetes-workload-plugin)
# @initK8sWorkload(context=dev-cluster, namespace=example)
# @defaultSensitive=true
# ---

# @type=url @sensitive=false
API_URL=k8sWorkloadEnvValue(kind=Deployment, name=example-app, container=app)

LOCAL_DATABASE_URL=k8sWorkloadEnvValue(kind=Deployment, name=example-app, container=app, key=DATABASE_URL)
```

Omitting `key` uses the enclosing schema variable's name (`API_URL` above), including inside nested
value expressions such as `concat(...)`. An explicit `key` selects the
workload variable to map to the local name on the left (`DATABASE_URL` → `LOCAL_DATABASE_URL`).
It is the final container environment name, including any `envFrom.prefix`, not the underlying
ConfigMap or Secret data key. For example, if `DATABASE_URL` references Secret key `connection-string`,
use `key=DATABASE_URL`. See the [individual-key schema](examples/individual/.env.schema).

Individual reads follow the same precedence as bulk reads. They inspect matching `env` declarations
and then `envFrom` sources from highest to lowest priority, stopping when a value is found.
An unrelated `fieldRef` or binary value does not block the selected key. An unsupported declaration
or invalid text for the selected value still fails, as do access errors on resources needed to locate it.
A missing variable is an error even if the schema item has `@required=false`; an empty string is returned unchanged
and remains subject to Varlock validation.

Kubernetes returns whole ConfigMaps and Secrets, not individual keys. The plugin selects and decodes only
requested final values. Within one load and connection ID, bulk and individual resolvers share reads of the
same workload or source resource, including in-flight requests. Several keys from the same Secret require
one Secret read, even across workloads or containers. Different connection IDs keep separate reads.
The next load reads current resources again; these shared reads do not use a disk cache or provide key-level RBAC.
The same file exporter and local override files work with either resolver.

### Generated files

The exporter writes a plaintext dotenv file with mode `0600`. Failed exports preserve the existing file.
The output must be outside the Varlock input directory, including when using symlink aliases,
so generated values cannot become overrides on the next run.

Files are tested with Next.js's dotenv + dotenv-expand loader. Dollar signs are escaped to preserve literal values.
The exporter rejects invalid variable names and values that cannot be quoted without changing them.
Names must match `[A-Za-z_][A-Za-z0-9_]*`. Some combinations of quotes, whitespace, and line breaks cannot be exported.
Check compatibility before using a different dotenv loader. Varlock's `run` command is an alternative to file export.

## API

All arguments are named.

### `@initK8sWorkload(...)`

| Argument | Description |
| --- | --- |
| `id` | Optional static string identifying a connection. Defaults to `_default`. |
| `context` | Kubeconfig context. Defaults to the current context. |
| `namespace` | Defaults to the selected context's namespace, then `default`. |
| `kubeconfig` | Optional kubeconfig file path. Raw YAML/JSON strings are not supported. |
| `timeoutMs` | HTTP request timeout after authentication, in milliseconds. Default: `10000`; range: `1`–`300000`. |

Authentication uses the Kubernetes SDK and your kubeconfig. Exec credential plugins may run their configured CLI,
which must be installed and available on `$PATH`. `kubectl` is not required by the plugin.
Direct API server and token arguments are not supported.

`timeoutMs` does not limit credential CLI execution. The file exporter limits the entire Varlock subprocess to 60 seconds.

### `k8sWorkloadEnv(...)`

| Argument | Description |
| --- | --- |
| `id` | Optional connection ID from `@initK8sWorkload()`. Defaults to `_default`. |
| `kind` | `Deployment`, `StatefulSet`, `DaemonSet`, `Job`, or `CronJob`. Case-sensitive. |
| `name` | Workload name. |
| `container` | Container name. May be omitted when there is only one regular container. |

Returns a JSON object string for use with `@setValuesBulk(..., format=json)`.

### `k8sWorkloadEnvValue(...)`

Accepts the same arguments as `k8sWorkloadEnv()`, plus:

| Argument | Description |
| --- | --- |
| `key` | Final environment variable name in the selected container. Defaults to the enclosing schema item's name within its value expression. Required outside config item value expressions. |

Returns one string. To rename it locally, declare `LOCAL_NAME=k8sWorkloadEnvValue(..., key=WORKLOAD_NAME)`.
Bulk and individual resolvers can be used together, but bulk resolution still validates the complete merged environment.

## Supported sources

- `env[].value`
- `envFrom.configMapRef` and `envFrom.secretRef`, including `prefix`
- `env[].valueFrom.configMapKeyRef` and `secretKeyRef`
- Per-reference `optional`: missing resources or keys are skipped; authentication, permission, and network errors still fail

Later `envFrom` entries take precedence. Explicit `env` entries override `envFrom` values.
ConfigMaps contribute `data` only, not `binaryData`. Secrets are decoded from base64 as UTF-8 text.
Invalid UTF-8 and NUL bytes in the final merged values cause an error; overridden values and unselected keys are not decoded.
Workload templates and source resources are shared within one load and connection ID, including across resolver calls.

Bulk reads reject the following declarations; individual reads reject them when needed for the selected value:

- `fieldRef`, `resourceFieldRef`, and file-based environment references
- `$(VAR)` expansion and `$$(VAR)` escaping in direct `env.value` declarations

Bulk reads also reject final variable names matching Object prototype properties, such as `constructor`,
`toString`, or `__proto__`. Use an `envFrom` prefix, a different workload variable name through `valueFrom`,
or map that variable to a safe local name with `k8sWorkloadEnvValue(..., key=constructor)`.

The plugin reads the workload template and its referenced resources; no running Pods are required.
Resources are read separately and may change during an export. Values may differ from those in an existing Pod.
Only the selected regular container's `env` and `envFrom` are used.
Image defaults, service-link variables, volumes, and changes injected into Pods by admission webhooks are excluded.

## RBAC

The identity in your kubeconfig needs `get` access to the workload and its referenced ConfigMaps and Secrets.
Allow only the resource types you use; `resourceNames` can further restrict access.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: workload-env-reader
  namespace: example
rules:
  - apiGroups: [apps]
    resources: [deployments, statefulsets, daemonsets]
    verbs: [get]
  - apiGroups: [batch]
    resources: [jobs, cronjobs]
    verbs: [get]
  - apiGroups: ['']
    resources: [configmaps, secrets]
    verbs: [get]
```

## Troubleshooting

For detailed errors with sensitive values redacted:

```sh
pnpm exec varlock load --path ./env --agent
```

| Error | What to check |
| --- | --- |
| Authentication failed (401) | Check the context and kubeconfig. Refresh credentials if needed and ensure the exec credential CLI is on `$PATH`. |
| Permission denied (403) | Check `get` access to the workload and each referenced resource. |
| Resource or key not found | Check the namespace, workload name, and references in the template. |
| Timeout or connection failure | Check API server connectivity, VPN access if required, and credential CLI execution. |
| Dotenv export failed | Check the variable name and quoting restrictions under Generated files. Use runtime injection if a value cannot be exported. |
| Variable missing from output | Declare it in the schema or explicitly enable `createMissing=true`. |

## Development

Use Node.js 24.20.0 and pnpm 10.33.4, as configured in the repository.
Release workflow tests also use Git, tar, and the GitHub CLI (`gh`).

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:package
```

`check` runs type checking, builds, and tests, including the actual Varlock CLI and Next.js 16.2.6 env loader.
`test:package` installs a tarball in a separate project and checks the packaged plugin and CLI.
CI skips tests for changes limited to `README.md`, `AGENTS.md`, and `docs/`; release validation always runs all checks.

For Kubernetes integration tests, use a temporary kind cluster:

```sh
kind create cluster --name varlock-workload
WORKLOAD_TEST_CONTEXT=kind-varlock-workload pnpm test:cluster
kind delete cluster --name varlock-workload
```

These tests create and remove a temporary namespace in the specified kind context.

Use Conventional Commits for changes. release-please prepares a release PR
with the next beta version and CHANGELOG updates. Merge the PR when ready
to publish; the release workflow runs all CI checks, including kind
integration tests, before publishing to npm.

## Issues and contributions

Report bugs and suggestions in [GitHub Issues](https://github.com/hwwi/varlock-kubernetes-workload-plugin/issues).
Include your plugin, Varlock, and Node.js versions, OS, and a minimal reproduction with credentials removed.

PRs are welcome. Run the relevant tests and `pnpm check`, and update the README and examples when usage changes.

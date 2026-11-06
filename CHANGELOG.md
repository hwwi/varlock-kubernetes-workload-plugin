# Changelog

## Unreleased

- Add `k8sWorkloadEnvValue()` to select a workload environment variable and map it to a local name, defaulting to the schema item's name when `key` is omitted.
- Resolve only the selected final value, skipping unrelated unsupported declarations and binary values.
- Share workload and ConfigMap/Secret reads across bulk and individual resolvers within each load and connection ID.

## 0.1.0-beta.1

- Read container environment variables from Deployment, StatefulSet, DaemonSet, Job, and CronJob templates.
- Follow ConfigMap and Secret references, including prefixes, optional references, and Kubernetes environment precedence.
- Configure kubeconfig paths, contexts, namespaces, multiple connections, and HTTP request timeouts.
- Load values through a Varlock bulk resolver and export dotenv files with private permissions, preserving existing files on failure.
- Require Node.js 22.19+ and Varlock 1.24.x.

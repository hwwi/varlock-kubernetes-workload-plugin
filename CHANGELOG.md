# Changelog

## [0.1.0](https://github.com/hwwi/varlock-kubernetes-workload-plugin/compare/v0.1.0-beta.2...v0.1.0) (2026-11-07)


### Features

* add workload defaults and optional keys ([72cc680](https://github.com/hwwi/varlock-kubernetes-workload-plugin/commit/72cc680fce15a89166e303cb6a0bd1e9c67a513b))

## [0.1.0-beta.2](https://github.com/hwwi/varlock-kubernetes-workload-plugin/compare/v0.1.0-beta.1...v0.1.0-beta.2) (2026-11-06)


### Features

* add individual workload environment lookups ([fe3c11c](https://github.com/hwwi/varlock-kubernetes-workload-plugin/commit/fe3c11c2f0f29a5390fc55faf4d24c348314545e))

## 0.1.0-beta.1

- Read container environment variables from Deployment, StatefulSet, DaemonSet, Job, and CronJob templates.
- Follow ConfigMap and Secret references, including prefixes, optional references, and Kubernetes environment precedence.
- Configure kubeconfig paths, contexts, namespaces, multiple connections, and HTTP request timeouts.
- Load values through a Varlock bulk resolver and export dotenv files with private permissions, preserving existing files on failure.
- Require Node.js 22.19+ and Varlock 1.24.x.

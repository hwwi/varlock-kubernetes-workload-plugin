# Changelog

## 0.1.0-beta.1 (unreleased)

- Read container environment variables from Deployment, StatefulSet, DaemonSet, Job, and CronJob templates.
- Follow ConfigMap and Secret references, including prefixes, optional references, and Kubernetes environment precedence.
- Configure kubeconfig paths, contexts, namespaces, multiple connections, and HTTP request timeouts.
- Load values through a Varlock bulk resolver and export dotenv files with private permissions, preserving existing files on failure.
- Require Node.js 22.19+ and Varlock 1.24.x.

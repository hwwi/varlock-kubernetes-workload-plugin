# Repository guidance

This is an unofficial Varlock plugin for loading environment variables from Kubernetes workload templates.
Keep changes focused on the plugin, its dotenv exporter, and their existing contracts.

## Source and behavior

- Read workload Pod templates and their referenced ConfigMaps and Secrets through read-only Kubernetes API calls.
- Do not substitute running Pod state, Pod exec, or image environment variables for template values.
- Preserve Kubernetes precedence: later `envFrom` sources win, and explicit `env` entries override them.
- Optional missing resources or keys retain lower-priority values. Authentication, permission, and connection errors still fail.
- Share resource reads, including in-flight requests, within one initialized connection per Varlock load. Do not persist cluster values between loads.
- Decode and validate values being returned; unrelated or overridden values should not break an individual key lookup.
- Keep secret values out of logs, errors, snapshots, and committed fixtures. Use synthetic values in tests.

## Dotenv export

- Keep generated output outside the Varlock input directory to prevent it from becoming an override on the next load.
- Preserve the existing output on failure. Write through a temporary file in the destination directory and atomically replace it with mode `0600`.
- Preserve values through the supported Next.js dotenv loader. Reject values that cannot round-trip losslessly.

## Implementation

- Use strict TypeScript. Narrow `unknown` at external boundaries; do not use `any` or casts to bypass type errors.
- Keep resolver integration in `src/plugin.ts`, Kubernetes access in `src/kubernetes.ts`, and environment resolution in `src/environment.ts`.
- Keep CLI orchestration and dotenv serialization under `src/cli/`.
- Preserve the single CJS plugin bundle and external `varlock` / `varlock/plugin-lib` imports. Varlock's plugin context does not carry into separate chunks.
- Treat `dist/` as generated output. Change source or build configuration rather than editing it directly.

## Validation

Use the Node.js version in `.node-version` and pnpm version in `package.json`. Install with `pnpm install --frozen-lockfile`.

- Run `pnpm check` for code changes. It includes type checking, builds, and the default tests.
- Run `pnpm test:package` when packaging, dependencies, CLI entry points, or release behavior changes.
- Run `WORKLOAD_TEST_CONTEXT=kind-varlock-workload pnpm test:cluster` for Kubernetes behavior changes, using a temporary kind cluster.
- Use a dedicated test kubeconfig and explicit context. Do not run cluster tests against a shared development or production cluster; clean up resources created for the test.
- Reuse the local HTTP API fixtures and actual Varlock CLI, Next.js loader, tarball consumer, and kind tests where relevant.
- Add regression coverage for behavior fixes. Check the failure before the fix when practical, and report when that was not verified.
- For documentation-only changes, check the diff and referenced commands; code tests are unnecessary unless behavior is also affected.

## Documentation and releases

- Communicate with the user in Korean. Write public documentation, code comments, and commit messages in English.
- Use Conventional Commits. Keep README examples generic and documentation proportional to this small plugin.
- Let release-please update release versions and the changelog through its release PR; do not manually bump them unless requested.
- Keep the `CI result` check running for documentation-only changes. Release callers must set `full-check: true` to bypass path filtering.
- Use the GitHub App token only in the release-please job; keep dispatch authentication and npm OIDC separate.
- Preserve the release gate: full reusable CI, including kind integration tests, must pass before npm publishing.
- The `release.yml` workflow filename is part of the npm trusted publisher configuration. Coordinate any rename with that configuration.
- Commit, push, publish, or change external settings only when authorized by the user.

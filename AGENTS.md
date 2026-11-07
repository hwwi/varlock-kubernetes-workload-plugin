# Repository guidance

This is an unofficial Varlock plugin for loading environment variables from Kubernetes workload templates.
Keep changes focused on the plugin, its dotenv exporter, and their existing contracts.

## Source and behavior

- Read workload Pod templates and their referenced ConfigMaps and Secrets through read-only Kubernetes API calls.
- Do not substitute running Pod state, Pod exec, or image environment variables for template values.
- Preserve Kubernetes precedence: later `envFrom` sources win, and explicit `env` entries override them.
- `allowMissing` only permits an absent final environment variable in individual reads. Missing workloads and broken required source references still fail.
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
- Keep comments short and explain constraints or decisions that are hard to infer from the code.

## Validation

Use the Node.js version in `.node-version` and pnpm version in `package.json`. Install with `pnpm install --frozen-lockfile`.

- Start with tests that exercise the changed behavior. Rerun successful checks when relevant code or the environment changes, or when a concern remains unresolved.
- Run `pnpm check` for code changes. It includes type checking, builds, and the default tests.
- Run `pnpm test:package` when packaging, dependencies, CLI entry points, or release behavior changes.
- Run `WORKLOAD_TEST_CONTEXT=kind-varlock-workload pnpm test:cluster` for Kubernetes behavior changes, using a temporary kind cluster.
- Use a dedicated test kubeconfig and explicit context. Do not run cluster tests against a shared development or production cluster; clean up resources created for the test.
- Reuse the local HTTP API fixtures and actual Varlock CLI, Next.js loader, tarball consumer, and kind tests where relevant.
- Cover new behavior at the smallest test scope that exercises its contract. Use `test.each` when several inputs exercise the same contract.
- Add regression coverage for behavior fixes. Check the failure before the fix when practical, and report when that was not verified.
- For documentation-only changes, check the diff and referenced commands; code tests are unnecessary unless behavior is also affected.

## Documentation and releases

- Communicate with the user in Korean. Write public documentation, code comments, and commit messages in English.
- Update the README and affected examples in the same change when resolver arguments, defaults, error behavior, or CLI usage changes. Keep documentation focused and examples generic.
- Let release-please update release versions and the changelog through its release PR; do not manually bump them unless requested.
- Keep `CI result` running for documentation-only PRs. Pushes changing only `README.md`, `AGENTS.md`, or `docs/**` skip CI and Release Please.
- If GitHub's path-filter diff limit omits a CI run, use `gh workflow run ci.yml --ref main` to run the full suite on the current `main`.
- To process a `Release-As` footer after a filtered or empty push, run `gh workflow run release.yml --ref main`. Dispatch the workflow on a published `vX.Y.Z` tag to retry npm publication.
- For verified Release Please PRs and their merges, defer full tests to the release tag when only the package version and release metadata change. Release callers must set `full-check: true`.
- Use the GitHub App token only in the release-please job; keep dispatch authentication and npm OIDC separate.
- Preserve the release gate: full reusable CI, including kind integration tests, must pass before npm publishing.
- After a release, verify that the release workflow succeeded and npm serves the intended version. Check that `latest` points to it unless a newer release has already advanced the tag.
- The `release.yml` workflow filename is part of the npm trusted publisher configuration. Coordinate any rename with that configuration.

## Commits and pull requests

- Commit, push, publish, or change external settings only when authorized by the user.
- Use Conventional Commits and keep each commit focused on one change. Base the message on the diff being committed and the confirmed context.
- Start the body with why the change is needed, then explain the resulting behavior or a design choice that matters. Omit the body if the title is enough. Include operational impact, compatibility, or verification details in plain prose when relevant.
- Keep PR descriptions short. Summarize the resulting behavior, report the checks actually run, and link related issues when relevant. Cite file and line references and name the relevant symbol when explaining a finding.

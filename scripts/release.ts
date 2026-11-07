import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const packageName = '@hwwi/kubernetes-workload-plugin';
const repository = 'hwwi/varlock-kubernetes-workload-plugin';
const number = '(0|[1-9][0-9]*)';
const prereleaseId = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
const versionPattern = new RegExp(
  `^${number}\\.${number}\\.${number}(?:-(${prereleaseId}(?:\\.${prereleaseId})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);
type VersionCore = readonly [bigint, bigint, bigint];

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseVersion(value: string): { core: VersionCore; prerelease: boolean } {
  const match = versionPattern.exec(value);
  const [, major, minor, patch, prerelease] = match ?? [];
  if (match?.[0] !== value || !major || !minor || !patch)
    throw new Error(`Expected a valid SemVer version, received ${value}.`);
  const core: VersionCore = [BigInt(major), BigInt(minor), BigInt(patch)];
  if (core.some((part) => part > BigInt(Number.MAX_SAFE_INTEGER)))
    throw new Error('Version components exceed the SemVer limit.');
  return { core, prerelease: prerelease !== undefined };
}

export function releaseVersion(value: string): VersionCore {
  const parsed = parseVersion(value);
  if (parsed.prerelease || value.includes('+'))
    throw new Error(`Expected an X.Y.Z release version, received ${value}.`);
  return parsed.core;
}

// The candidate is a plain release; latest may still point to an old stage or beta.
export function compareReleaseToLatest(version: string, latest: string): number {
  const candidate = releaseVersion(version);
  const current = parseVersion(latest);
  for (const [index, part] of candidate.entries()) {
    const other = current.core[index];
    if (other === undefined) throw new Error('Invalid release version.');
    if (part !== other) return part < other ? -1 : 1;
  }
  return current.prerelease ? 1 : 0;
}

function environment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function jsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function requestJson(url: string, headers: Record<string, string> = {}, allowMissing = false): Promise<unknown> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (allowMissing && response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Metadata request failed with HTTP ${response.status}.`);
  return response.json();
}

function checkPackage(value: unknown, version: string): void {
  if (!object(value) || value.name !== packageName || value.version !== version) {
    throw new Error('Package name or version does not match the release tag.');
  }
}

export async function validateRelease(): Promise<{ tag: string; version: string; sha: string }> {
  const ref = environment('GITHUB_REF');
  if (environment('GITHUB_EVENT_NAME') !== 'workflow_dispatch' || !ref.startsWith('refs/tags/v')) {
    throw new Error('Publishing requires workflow_dispatch on a vX.Y.Z tag.');
  }
  const version = ref.slice('refs/tags/v'.length);
  releaseVersion(version);
  const tag = `v${version}`;
  const sha = environment('GITHUB_SHA');
  if (!/^[a-f0-9]{40}$/.test(sha) || environment('GITHUB_REPOSITORY') !== repository) {
    throw new Error('Unexpected release repository or commit SHA.');
  }
  const head = (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
  const tagged = (await exec('git', ['rev-parse', `${ref}^{commit}`])).stdout.trim();
  if (head !== sha || tagged !== sha) throw new Error('Checkout, tag, and workflow SHA must match.');
  await exec('git', ['merge-base', '--is-ancestor', sha, 'origin/main']);
  checkPackage(await jsonFile('package.json'), version);
  const manifest = await jsonFile('.release-please-manifest.json');
  if (!object(manifest) || manifest['.'] !== version)
    throw new Error('Release manifest version does not match the tag.');
  const api = (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '');
  const release = await requestJson(`${api}/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`, {
    authorization: `Bearer ${environment('GH_TOKEN')}`,
    accept: 'application/vnd.github+json',
  });
  if (!object(release) || release.tag_name !== tag || release.draft !== false || release.prerelease !== false) {
    throw new Error('The tag must have a published GitHub release (not a prerelease).');
  }
  return { tag, version, sha };
}

export function publicationDecision(metadata: unknown, version: string, integrity: string): boolean {
  releaseVersion(version);
  if (metadata === undefined) return true;
  if (!object(metadata) || !object(metadata.versions) || !object(metadata['dist-tags'])) {
    throw new Error('Registry returned invalid package metadata.');
  }
  const existing = metadata.versions[version];
  if (existing !== undefined) {
    checkPackage(existing, version);
    if (!object(existing) || !object(existing.dist) || existing.dist.integrity !== integrity) {
      throw new Error('Published version exists with different tarball integrity.');
    }
    return false;
  }
  const currentLatest = metadata['dist-tags'].latest;
  if (currentLatest !== undefined) {
    if (typeof currentLatest !== 'string') throw new Error('Registry returned an invalid latest tag.');
    if (compareReleaseToLatest(version, currentLatest) <= 0) {
      throw new Error(`Refusing to move latest backwards from ${currentLatest} to ${version}.`);
    }
  }
  return true;
}

async function checkArtifact(directory: string, version: string): Promise<{ tarball: string; publish: boolean }> {
  const names = (await readdir(directory)).filter((name) => name.endsWith('.tgz'));
  const name = names[0];
  if (names.length !== 1 || !name) throw new Error('Expected exactly one release tarball.');
  const tarball = resolve(directory, name);
  const { stdout } = await exec('tar', ['-xOzf', tarball, 'package/package.json'], { maxBuffer: 1024 * 1024 });
  const metadata: unknown = JSON.parse(stdout);
  checkPackage(metadata, version);
  const integrity = `sha512-${createHash('sha512')
    .update(await readFile(tarball))
    .digest('base64')}`;
  const registry = (process.env.RELEASE_REGISTRY_URL ?? 'https://registry.npmjs.org').replace(/\/$/, '');
  // Use npm's pre-write metadata read to avoid cached versions and dist-tags.
  const published = await requestJson(
    `${registry}/${encodeURIComponent(packageName)}?write=true`,
    { 'cache-control': 'no-cache' },
    true,
  );
  return { tarball, publish: publicationDecision(published, version, integrity) };
}

async function main(): Promise<void> {
  const [mode, directory, ...extra] = process.argv.slice(2);
  if (extra.length || (mode !== 'validate' && mode !== 'check') || (mode === 'validate' && directory)) {
    throw new Error('Usage: node scripts/release.ts validate | check [artifact-directory]');
  }
  const release = await validateRelease();
  const outputs: Record<string, string> = { version: release.version, sha: release.sha };
  if (mode === 'check') {
    const result = await checkArtifact(directory ?? 'artifacts', release.version);
    outputs.tarball = result.tarball;
    outputs.publish = String(result.publish);
    console.log(
      result.publish
        ? `Ready to publish ${packageName}@${release.version}.`
        : 'Identical package is already published; no tag changes are needed.',
    );
  } else {
    console.log(`Validated ${release.tag} at ${release.sha}.`);
  }
  const output = environment('GITHUB_OUTPUT');
  // Output files use one line per value; artifact names never become shell code.
  for (const value of Object.values(outputs)) {
    if (/[\r\n]/.test(value)) throw new Error('Release output contains a line break.');
  }
  await appendFile(
    output,
    Object.entries(outputs)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Release validation failed.');
    process.exitCode = 1;
  }
}

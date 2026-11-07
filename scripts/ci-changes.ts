import { execFile } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { compareReleaseToLatest } from './release.ts';

const exec = promisify(execFile);
const releaseFiles = ['.release-please-manifest.json', 'CHANGELOG.md', 'package.json'];
const releaseBot = 'hwwi-release-bot[bot]';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value) || /^0+$/.test(value)) {
    throw new Error('Missing comparison commit.');
  }
  return value;
}

function isReleasePullRequest(pull: unknown, repository: string): boolean {
  if (!object(pull) || !object(pull.user) || !object(pull.base) || !object(pull.head)) return false;
  if (pull.user.login !== releaseBot || pull.user.type !== 'Bot' || pull.base.ref !== 'main') return false;
  if (!object(pull.base.repo) || !object(pull.head.repo)) return false;
  return pull.base.repo.full_name === repository && pull.head.repo.full_name === repository &&
    typeof pull.head.ref === 'string' && pull.head.ref.startsWith('release-please--branches--main--components--');
}

async function isReleaseMerge(before: string, commit: string, repository: string): Promise<boolean> {
  const token = process.env.GH_TOKEN;
  const api = process.env.GITHUB_API_URL;
  if (!token || !api) return false;
  // A push that also brings earlier commits must use normal CI.
  const { stdout } = await exec('git', ['rev-parse', `${commit}^1`]);
  if (stdout.trim() !== before) return false;
  const response = await fetch(`${api}/repos/${repository}/commits/${commit}/pulls`, {
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('Could not look up the merged release PR.');
  const pulls: unknown = await response.json();
  return Array.isArray(pulls) && pulls.some((pull: unknown) =>
    object(pull) && typeof pull.merged_at === 'string' && pull.merge_commit_sha === commit &&
    isReleasePullRequest(pull, repository));
}

async function changesOnlyReleaseVersion(before: string, after: string): Promise<boolean> {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const read = async (commit: string, path: string) => {
    const { stdout } = await exec('git', ['show', `${commit}:${path}`], { encoding: 'buffer' });
    return decoder.decode(stdout);
  };
  const [previousPackage, nextPackage, manifest, changelog, fileChanges] = await Promise.all([
    read(before, 'package.json'), read(after, 'package.json'),
    read(after, '.release-please-manifest.json'), read(after, 'CHANGELOG.md'),
    exec('git', ['diff', '--summary', '--no-renames', before, after, '--']),
  ]);
  if (fileChanges.stdout !== '') return false;
  const previous: unknown = JSON.parse(previousPackage);
  const next: unknown = JSON.parse(nextPackage);
  const nextManifest: unknown = JSON.parse(manifest);
  if (!object(previous) || !object(next) || !object(nextManifest)) return false;
  const { version: previousVersion } = previous;
  const { version } = next;
  if (typeof version !== 'string' || typeof previousVersion !== 'string') return false;
  if (compareReleaseToLatest(version, previousVersion) <= 0) return false;
  // Preserve the rest of the manifest exactly. Node can distinguish spellings that JSON.parse normalizes.
  const versionPrefix = '\n  "version": ';
  const expectedPackage = previousPackage.replace(
    versionPrefix + JSON.stringify(previousVersion),
    versionPrefix + JSON.stringify(version),
  );
  return expectedPackage === nextPackage &&
    isDeepStrictEqual(nextManifest, { '.': version }) &&
    changelog.split('\n').find((line) => line.startsWith('## '))?.startsWith(`## [${version}]`) === true;
}

export async function shouldRunChecks(): Promise<boolean> {
  if (process.env.CI_FULL_CHECK === 'true') return true;
  const event = process.env.GITHUB_EVENT_NAME;
  if (event !== 'push' && event !== 'pull_request') return true;
  try {
    const payload: unknown = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH ?? '', 'utf8'));
    if (!object(payload)) throw new Error('Missing event payload.');
    const repository = process.env.GITHUB_REPOSITORY;
    let before: string;
    let after: string;
    let releasePull = false;
    if (event === 'pull_request') {
      const pr = payload.pull_request;
      if (!object(pr) || !object(pr.base) || !object(pr.head)) throw new Error('Missing PR comparison.');
      const base = sha(pr.base.sha);
      const head = sha(pr.head.sha);
      releasePull = repository !== undefined && isReleasePullRequest(pr, repository);
      if (releasePull) {
        // Compare the merge preview that CI would test against its exact base.
        after = sha(process.env.GITHUB_SHA);
        const { stdout } = await exec('git', ['show', '--no-patch', '--format=%P', after]);
        if (stdout.trim() !== `${base} ${head}`) return true;
        before = base;
      } else {
        after = head;
        before = sha((await exec('git', ['merge-base', base, head])).stdout.trim());
      }
    } else {
      before = sha(payload.before);
      after = sha(payload.after);
    }
    // Include both paths of renames and use NUL delimiters for arbitrary filenames.
    const { stdout } = await exec('git', ['diff', '--name-status', '--no-renames', '-z', before, after, '--'], {
      maxBuffer: 16 * 1024 * 1024, timeout: 15_000,
    });
    const entries = stdout.split('\0').slice(0, -1);
    const paths = entries.filter((_, index) => index % 2 === 1);
    if (paths.length === 0) return true;
    if (paths.every((path) => path === 'README.md' || path === 'AGENTS.md' || path.startsWith('docs/'))) {
      console.log('Only documentation changed; skipping tests.');
      return false;
    }
    if (!repository || paths.length !== releaseFiles.length ||
      !paths.every((path) => releaseFiles.includes(path)) ||
      !entries.every((entry, index) => index % 2 === 1 || entry === 'M')) return true;
    if (!await changesOnlyReleaseVersion(before, after)) return true;
    const verified = event === 'pull_request'
      ? releasePull
      : payload.ref === 'refs/heads/main' && payload.forced === false && await isReleaseMerge(before, after, repository);
    if (verified) console.log('Only release metadata changed; deferring full checks to the release tag.');
    return !verified;
  } catch {
    console.warn('Could not verify the changes; running all checks.');
    return true;
  }
}

async function main(): Promise<void> {
  const runTests = await shouldRunChecks();
  if (runTests) console.log('Running all checks.');
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required.');
  await appendFile(process.env.GITHUB_OUTPUT, `run-tests=${runTests}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) {
    console.error(error instanceof Error ? error.message : 'CI change detection failed.');
    process.exitCode = 1;
  }
}

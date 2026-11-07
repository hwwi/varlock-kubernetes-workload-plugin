import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

if (
  process.env.CI ||
  process.env.HUSKY === '0' ||
  process.env.npm_command === 'pack' ||
  process.env.npm_command === 'publish' ||
  process.env.NODE_ENV === 'production' ||
  process.env.npm_config_production === 'true' ||
  !existsSync('.git')
) {
  process.exit(0);
}

const hooksPath = spawnSync('git', ['config', '--get', 'core.hooksPath'], { encoding: 'utf8' });
if (hooksPath.status === 0 && hooksPath.stdout.trim() !== '.husky/_') {
  throw new Error(
    `Husky would replace core.hooksPath (${hooksPath.stdout.trim()}). Review that setting before installing.`,
  );
}
if (hooksPath.status !== 0 && hooksPath.status !== 1) {
  throw new Error(hooksPath.stderr?.trim() || hooksPath.error?.message || 'Could not read core.hooksPath.');
}

if (hooksPath.status === 1) {
  const directory = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { encoding: 'utf8' }).trim();
  const entries = existsSync(directory) ? readdirSync(directory) : [];
  const existingHook = entries.find((name) => {
    if (name.endsWith('.sample')) return false;
    const file = statSync(join(directory, name), { throwIfNoEntry: false });
    return file?.isFile() && (process.platform === 'win32' || (file.mode & 0o111) !== 0);
  });
  if (existingHook) {
    throw new Error(
      `Husky would disable the existing Git hook ${join(directory, existingHook)}. Review it before installing.`,
    );
  }
}

const { default: install } = await import('husky');
const error = install();
if (error) {
  throw new Error(error);
}

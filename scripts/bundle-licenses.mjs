import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const map = JSON.parse(await readFile('dist/plugin.cjs.map', 'utf8'));
const directories = new Set();
for (const source of map.sources) {
  const match = [...source.matchAll(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/g)].at(-1);
  if (match) directories.add(resolve('dist', source.slice(0, match.index + match[0].length)));
}
const notices = [];
for (const directory of [...directories].sort()) {
  const metadata = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
  const files = (await readdir(directory)).filter((file) => /^(license|copying|notice)([.\-_]|$)/i.test(file)).sort();
  const texts = await Promise.all(
    files.map(async (file) => `${file}\n\n${await readFile(resolve(directory, file), 'utf8')}`),
  );
  notices.push(
    `## ${metadata.name}@${metadata.version}\n\nLicense: ${metadata.license ?? 'See upstream package'}\n\n${texts.join('\n\n')}`,
  );
}
await writeFile('dist/BUNDLED_LICENSES.md', `# Bundled dependency notices\n\n${notices.join('\n\n---\n\n')}\n`);
process.stdout.write(`Bundled notices: ${notices.length} packages.\n`);

import { extractFile, listPackage, statFile } from '@electron/asar';
import { readFile, readdir } from 'node:fs/promises';
import { normalize } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const archive = process.argv[2] || `release/${version}/win-unpacked/resources/app.asar`,
  lite = process.argv.includes('--lite');
const expected = [];
async function walk(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = `${path}/${entry.name}`;
    assert.ok(!entry.isSymbolicLink(), `Unexpected link: ${file}`);
    if (lite && file === 'dist/models') continue;
    if (entry.isDirectory()) await walk(file);
    else if (entry.isFile() && !(lite && /^dist\/piper\/.*\.(wasm|data)$/.test(file)))
      expected.push(file);
  }
}
await walk('dist');
const actual = listPackage(archive)
  .map((p) => p.replaceAll('\\', '/').replace(/^\//, ''))
  .filter((p) => p.startsWith('dist/') && !statFile(archive, normalize(p)).files);
assert.deepEqual(
  actual.sort(),
  expected.sort(),
  'Packaged dist file set differs from the complete build',
);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
for (const file of expected)
  assert.equal(hash(extractFile(archive, normalize(file))), hash(await readFile(file)), file);
console.log(
  'Packaged dist files match completed build:',
  actual.length,
  '; exact file set and all SHA256; lite:',
  lite,
);

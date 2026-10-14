import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Data, NtExecutable, NtExecutableResource, Resource } from 'resedit';

export async function verifyExecutableIcon(file) {
  const expected = Data.IconFile.from(
    await readFile(new URL('../public/tixtab.ico', import.meta.url)),
  );
  const resource = NtExecutableResource.from(NtExecutable.from(await readFile(file)));
  // The app uses group 1; the NSIS portable launcher uses group 103.
  const [group] = Resource.IconGroupEntry.fromEntries(resource.entries).sort((a, b) =>
    String(a.id).localeCompare(String(b.id), 'en', { numeric: true }),
  );
  assert.ok(group, `${file}: application icon resource missing`);
  const actual = group.getIconItemsFromEntries(resource.entries);
  assert.equal(actual.length, expected.icons.length, `${file}: icon resolution count`);
  for (const { data } of expected.icons) {
    // ICO directory bytes encode a 256px dimension as zero.
    const match = actual.find(
      (item) => (item.width || 256) === data.width && (item.height || 256) === data.height,
    );
    assert.ok(match?.isRaw(), `${file}: PNG icon ${data.width}px missing`);
    assert.deepEqual(
      Buffer.from(match.bin),
      Buffer.from(data.bin),
      `${file}: wrong ${data.width}px icon`,
    );
  }
  console.log(`${file}: all seven Windows icon resolutions match the supplied design`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await import('./prepare-icons.mjs');
  for (const file of process.argv.slice(2).filter((arg) => arg !== '--check'))
    await verifyExecutableIcon(file);
}

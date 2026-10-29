const path = require('node:path');
const { createModelLibrary } = require('../electron/model-library.cjs');
const catalog = require('../electron/model-catalog.json');
// Same constructor as Electron startup; no download or filesystem mutation.
const library = createModelLibrary({
  root: path.resolve('.cache/model-catalog-check'),
  bundled: path.resolve('public/models'),
  catalog,
  fetch: () => {
    throw Error('Catalog validation must not download');
  },
});
library.dispose();
for (const model of catalog.models) {
  if (model.bytes !== model.files.reduce((n, f) => n + f.bytes, 0))
    throw Error(`Invalid asset byte total: ${model.id}`);
}
console.log(`Model catalog: ${catalog.models.length} records validated with the desktop loader.`);

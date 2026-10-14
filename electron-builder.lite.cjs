const { build, version } = require('./package.json');
module.exports = {
  ...build,
  extends: null,
  files: [...build.files, '!dist/models/**/*', '!dist/piper/**/*.wasm', '!dist/piper/**/*.data'],
  artifactName: 'TixTab-${version}-lite-setup-${arch}.${ext}',
  portable: { ...build.portable, artifactName: 'TixTab-${version}-lite-portable-${arch}.${ext}' },
  directories: { output: `release/${version}/lite` },
};

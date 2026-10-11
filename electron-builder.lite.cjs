const { build, version } = require('./package.json');
module.exports = {
  ...build,
  extends: null,
  files: [...build.files, '!dist/models/**/*', '!dist/piper/**/*.wasm', '!dist/piper/**/*.data'],
  artifactName: 'TixTab-${version}-lite-${arch}.${ext}',
  directories: { output: `release/${version}/lite` },
};

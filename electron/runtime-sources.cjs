const defaults = { packages: 'auto', python: 'auto', customIndex: '' };
function validateSources(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    !['auto', 'pypi', 'tuna', 'ustc', 'custom'].includes(value.packages) ||
    !['auto', 'github', 'npmmirror'].includes(value.python) ||
    typeof value.customIndex !== 'string'
  )
    throw Error('invalid-source');
  let customIndex = value.customIndex.trim();
  if (customIndex) {
    if (customIndex.length > 2048) throw Error('invalid-source');
    let url;
    try {
      url = new URL(customIndex);
    } catch {
      throw Error('invalid-source');
    }
    if (
      url.protocol !== 'https:' ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw Error('invalid-source');
    customIndex = url.href;
  }
  if (value.packages === 'custom' && !customIndex) throw Error('invalid-source');
  return { packages: value.packages, python: value.python, customIndex };
}
module.exports = { defaults, validateSources };

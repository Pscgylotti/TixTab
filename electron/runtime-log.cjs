const fs = require('node:fs/promises');
const path = require('node:path');
function redactRuntimeLog(value) {
  return String(value)
    .replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
      try {
        const url = new URL(raw);
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        return url.href;
      } catch {
        return '[URL]';
      }
    })
    .replace(/authorization\s*[:=]\s*(?:bearer|basic)\s+[^\s,;]+/gi, 'Authorization: [redacted]')
    .replace(
      /(authorization\s*[:=]\s*|bearer\s+|(?:password|token|api[_-]?key|secret)\s*[:=]\s*)[^\s,;]+/gi,
      '$1[redacted]',
    )
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .slice(0, 2000);
}
function runtimeLog(root, id) {
  const file = path.join(root, `runtime-install-${id}.log`);
  let text = '',
    updatedAt = 0,
    timer = null,
    writes = Promise.resolve();
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    const content = text;
    if (!content) return writes;
    writes = writes
      .catch(() => {})
      .then(() => fs.writeFile(file, content, 'utf8'))
      .catch(() => {});
    return writes;
  };
  return {
    append(line) {
      updatedAt = Date.now();
      text = (text + new Date(updatedAt).toISOString() + ' ' + redactRuntimeLog(line) + '\n').slice(
        -64000,
      );
      if (!timer) timer = setTimeout(flush, 500);
    },
    snapshot() {
      return { logs: text, updatedAt };
    },
    flush,
  };
}
module.exports = { runtimeLog, redactRuntimeLog };

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createDocumentOpenQueue } = require('../electron/document-open.cjs');

test('launch requests queue before the window is ready, filter flags and URLs and only read dequeued paths', async () => {
  const reads = [],
    notifications = [];
  const q = createDocumentOpenQueue({
    notify: () => notifications.push(1),
    stat: async () => ({ isFile: () => true, size: 4 }),
    readFile: async (file) => {
      reads.push(file);
      return Buffer.from('%PDF');
    },
  });
  q.enqueue([
    '--flag.pdf',
    'https://example.com/a.pdf',
    'secret.txt',
    'a.pdf',
    'A.PDF',
    'b.tixtab',
  ]);
  assert.equal(reads.length, 0);
  assert.equal((await q.next()).name, 'a.pdf');
  q.enqueue(['c.pdf']);
  assert.equal((await q.next()).name, 'b.tixtab');
  assert.equal((await q.next()).name, 'c.pdf');
  assert.equal(await q.next(), null);
  assert.deepEqual(
    reads,
    ['a.pdf', 'b.tixtab', 'c.pdf'].map((p) => path.resolve(p)),
  );
  assert.equal(notifications.length, 2);
});
test('read failures do not block later requests and directories or oversized files are never read', async () => {
  let read = 0;
  const q = createDocumentOpenQueue({
    stat: async (p) => {
      if (p.endsWith('missing.pdf')) throw Object.assign(Error('missing'), { code: 'ENOENT' });
      return { isFile: () => !p.endsWith('dir.pdf'), size: p.endsWith('large.pdf') ? 2 ** 31 : 8 };
    },
    readFile: async () => {
      read++;
      return Buffer.from('%PDF');
    },
  });
  q.enqueue(['missing.pdf', 'dir.pdf', 'large.pdf', 'ok.pdf']);
  assert.equal((await q.next()).error, 'ENOENT');
  assert.equal((await q.next()).error, 'invalid-file');
  assert.equal((await q.next()).error, 'invalid-file');
  assert.equal((await q.next()).bytes.length, 4);
  assert.equal(read, 1);
});

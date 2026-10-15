import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import sharp from 'sharp';
const root = resolve('.cache/native-ocr'),
  executable = resolve(root, 'npu-runtime/tixtab-ocr-npu.exe');
const png = await sharp(
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="240"><rect width="600" height="240" fill="white"/><g font-family="Arial" font-size="44" fill="black"><text x="35" y="80">Native OCR</text><text x="35" y="170">Hello world</text></g></svg>',
  ),
)
  .png()
  .toBuffer();
const report = [];
for (const variant of ['fast', 'best']) {
  const cache = resolve(root, 'npu-cache', variant);
  await mkdir(cache, { recursive: true });
  const child = spawn(executable, [resolve(root, 'npu-models', variant), cache], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let buffer = '',
    waiting;
  const finish = new Promise((resolve) => child.once('close', resolve));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const value = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      waiting?.resolve(value);
    }
  });
  child.on('error', (error) => waiting?.reject(error));
  child.on('exit', () => waiting?.reject(Error('Native NPU exited')));
  const next = () =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(Error('Native NPU timed out'));
      }, 180000);
      waiting = {
        resolve: (value) => {
          clearTimeout(timer);
          waiting = null;
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          waiting = null;
          reject(error);
        },
      };
    });
  try {
    assert.equal((await next()).ready, true);
    for (let index = 0; index < 2; index++) {
      const response = next(),
        header = Buffer.alloc(4);
      header.writeUInt32LE(png.length);
      child.stdin.write(header);
      child.stdin.write(png);
      const result = await response;
      assert.equal(result.ok, true, result.error);
      assert.equal(result.device, 'NPU');
      assert.match(result.executionDevices, /NPU/);
      assert.equal(result.lines.length, 2);
      assert.ok(result.text.trim());
      if (index) assert.equal(result.timing.compileMs, 0);
      const row = {
        variant,
        index,
        text: result.text,
        loadedFromCache: result.loadedFromCache,
        executionDevices: result.executionDevices,
        timing: result.timing,
      };
      report.push(row);
      console.log(JSON.stringify(row));
    }
  } finally {
    child.kill();
    await finish;
  }
}
await writeFile(
  resolve(root, 'npu-verification.json'),
  JSON.stringify({ synthetic: true, batch: 1, width: 384, results: report }, null, 2) + '\n',
);

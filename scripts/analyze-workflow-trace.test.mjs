import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('keeps main-thread samples separate from workers and identifies DevTools payloads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tixtab-trace-analysis-'));
  const trace = join(directory, 'trace.json'),
    output = join(directory, 'analysis.json');
  const profile = (id, tid, name) => [
    { name: 'Profile', ph: 'P', pid: 7, tid, id, ts: 0, args: { data: { startTime: 0 } } },
    {
      name: 'ProfileChunk',
      ph: 'P',
      pid: 7,
      tid: 999,
      id,
      ts: 21,
      args: {
        data: {
          cpuProfile: {
            nodes: [
              { id: 1, callFrame: { functionName: '(root)' } },
              { id: 2, parent: 1, callFrame: { functionName: name } },
            ],
            samples: [2, 2],
          },
          timeDeltas: [10, 10],
        },
      },
    },
  ];
  await writeFile(
    trace,
    JSON.stringify({
      traceEvents: [
        { name: 'workflow:import-mixed-document:start', ph: 'I', pid: 7, tid: 10, ts: 8 },
        { name: 'workflow:import-mixed-document:end', ph: 'I', pid: 7, tid: 10, ts: 25 },
        { name: 'RunTask', ph: 'X', pid: 7, tid: 10, ts: 10, dur: 14 },
        {
          name: 'Receive mojo message',
          ph: 'X',
          pid: 7,
          tid: 10,
          ts: 10,
          dur: 13,
          args: {
            chrome_mojo_event_info: {
              mojo_interface_tag: 'blink.mojom.DevToolsSession',
              payload_size: 1048576,
            },
          },
        },
        ...profile('0x1', 10, 'main-function'),
        ...profile('0x2', 11, 'worker-function'),
      ],
    }),
  );
  execFileSync(process.execPath, [
    'scripts/analyze-workflow-trace.mjs',
    '--trace',
    trace,
    '--output',
    output,
  ]);
  const result = JSON.parse(await readFile(output));
  assert.equal(result.samples, 2);
  assert.equal(result.roots.length, 1);
  assert.deepEqual(
    result.hot.map((h) => h.frame.functionName),
    ['main-function'],
  );
  assert.equal(result.rootHot[0].hot[0].count, 2);
  assert.deepEqual(result.devtoolsMessages, {
    count: 1,
    maxPayloadBytes: 1048576,
    maxWallMs: 0.013,
  });
});

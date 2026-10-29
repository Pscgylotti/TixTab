const { parentPort } = require('node:worker_threads');
const { createMidiNative } = require('./music-midi-native.cjs');
const { createMidiTransport } = require('./music-midi-transport.cjs');
const transport = createMidiTransport(createMidiNative(), (event) =>
  parentPort.postMessage({ event }),
);
parentPort.on('message', ({ id, request }) => {
  if (request.action === 'dispose') {
    transport.dispose();
    parentPort.postMessage({ id, result: { ok: true } });
    parentPort.close();
    return;
  }
  parentPort.postMessage({ id, result: transport.run(request) });
});
parentPort.on('close', () => transport.dispose());

import { _electron as electron } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyNativeTexo } from './verify-native-ui.mjs';
const profile = await mkdtemp(join(tmpdir(), 'surfacetab-native-'));
const executablePath = process.env.SURFACETAB_EXECUTABLE;
const app = await electron.launch({
  ...(executablePath ? { executablePath, args: [] } : { args: ['.'] }),
  env: { ...process.env, SURFACETAB_DEV: '0', SURFACETAB_PROFILE: profile },
  timeout: 60000,
});
try {
  await verifyNativeTexo(await app.firstWindow());
} finally {
  await app.close();
}

import { execFile as execFileCallback, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtemp,
  mkdir,
  copyFile,
  writeFile,
  readFile,
  unlink,
  readdir,
  access,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

// This integration check executes installers. Keep it out of unattended runs
// after the development host experienced freezes and injected-module Git crashes.
if (!process.argv.includes('--run-fixture')) {
  console.error(
    'Installer execution is opt-in: --run-fixture. Do not retry on a host with unresolved freezes.',
  );
  process.exit(2);
}
function windhawkValue(name) {
  try {
    return execFileSync(
      'reg.exe',
      [
        'query',
        'HKLM\\SOFTWARE\\Windhawk\\Engine\\Mods\\explorer-details-better-file-sizes',
        '/v',
        name,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] },
    )
      .match(new RegExp(`${name}\\s+REG_\\w+\\s+([^\\r\\n]+)`))?.[1]
      ?.trim();
  } catch {
    return undefined;
  }
}
if (
  windhawkValue('Disabled') === '0x0' &&
  windhawkValue('Include') === '*' &&
  !`${windhawkValue('Exclude') ?? ''}|${windhawkValue('ExcludeCustom') ?? ''}`
    .split('|')
    .some((name) => name.toLowerCase() === 'git.exe')
) {
  throw new Error(
    'Installer test blocked: the globally injected Windhawk Better file sizes module is not excluding git.exe. This host logged repeated Git crashes in that module. Resolve the conflict before running installers; this script does not change system settings.',
  );
}

const execFile = promisify(execFileCallback),
  fixture = await mkdtemp(resolve('.cache/nsis-upgrade-')),
  payload = join(fixture, 'payload'),
  guid = randomUUID(),
  chosenParent = join(fixture, 'TixTab Projects', 'Test Install'),
  installation = join(chosenParent, 'TixTab'),
  shortcutName = `TixTab Upgrade Fixture ${guid}`,
  registry = `HKCU\\Software\\${guid}`,
  uninstallRegistry = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}`;
await mkdir(payload);
await mkdir(join(payload, 'resources'));
// A small real PE is sufficient to exercise NSIS file replacement and registry
// behavior. It is never launched; the full packaged app is checked separately.
await copyFile(
  join(process.env.SystemRoot, 'System32', 'where.exe'),
  join(payload, 'TixTabUpgradeFixture.exe'),
);
await writeFile(join(fixture, 'workspace-preservation.txt'), 'workspace and model placeholder');
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const desktop = execFileSync(
  'powershell.exe',
  ['-NoProfile', '-Command', '[Environment]::GetFolderPath("Desktop")'],
  { encoding: 'utf8', windowsHide: true },
).trim();
const shortcut = join(desktop, `${shortcutName}.lnk`);
const missing = async (file) =>
  access(file).then(
    () => false,
    () => true,
  );
assert.ok(await missing(shortcut), 'Fixture shortcut name must be unused');
const installers = [];
for (const version of ['0.2.37', '0.2.38']) {
  await writeFile(join(payload, 'payload-version.txt'), version);
  if (version === '0.2.37') await writeFile(join(payload, 'old-only.txt'), 'old payload');
  else await unlink(join(payload, 'old-only.txt'));
  const config = {
    extends: null,
    appId: `local.tixtab.upgradecheck.${guid}`,
    productName: 'TixTab Upgrade Fixture',
    executableName: 'TixTabUpgradeFixture',
    extraMetadata: { version },
    directories: { output: join(fixture, version) },
    artifactName: `fixture-${version}.exe`,
    win: { target: ['nsis'], signExecutable: false, icon: resolve('public/tixtab.ico') },
    nsis: {
      ...pkg.build.nsis,
      guid,
      include: resolve(pkg.build.nsis.include),
      installerIcon: resolve('public/tixtab.ico'),
      uninstallerIcon: resolve('public/tixtab.ico'),
      shortcutName,
      createDesktopShortcut: true,
      createStartMenuShortcut: false,
    },
  };
  const file = join(fixture, `config-${version}.json`);
  await writeFile(file, JSON.stringify(config, null, 2));
  await execFile(
    process.execPath,
    [
      'node_modules/electron-builder/cli.js',
      '--prepackaged',
      payload,
      '--config',
      file,
      '--win',
      'nsis',
      '--x64',
      '--publish',
      'never',
    ],
    {
      windowsHide: true,
      maxBuffer: 8_000_000,
      timeout: 180000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    },
  );
  installers.push(join(fixture, version, `fixture-${version}.exe`));
}
function value(key, name) {
  try {
    const raw = execFileSync('reg.exe', ['query', key, '/v', name], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return raw.match(new RegExp(`${name}\\s+REG_SZ\\s+([^\\r\\n]+)`))?.[1];
  } catch {
    return undefined;
  }
}
const run = (exe, args) =>
  execFile(exe, args, { windowsHide: true, windowsVerbatimArguments: true, timeout: 60000 });
let installed = false;
let activeInstallation = installation;
async function uninstallFixture() {
  const uninstaller = (await readdir(activeInstallation)).find((name) =>
    /^uninstall.*\.exe$/i.test(name),
  );
  assert.ok(uninstaller, 'Fixture uninstaller is missing');
  await run(join(activeInstallation, uninstaller), ['/S', '/currentuser']);
  for (let attempt = 0; attempt < 60 && value(registry, 'InstallLocation'); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(value(registry, 'InstallLocation'), undefined, 'Fixture registry cleanup failed');
  installed = false;
}
try {
  await run(installers[0], ['/S', '/currentuser', `/D=${chosenParent}\\`]);
  installed = true;
  assert.equal(value(registry, 'InstallLocation'), installation);
  assert.equal(value(uninstallRegistry, 'DisplayVersion'), '0.2.37');
  assert.equal(await readFile(join(installation, 'payload-version.txt'), 'utf8'), '0.2.37');
  assert.ok(await missing(shortcut), 'Silent install must not create a desktop shortcut');
  // Do not provide /D for upgrade: the installed directory must be reused.
  await run(installers[1], ['/S', '/currentuser']);
  assert.equal(value(registry, 'InstallLocation'), installation);
  assert.equal(value(uninstallRegistry, 'DisplayVersion'), '0.2.38');
  assert.ok(await missing(join(installation, 'TixTab')), 'Repair must not duplicate TixTab folder');
  assert.ok(await missing(shortcut), 'Upgrade must not create a desktop shortcut');
  assert.equal(await readFile(join(installation, 'payload-version.txt'), 'utf8'), '0.2.38');
  assert.equal((await readdir(installation)).includes('old-only.txt'), false);
  await run(installers[1], ['/S', '/currentuser']);
  assert.equal(value(uninstallRegistry, 'DisplayVersion'), '0.2.38');
  let downgradeExit;
  try {
    await run(installers[0], ['/S', '/currentuser']);
  } catch (error) {
    downgradeExit = error.code;
  }
  assert.equal(downgradeExit, 1638);
  assert.equal(value(uninstallRegistry, 'DisplayVersion'), '0.2.38');
  assert.equal(
    await readFile(join(fixture, 'workspace-preservation.txt'), 'utf8'),
    'workspace and model placeholder',
  );
  await uninstallFixture();
  // Case-insensitive final-component check, including a trailing separator.
  activeInstallation = join(fixture, 'Already Named', 'tixtab');
  await run(installers[1], ['/S', '/currentuser', `/D=${activeInstallation}\\`]);
  installed = true;
  assert.equal(value(registry, 'InstallLocation'), activeInstallation);
  assert.ok(await missing(join(activeInstallation, 'TixTab')));
  assert.ok(await missing(shortcut));
  console.log(
    JSON.stringify(
      {
        fixture,
        guid,
        firstInstall: true,
        upgrade: true,
        existingDirectoryReused: true,
        customParentReceivesTixTabFolder: true,
        finalComponentCaseInsensitive: true,
        trailingSeparatorHandled: true,
        noDuplicateApplicationFolder: true,
        desktopShortcutDeferred: true,
        sameVersionRepair: true,
        downgradeExit,
        preservedExternalData: true,
        scope:
          'Isolated NSIS fixture using the production hook; silent path/upgrade behavior checked. Finish-page checkbox compiled in both languages; interactive selection not automated.',
      },
      null,
      2,
    ),
  );
} finally {
  if (installed) {
    await uninstallFixture();
    console.log(
      'Isolated test installation removed; application profile and real installation were not used.',
    );
  }
  // Only this run's unique fixture shortcut is eligible for cleanup.
  if (!(await missing(shortcut))) await unlink(shortcut);
}

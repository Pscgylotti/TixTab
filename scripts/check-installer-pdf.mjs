// Compile both installer include paths; never execute the generated installers.
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const cache = join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache');
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Invalid installer version');
const findDirectory = async (prefix) => {
  const parent = (await readdir(cache)).find((name) => name.startsWith(prefix));
  if (!parent) throw Error(`Missing cached NSIS tools: ${prefix}`);
  const children = await readdir(join(cache, parent), { withFileTypes: true });
  return join(cache, parent, children.find((entry) => entry.isDirectory()).name);
};
const nsis = await findDirectory('nsis-3.'),
  resources = await findDirectory('nsis-resources-');
const folder = await mkdtemp(resolve('.cache/nsis-pdf-compile-'));
for (const uninstall of [false, true]) {
  const name = uninstall ? 'uninstaller' : 'installer';
  const source = String.raw`
Unicode true
RequestExecutionLevel user
Name "TixTab association compile check"
OutFile "${join(folder, name + '.exe')}"
!addplugindir "${join(resources, 'plugins/x86-unicode')}"
!include MUI2.nsh
!include FileFunc.nsh
!define VERSION "${version}"
!define APP_EXECUTABLE_FILENAME "TixTab.exe"
!define APP_ID "local.tixtab.compilecheck"
!define APP_DESCRIPTION "Compile only"
!define INSTALL_REGISTRY_KEY "Software\TixTabCompileCheck"
!define UNINSTALL_REGISTRY_KEY "Software\TixTabCompileCheck\Uninstall"
${
  uninstall
    ? ''
    : String.raw`
Var installMode
Var newDesktopLink
Var appExe
Var launchLink
!include "${resolve('node_modules/app-builder-lib/templates/nsis/include/StdUtils.nsh')}"
`
}
!macro _isUpdated _a _b _t _f
  StrCmp "false" "true" "${'${_t}'}" "${'${_f}'}"
!macroend
!define isUpdated '"" isUpdated ""'
${uninstall ? '!define BUILD_UNINSTALLER' : ''}
!include "${resolve('electron/installer-upgrade.nsh')}"
${
  uninstall
    ? String.raw`
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
Section "Uninstall"
!insertmacro customUnInstall
SectionEnd
Section
WriteUninstaller "$TEMP\TixTab-compile-check-uninstaller.exe"
SectionEnd
`
    : String.raw`
!insertmacro customHeader
!define MUI_PAGE_CUSTOMFUNCTION_PRE instFilesPre
!insertmacro customPageAfterChangeDir
!insertmacro MUI_PAGE_INSTFILES
!insertmacro customFinishPage
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"
Function instFilesPre
FunctionEnd
Function .onInit
StrCpy $installMode "CurrentUser"
StrCpy $appExe "$INSTDIR\TixTab.exe"
StrCpy $newDesktopLink "$DESKTOP\TixTab.lnk"
StrCpy $launchLink "$newDesktopLink"
!insertmacro customInit
FunctionEnd
Section
!insertmacro customInstall
SectionEnd
`
}
`;
  const file = join(folder, name + '.nsi');
  await writeFile(file, source);
  execFileSync(join(nsis, 'makensis.exe'), ['/V2', file], { stdio: 'inherit', windowsHide: true });
  console.log(`${name} include compiled (not executed)`);
}

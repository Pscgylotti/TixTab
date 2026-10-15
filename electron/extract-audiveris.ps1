param([Parameter(Mandatory=$true)][string]$Archive, [Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
# Read MSI tables and cabinet bytes only. Never execute installation actions,
# register the package, change Program Files or launch msiexec.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
public static class TixtabMsiReader {
  [DllImport("msi.dll", CharSet=CharSet.Unicode)] static extern uint MsiOpenDatabase(string file, IntPtr mode, out uint db);
  [DllImport("msi.dll", CharSet=CharSet.Unicode)] static extern uint MsiDatabaseOpenView(uint db,string query,out uint view);
  [DllImport("msi.dll")] static extern uint MsiViewExecute(uint view,uint record);
  [DllImport("msi.dll")] static extern uint MsiViewFetch(uint view,out uint record);
  [DllImport("msi.dll", CharSet=CharSet.Unicode)] static extern uint MsiRecordGetString(uint record,uint field,StringBuilder value,ref uint size);
  [DllImport("msi.dll")] static extern uint MsiRecordReadStream(uint record,uint field,byte[] data,ref uint count);
  [DllImport("msi.dll")] public static extern uint MsiCloseHandle(uint handle);
  static void Check(uint code) { if(code!=0) throw new IOException("MSI read error "+code); }
  public static uint Open(string file) { uint db;Check(MsiOpenDatabase(file,IntPtr.Zero,out db));return db; }
  public static string[][] Rows(uint db,string query,int fields) {
    uint view=0,record=0;var rows=new List<string[]>();
    try { Check(MsiDatabaseOpenView(db,query,out view));Check(MsiViewExecute(view,0));
      for(;;) { var code=MsiViewFetch(view,out record);if(code==259)break;Check(code);
        try { var row=new string[fields];for(uint i=1;i<=fields;i++){uint n=4095;var text=new StringBuilder(4096);Check(MsiRecordGetString(record,i,text,ref n));row[i-1]=text.ToString();}rows.Add(row); }
        finally {MsiCloseHandle(record);record=0;}
      }return rows.ToArray();
    } finally {if(record!=0)MsiCloseHandle(record);if(view!=0)MsiCloseHandle(view);}
  }
  public static void Cabinet(uint db,string name,string output) {
    if(name.Contains("'"))throw new IOException("Invalid cabinet");uint view=0,record=0;
    try {Check(MsiDatabaseOpenView(db,"SELECT `Data` FROM `_Streams` WHERE `Name`='"+name+"'",out view));Check(MsiViewExecute(view,0));Check(MsiViewFetch(view,out record));
      using(var file=new FileStream(output,FileMode.CreateNew)) {var buffer=new byte[1048576];long total=0;
        for(;;){uint count=(uint)buffer.Length;Check(MsiRecordReadStream(record,1,buffer,ref count));if(count==0)break;total+=count;if(total>134217728)throw new IOException("Cabinet limit");file.Write(buffer,0,(int)count);}
      }
    }finally{if(record!=0)MsiCloseHandle(record);if(view!=0)MsiCloseHandle(view);}
  }
}
'@
$root = [IO.Path]::GetFullPath($Destination)
New-Item -ItemType Directory -Path $root -Force | Out-Null
$flat = Join-Path $root '.cab-files'
New-Item -ItemType Directory -Path $flat | Out-Null
$db = [TixtabMsiReader]::Open([IO.Path]::GetFullPath($Archive))
try {
  $directories = @{}
  foreach ($row in [TixtabMsiReader]::Rows($db, 'SELECT `Directory`,`Directory_Parent`,`DefaultDir` FROM `Directory`', 3)) { $directories[$row[0]] = $row }
  $components = @{}
  foreach ($row in [TixtabMsiReader]::Rows($db, 'SELECT `Component`,`Directory_` FROM `Component`', 2)) { $components[$row[0]] = $row[1] }
  $files = [TixtabMsiReader]::Rows($db, 'SELECT `File`,`Component_`,`FileName`,`FileSize` FROM `File`', 4)
  if ($files.Length -gt 15000) { throw 'File limit' }
  $cabIndex = 0
  foreach ($row in [TixtabMsiReader]::Rows($db, 'SELECT `Cabinet` FROM `Media`', 1)) {
    if (!$row[0].StartsWith('#')) { throw 'External cabinet not supported' }
    $cab = Join-Path $root ('.cab-' + $cabIndex++ + '.cab')
    [TixtabMsiReader]::Cabinet($db, $row[0].Substring(1), $cab)
    & "$env:SystemRoot/System32/expand.exe" '-F:*' $cab $flat | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Cabinet extraction failed' }
    Remove-Item -LiteralPath $cab
  }
  foreach ($file in $files) {
    $parts = [Collections.Generic.List[string]]::new()
    $id = $components[$file[1]]
    $depth = 0
    while ($id -and $directories.ContainsKey($id)) {
      if (++$depth -gt 64) { throw 'Directory nesting limit' }
      $dir = $directories[$id]
      $name = ($dir[2].Split(':')[0].Split('|') | Select-Object -Last 1)
      if ($name -and $name -notin @('.', 'SourceDir')) { $parts.Insert(0, $name) }
      $id = $dir[1]
    }
    $parts.Add(($file[2].Split('|') | Select-Object -Last 1))
    $target = $root
    foreach ($part in $parts) {
      if ($part -in @('.', '..') -or $part.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0) { throw 'Invalid path' }
      $target = Join-Path $target $part
    }
    $target = [IO.Path]::GetFullPath($target)
    if (!$target.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Path outside destination' }
    $source = Join-Path $flat $file[0]
    if ((Get-Item -LiteralPath $source).Length -ne [long]$file[3]) { throw 'File size mismatch' }
    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($target)) -Force | Out-Null
    Move-Item -LiteralPath $source -Destination $target
  }
} finally { [TixtabMsiReader]::MsiCloseHandle($db) | Out-Null }
# The flat directory must now be empty; no recursive deletion is needed.
[IO.Directory]::Delete($flat, $false)

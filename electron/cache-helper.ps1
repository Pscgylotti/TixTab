param([ValidateSet('list','clear')][string]$Action='list',[string]$Id='', [string]$Token='')
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$taskLimit=10000
function Assert-PlainPath([string]$path) {
    $current=[IO.Path]::GetFullPath($path)
    while ($current) {
        if ([IO.File]::Exists($current) -or [IO.Directory]::Exists($current)) {
            if ([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint) { throw 'unsafe' }
        }
        $parent=[IO.Path]::GetDirectoryName($current)
        if ($parent -eq $current) { break }; $current=$parent
    }
}
function Inventory($item,[string]$base) {
    $root=[IO.Path]::GetFullPath((Join-Path $base $item.path)); Assert-PlainPath $root
    if (-not $root.StartsWith($base+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'unsafe' }
    $pending=[Collections.Generic.Stack[string]]::new(); $files=[Collections.Generic.List[object]]::new();$preserved=0;$links=0;$visited=0
    if ([IO.Directory]::Exists($root)) { $pending.Push($root) }
    while ($pending.Count) {
        foreach ($entry in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
            $visited++;if ($visited -gt $taskLimit) { throw 'limited' }
            if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { $links++;continue }
            if ($entry.PSIsContainer) { $pending.Push($entry.FullName);continue }
            $relative=$entry.FullName.Substring($root.Length+1).Replace('\','/')
            if ($relative -cmatch $item.pattern) { $files.Add([pscustomobject]@{path=$entry.FullName;relative=$relative;bytes=[long]$entry.Length;modified=$entry.LastWriteTimeUtc.Ticks}) }
            else { $preserved++ }
        }
    }
    $ordered=@($files | Sort-Object relative)
    $signature=($ordered | ForEach-Object { $_.relative+'|'+$_.bytes+'|'+$_.modified }) -join "`n"
    $hash=[Security.Cryptography.SHA256]::Create()
    try { $token=([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($signature)))).Replace('-','').ToLowerInvariant() }finally{$hash.Dispose()}
    $total=[long]0;foreach($file in $ordered){$total+=$file.bytes}
    return @{root=$root;files=$ordered;row=@{id=$item.id;bytes=$total;files=$ordered.Count;preserved=$preserved;links=$links;token=$token}}
}
$lease=$null
try {
    if (-not $env:LOCALAPPDATA) { throw 'unavailable' }
    $taskBase=[IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'SurfaceTab'));Assert-PlainPath $taskBase
    $catalog=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'cache-catalog.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if($Action -eq 'list') {
        $rows=@(foreach($item in $catalog.items) {try{(Inventory $item $taskBase).row}catch{@{id=$item.id;error=$_.Exception.Message}}})
        @{ok=$true;rows=$rows}|ConvertTo-Json -Depth 6 -Compress
    } else {
        $item=@($catalog.items | Where-Object { $_.id -ceq $Id })
        if($item.Count -ne 1 -or $Token -cnotmatch '^[a-f0-9]{64}$') { throw 'invalid' }
        [IO.Directory]::CreateDirectory($taskBase)|Out-Null
        $lockPath=Join-Path $taskBase 'native-cache-use.lock';Assert-PlainPath $lockPath
        try { $lease=[IO.FileStream]::new($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) }catch [IO.IOException]{throw 'busy'}
        $inventory=Inventory $item[0] $taskBase
        if($inventory.row.links) { throw 'unsafe' }
        if($inventory.row.token -cne $Token) { throw 'changed' }
        $deleted=0;$bytes=[long]0;$failed=0
        foreach($file in $inventory.files) {
            try {
                Assert-PlainPath $file.path
                if (-not $file.path.StartsWith($inventory.root+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'unsafe' }
                $current=Get-Item -LiteralPath $file.path -Force
                if($current.Length -ne $file.bytes -or $current.LastWriteTimeUtc.Ticks -ne $file.modified){throw 'changed'}
                # Only reviewed, recognized files in fixed private cache roots.
                # OpenVINO marks compiled blobs read-only on Windows.
                if($current.IsReadOnly){$current.IsReadOnly=$false}
                [IO.File]::Delete($file.path);$deleted++;$bytes+=$file.bytes
            }catch{$failed++}
        }
        @{ok=($failed -eq 0);error=$(if($failed){'partial'}else{$null});filesDeleted=$deleted;bytesDeleted=$bytes;failed=$failed;preserved=$inventory.row.preserved}|ConvertTo-Json -Compress
    }
}catch {
    $code=$_.Exception.Message
    if($code -notin @('unsafe','limited','unavailable','busy','invalid','changed')){$code='failed'}
    @{ok=$false;error=$code}|ConvertTo-Json -Compress
}finally{if($lease){$lease.Dispose()}}

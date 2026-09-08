$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'Windows x64 is required.' }
$version = 'v24.20.0'
$archive = "node-$version-win-x64.zip"
$expected = '6cac9ffbca8f6a47091e4b5c772e0606049c3871cb67d900c0cedde630e545ba'
$cache = 'src-tauri/target/node-download'
New-Item -ItemType Directory -Force $cache, 'src-tauri/runtime' | Out-Null
$zip = Join-Path $cache $archive
if (-not (Test-Path $zip)) {
    Invoke-WebRequest "https://nodejs.org/dist/$version/$archive" -OutFile "$zip.part"
    Move-Item "$zip.part" $zip
}
if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Node SHA-256 mismatch. Remove the downloaded archive and retry.' }
Expand-Archive -Path $zip -DestinationPath $cache -Force
Copy-Item "$cache/node-$version-win-x64/node.exe" 'src-tauri/runtime/node.exe' -Force
Copy-Item "$cache/node-$version-win-x64/LICENSE" 'src-tauri/runtime/LICENSE' -Force
Set-Content 'src-tauri/runtime/VERSION' $version
Write-Host "Bundled Node $version win-x64; SHA-256 verified."

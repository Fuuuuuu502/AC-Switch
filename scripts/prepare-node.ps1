$ErrorActionPreference = 'Stop'
# Use .NET directly: PowerShell 7 runners can pass a module path that prevents
# Windows PowerShell 5 from finding Get-FileHash / Expand-Archive.
$root = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..'))
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'Windows x64 is required.' }
$version = 'v24.20.0'
$archive = "node-$version-win-x64.zip"
$expected = '6cac9ffbca8f6a47091e4b5c772e0606049c3871cb67d900c0cedde630e545ba'
$cache = [IO.Path]::Combine($root, 'src-tauri/target/node-download')
$runtime = [IO.Path]::Combine($root, 'src-tauri/runtime')
[void][IO.Directory]::CreateDirectory($cache)
[void][IO.Directory]::CreateDirectory($runtime)
$zip = [IO.Path]::Combine($cache, $archive)
if (-not [IO.File]::Exists($zip)) {
    $client = [Net.WebClient]::new()
    try { $client.DownloadFile("https://nodejs.org/dist/$version/$archive", "$zip.part") }
    finally { $client.Dispose() }
    [IO.File]::Move("$zip.part", $zip)
}
$sha = [Security.Cryptography.SHA256]::Create()
$inputFile = [IO.File]::OpenRead($zip)
try { $actual = [BitConverter]::ToString($sha.ComputeHash($inputFile)).Replace('-', '').ToLowerInvariant() }
finally { $inputFile.Dispose(); $sha.Dispose() }
if ($actual -ne $expected) { throw 'Node SHA-256 mismatch. Remove the downloaded archive and retry.' }
[void][Reflection.Assembly]::LoadWithPartialName('System.IO.Compression.FileSystem')
$contents = [IO.Compression.ZipFile]::OpenRead($zip)
try {
    foreach ($name in @('node.exe', 'LICENSE')) {
        $entry = $contents.GetEntry("node-$version-win-x64/$name")
        if ($null -eq $entry) { throw "Missing archive entry: $name" }
        $source = $entry.Open()
        $destination = [IO.File]::Create([IO.Path]::Combine($runtime, $name))
        try { $source.CopyTo($destination) }
        finally { $source.Dispose(); $destination.Dispose() }
    }
} finally { $contents.Dispose() }
[IO.File]::WriteAllText([IO.Path]::Combine($runtime, 'VERSION'), $version)
[Console]::WriteLine("Bundled Node $version win-x64; SHA-256 verified.")

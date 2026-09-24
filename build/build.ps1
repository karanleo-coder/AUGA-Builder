# Builds the packaged desktop app for Windows into dist/AUGA-Builder/,
# then archives it as dist/AUGA-Builder-windows-<arch>.zip.
#
# Requires: uv, node/npm on PATH. Run from anywhere; paths are resolved
# relative to this script's own location.
#
#   powershell -ExecutionPolicy Bypass -File build/build.ps1

$ErrorActionPreference = "Stop"

$AppName = "AUGA-Builder"

$RootDir = Split-Path -Parent $PSScriptRoot
Set-Location $RootDir

$ArchName = $env:PROCESSOR_ARCHITECTURE
Write-Host "==> Building $AppName for windows ($ArchName)"

Write-Host "==> [1/5] Building frontend"
Push-Location frontend
npm ci
npm run build
Pop-Location

Write-Host "==> [2/5] Setting up the build toolchain (PyInstaller)"
if (-not (Test-Path "build\.build-venv")) {
    uv venv build\.build-venv --python 3.12
}
$BuildPy = "build\.build-venv\Scripts\python.exe"
uv pip install --python $BuildPy -r backend\requirements.txt -r build\requirements-build.txt

Write-Host "==> [3/5] Building a portable Python runtime for running scripts"
$RuntimeTmp = "build\.runtime-tmp"
if (Test-Path $RuntimeTmp) { Remove-Item -Recurse -Force $RuntimeTmp }
uv python install 3.12 --install-dir $RuntimeTmp
$RuntimeSrc = Get-ChildItem -Path $RuntimeTmp -Directory -Filter "cpython-*" | Select-Object -First 1
if (-not $RuntimeSrc) {
    Write-Error "could not find the installed standalone Python build"
    exit 1
}
$RuntimePython = Join-Path $RuntimeSrc.FullName "python.exe"
uv pip install --python $RuntimePython --break-system-packages -r scripts_requirements.txt

Write-Host "==> [4/5] Running PyInstaller"
Remove-Item -Recurse -Force "dist\$AppName" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "build\pyinstaller-work" -ErrorAction SilentlyContinue
& $BuildPy -m PyInstaller "build\$AppName.spec" --noconfirm --distpath dist --workpath build\pyinstaller-work

Write-Host "==> [5/5] Assembling final app bundle"
$AppDir = "dist\$AppName"
New-Item -ItemType Directory -Force -Path "$AppDir\python-runtime" | Out-Null
Copy-Item -Path "$($RuntimeSrc.FullName)\*" -Destination "$AppDir\python-runtime" -Recurse -Force

$Archive = "dist\$AppName-windows-$ArchName.zip"
if (Test-Path $Archive) { Remove-Item $Archive }
Compress-Archive -Path $AppDir -DestinationPath $Archive

Write-Host ""
Write-Host "Done."
Write-Host "  App folder: $AppDir\  (run $AppName.exe inside it)"
Write-Host "  Archive:    $Archive"

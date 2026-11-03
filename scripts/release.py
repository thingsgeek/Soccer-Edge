#!/usr/bin/env python3
"""Build a release: Windows exe (.7z) + source backup (.zip). Optional Mac build.

Usage: python3 scripts/release.py [--mac] [--public]
  Reads the version from src/version.ts. Expects docs/CHANGELOG.txt to already have the
  new version's entry at the top, and the change committed (the backup holds git history).

Outputs in dist/:
  soccer-edge-v<ver>.7z          soccer-edge.exe + CHANGELOG.txt (Windows; keep under 30 MB)
  soccer-edge-source-v<ver>.zip  everything needed to continue work in a fresh session
  soccer-edge-mac-v<ver>.zip     (with --mac) macOS 11+ app
  soccer-edge-opensource-v<ver>.zip (with --public) the open-source package (scripts/export-public.py)
"""
import glob, lzma, os, re, shutil, subprocess, sys, zipfile

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
dist = os.path.join(root, 'dist')
ver = re.search(r"APP_VERSION = '([^']+)'", open(os.path.join(root, 'src', 'version.ts')).read()).group(1)
os.makedirs(dist, exist_ok=True)
changelog = os.path.join(root, 'docs', 'CHANGELOG.txt')
if not os.path.exists(changelog):
    changelog = os.path.join(root, 'CHANGELOG.md')  # the open-source package
shutil.copyfile(changelog, os.path.join(dist, 'CHANGELOG.txt'))

# package.json carries the same version as the app.
import json
pj = os.path.join(root, 'package.json')
d = json.load(open(pj))
if d.get('version') != ver:
    d['version'] = ver
    open(pj, 'w').write(json.dumps(d, indent=2) + '\n')
    sys.exit(f'package.json version updated to {ver}: commit it, then run again.')

dirty = subprocess.run(['git', 'status', '--porcelain'], cwd=root, capture_output=True, text=True).stdout.strip()
if dirty:
    sys.exit(f'Commit first (the source backup includes git history):\n{dirty}')

# Windows. Bun can't set an exe icon/name when cross-compiling, so brand the cached Windows
# runtime (soccer-ball icon, "Soccer Edge" version info) first, build, then put the original back.
def build_win():
    subprocess.run(['bun', 'build', 'src/cli.ts', '--compile', '--minify', '--target=bun-windows-x64',
                    '--windows-hide-console', '--outfile', 'dist/soccer-edge.exe'], cwd=root, check=True)
bun_ver = subprocess.run(['bun', '--version'], capture_output=True, text=True, check=True).stdout.strip()
cached = os.path.expanduser(f'~/.bun/install/cache/bun-windows-x64-v{bun_ver}')
if not os.path.exists(cached):
    build_win()  # downloads the runtime
orig = os.path.join(root, '.cache', f'bun-windows-x64-v{bun_ver}.orig')
os.makedirs(os.path.dirname(orig), exist_ok=True)
if not os.path.exists(orig):
    shutil.copyfile(cached, orig)
try:
    subprocess.run(['bun', 'scripts/brand-exe.mjs', orig, cached, 'assets/soccer-ball.ico', ver], cwd=root, check=True)
    subprocess.run([sys.executable, 'scripts/pe_check.py', 'fix', cached], cwd=root, check=True)  # resedit leaves .rsrc overlapping
    build_win()
finally:
    shutil.copyfile(orig, cached)
# Windows refuses an exe whose sections overlap ("This app can't run on your PC"); Wine doesn't.
subprocess.run([sys.executable, 'scripts/pe_check.py', 'check', os.path.join(dist, 'soccer-edge.exe')], cwd=root, check=True)
import py7zr  # pip install py7zr
for old in glob.glob(os.path.join(dist, 'soccer-edge-v*.7z')):
    os.remove(old)
win = os.path.join(dist, f'soccer-edge-v{ver}.7z')
with py7zr.SevenZipFile(win, 'w', filters=[{'id': py7zr.FILTER_X86}, {'id': py7zr.FILTER_LZMA2, 'preset': 9 | lzma.PRESET_EXTREME}]) as z:
    z.write(os.path.join(dist, 'soccer-edge.exe'), 'soccer-edge.exe')
    z.write(os.path.join(dist, 'CHANGELOG.txt'), 'CHANGELOG.txt')
print(win, os.path.getsize(win))

# Source backup: working tree (tracked files) + full git history as a bundle.
for old in glob.glob(os.path.join(dist, 'soccer-edge-source-v*.zip')):
    os.remove(old)
src = os.path.join(dist, f'soccer-edge-source-v{ver}.zip')
bundle = os.path.join(dist, 'soccer-edge.bundle')
subprocess.run(['git', 'bundle', 'create', bundle, '--all'], cwd=root, check=True, capture_output=True)
files = subprocess.run(['git', 'ls-files'], cwd=root, capture_output=True, text=True, check=True).stdout.split('\n')
with zipfile.ZipFile(src, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for f in filter(None, files):
        z.write(os.path.join(root, f), f'soccer-edge/{f}')
    z.write(bundle, 'soccer-edge.bundle')
os.remove(bundle)
print(src, os.path.getsize(src))

if '--public' in sys.argv and os.path.exists(os.path.join(root, 'scripts', 'export-public.py')):
    subprocess.run([sys.executable, 'scripts/export-public.py'], cwd=root, check=True)

if '--mac' in sys.argv:
    subprocess.run([sys.executable, 'scripts/build-mac.py', ver], cwd=root, check=True)

#!/usr/bin/env python3
"""Build "Soccer Edge.app" for Mac: macOS 11 (Big Sur) or later, Intel and Apple Silicon.

Bun's own Mac executables need macOS 13+ since Bun 1.1.38 (12+ since 1.1.5), so instead of a
compiled single file the app carries Bun 1.1.4 (the last version that runs on macOS 11), kept
exactly as Oven signed it (Apple Developer ID), plus the app bundled as one JavaScript file.
A small launcher picks the right Bun for the Mac's processor.

Usage: python3 scripts/build-mac.py <version>
Output: dist/soccer-edge-mac-v<version>.zip
"""
import os, plistlib, shutil, subprocess, sys, tarfile, zipfile

BUN = '1.1.4'
ver = sys.argv[1]
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
cache = os.path.join(root, '.cache', f'bun-{BUN}')
work = os.path.join(root, 'dist', 'mac')


def fetch(pkg: str) -> str:
    """npm package @oven/<pkg>@BUN -> path of its bin/bun (cached)."""
    d = os.path.join(cache, pkg)
    exe = os.path.join(d, 'package', 'bin', 'bun')
    if not os.path.exists(exe):
        os.makedirs(d, exist_ok=True)
        out = subprocess.run(['npm', 'pack', f'@oven/{pkg}@{BUN}'], cwd=d, check=True, capture_output=True, text=True).stdout.strip().splitlines()[-1]
        with tarfile.open(os.path.join(d, out)) as t:
            t.extractall(d, filter='data')
        os.chmod(exe, 0o755)
    return exe


linux_bun = fetch('bun-linux-x64')
mac = {'x64': fetch('bun-darwin-x64-baseline'), 'arm64': fetch('bun-darwin-aarch64')}

shutil.rmtree(work, ignore_errors=True)
app = os.path.join(work, 'Soccer Edge.app')
res = os.path.join(app, 'Contents', 'Resources')
macos = os.path.join(app, 'Contents', 'MacOS')
os.makedirs(res)
os.makedirs(macos)

# The app as one JavaScript file, bundled by the same Bun version that runs it.
subprocess.run([linux_bun, 'build', 'src/cli.ts', '--target=bun', '--minify', '--outfile', os.path.join(res, 'app.js')], cwd=root, check=True)
shutil.copyfile(os.path.join(root, 'assets', 'soccer-ball.icns'), os.path.join(res, 'soccer-ball.icns'))
for arch, src in mac.items():
    # Named for the app so Activity Monitor shows "soccer-edge", not "bun" (renaming keeps Oven's signature valid).
    dst = os.path.join(res, f'soccer-edge-{arch}')
    shutil.copyfile(src, dst)
    os.chmod(dst, 0o755)

launcher = os.path.join(macos, 'soccer-edge')
with open(launcher, 'w', newline='\n') as f:
    f.write('''#!/bin/sh
# Soccer Edge launcher: runs the app with the Bun built for this Mac's processor.
R="$(cd "$(dirname "$0")/../Resources" && pwd)"
# You approved the app when you first opened it; clear the download flag on its own files so
# macOS doesn't ask again for the Bun inside it.
xattr -dr com.apple.quarantine "$R" 2>/dev/null
case "$(uname -m)" in
  arm64) B="$R/soccer-edge-arm64" ;;
  *)     B="$R/soccer-edge-x64" ;;
esac
# Apple Silicon Mac running this launcher under Rosetta: still use the native Bun.
if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = "1" ]; then B="$R/soccer-edge-arm64"; fi
exec "$B" "$R/app.js" "$@"
''')
os.chmod(launcher, 0o755)

with open(os.path.join(app, 'Contents', 'Info.plist'), 'wb') as f:
    plistlib.dump({
        'CFBundleName': 'Soccer Edge',
        'CFBundleDisplayName': 'Soccer Edge',
        'CFBundleIdentifier': 'com.predygo.soccer-edge',
        'CFBundleExecutable': 'soccer-edge',
        'CFBundleIconFile': 'soccer-ball',
        'CFBundlePackageType': 'APPL',
        'CFBundleShortVersionString': ver,
        'CFBundleVersion': ver,
        'LSMinimumSystemVersion': '11.0',
        # No Dock icon of its own: the app's window is a browser window.
        'LSUIElement': True,
        'NSHighResolutionCapable': True,
    }, f)

zpath = os.path.join(root, 'dist', f'soccer-edge-mac-v{ver}.zip')
if os.path.exists(zpath):
    os.remove(zpath)
with zipfile.ZipFile(zpath, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for d, _, files in os.walk(app):
        for name in sorted(files):
            full = os.path.join(d, name)
            zi = zipfile.ZipInfo.from_file(full, os.path.relpath(full, work))
            zi.external_attr = (os.stat(full).st_mode & 0xFFFF) << 16
            zi.create_system = 3  # Unix, so the executable bits survive
            with open(full, 'rb') as src:
                z.writestr(zi, src.read(), zipfile.ZIP_DEFLATED)
    z.write(os.path.join(root, 'dist', 'CHANGELOG.txt'), 'CHANGELOG.txt')
    z.writestr('READ ME FIRST.txt', f"""Soccer Edge {ver} for Mac (macOS 11 Big Sur or later, Intel and Apple Silicon)

1. Unzip, then drag "Soccer Edge.app" into Applications.
2. First open only: the app isn't from the App Store, so macOS asks before running it.
   Right-click (or Control-click) the app, choose Open, then press Open.
   (macOS 13 or later: if there's no Open button, press Done, then go to System Settings >
   Privacy & Security, scroll down and press "Open Anyway".) After that it opens normally.
3. The app opens in its own window using Google Chrome, Microsoft Edge or Brave if you have
   one (closing that window quits the app); otherwise it opens in Safari.
4. Enter your keys and a password the first time. Keys saved on Windows can't be moved
   over; they are encrypted for that PC.

If it still won't open, open Terminal and run:
   xattr -dr com.apple.quarantine "/Applications/Soccer Edge.app"
then open it again.

Your data folder: ~/Library/Application Support/soccer-edge
""")
shutil.rmtree(work)
print(zpath, os.path.getsize(zpath))

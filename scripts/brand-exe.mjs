// Brand a Windows Bun runtime (icon + version info) before bun build --compile uses it.
// Usage: bun scripts/brand-exe.mjs <in.exe> <out.exe> <icon.ico> <version>
import * as ResEdit from 'resedit';
import * as PELibrary from 'pe-library';
import { readFileSync, writeFileSync } from 'node:fs';
const [inp, out, ico, ver] = process.argv.slice(2);
const exe = PELibrary.NtExecutable.from(readFileSync(inp), { ignoreCert: true });
const res = PELibrary.NtExecutableResource.from(exe);
const iconFile = ResEdit.Data.IconFile.from(readFileSync(ico));
const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
const gid = groups.length ? groups[0].id : 1, lang = groups.length ? groups[0].lang : 1033;
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, gid, lang, iconFile.icons.map((i) => i.data));
const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0] ?? ResEdit.Resource.VersionInfo.createEmpty();
const [a, b, c] = ver.split('.').map(Number);
vi.setFileVersion(a, b, c, 0, 1033); vi.setProductVersion(a, b, c, 0, 1033);
const langs = vi.getAllLanguagesForStringValues();
for (const l of (langs.length ? langs : [{ lang: 1033, codepage: 1200 }])) {
  vi.setStringValues(l, {
    FileDescription: 'Soccer Edge', ProductName: 'Soccer Edge', CompanyName: 'Soccer Edge contributors',
    LegalCopyright: 'MIT License', OriginalFilename: 'soccer-edge.exe', InternalName: 'soccer-edge',
    FileVersion: ver, ProductVersion: ver,
  });
}
vi.outputToResourceEntries(res.entries);
res.outputResource(exe);
writeFileSync(out, Buffer.from(exe.generate()));
console.log('branded', out);

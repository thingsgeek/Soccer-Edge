#!/usr/bin/env python3
"""Windows exe layout: fix the resource-section size resedit leaves behind, and validate.

resedit shrinks .rsrc's virtual size when it rewrites resources but keeps its old raw size, so
the raw data runs into the next section's address range. Wine runs that; Windows refuses it
("This app can't run on your PC"). fix() trims SizeOfRawData; check() fails on any overlap.
Usage: python3 scripts/pe_check.py fix|check <exe>
"""
import sys
import pefile

def align(v, a):
    return (v + a - 1) // a * a

def problems(pe):
    out = []
    sa, fa = pe.OPTIONAL_HEADER.SectionAlignment, pe.OPTIONAL_HEADER.FileAlignment
    secs = pe.sections
    for i, s in enumerate(secs):
        name = s.Name.rstrip(b'\0').decode(errors='replace')
        end = s.VirtualAddress + align(max(s.Misc_VirtualSize, s.SizeOfRawData), sa)
        nxt = secs[i + 1].VirtualAddress if i + 1 < len(secs) else pe.OPTIONAL_HEADER.SizeOfImage
        if end > nxt:
            out.append(f'{name}: memory range ends {hex(end)}, past the next section / image end {hex(nxt)}')
        if s.SizeOfRawData % fa:
            out.append(f'{name}: raw size {hex(s.SizeOfRawData)} not file-aligned')
        if s.SizeOfRawData > align(s.Misc_VirtualSize, fa) and s.SizeOfRawData > align(s.Misc_VirtualSize, sa):
            out.append(f'{name}: raw size {hex(s.SizeOfRawData)} larger than its virtual size {hex(s.Misc_VirtualSize)}')
    return out

def fix(path):
    pe = pefile.PE(path, fast_load=True)
    fa = pe.OPTIONAL_HEADER.FileAlignment
    changed = False
    for s in pe.sections:
        want = align(s.Misc_VirtualSize, fa)
        if s.Name.rstrip(b'\0') == b'.rsrc' and s.SizeOfRawData > want:
            s.SizeOfRawData = want
            changed = True
    if changed:
        data = pe.write()
        pe.close()
        open(path, 'wb').write(data)
    return changed

if __name__ == '__main__':
    cmd, path = sys.argv[1], sys.argv[2]
    if cmd == 'fix':
        print('fixed .rsrc size' if fix(path) else 'nothing to fix')
    p = problems(pefile.PE(path, fast_load=True))
    if p:
        sys.exit('Windows would refuse this exe:\n' + '\n'.join(p))
    print('layout ok')

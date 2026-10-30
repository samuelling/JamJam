#!/usr/bin/env python3
"""Build the Studio Kit's samples from Virtuosity Drums (CC0, github.com/sfzinstruments/virtuosity_drums).

A small, curated set: a few velocity layers (and two round robins where it helps) per articulation, the overhead
pair mixed with the kick or snare close mic, trimmed with a fade, as 112 kbps stereo MP3. Writes
instruments/studio/*.mp3 and instruments/studio/kit.json (note -> layers by velocity -> files).

  python3 -I tools/build_studio_kit.py /path/to/virtuosity_drums   (a checkout; only the files used are read)
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'instruments' / 'studio'
# name, GM notes, overhead stem, close mic (folder, stem, gain), layers [(vl, [rr...])], seconds kept, gain dB
KIT = [
    ('kick', [35, 36], 'oh/kick/oh_kick_snon', ('kickmic/kick/kickmic_kick_snon', 0.9), [(1, [1, 2]), (2, [1, 2]), (3, [1, 2]), (4, [1, 2])], 0.9, 0),
    ('snare', [38, 40], 'oh/snare/oh_snare_center', ('snaremic/snare/snaremic_snare_center', 0.6), [(4, [0]), (10, [0]), (16, [0]), (22, [0]), (28, [0]), (34, [0])], 1.1, 0),
    ('xstick', [37], 'oh/snare/oh_snare_crossstick', ('snaremic/snare/snaremic_snare_crossstick', 0.6), [(3, [0]), (8, [0]), (12, [0])], 0.6, 0),
    ('rimshot', [39], 'oh/snare/oh_snare_rimshot', ('snaremic/snare/snaremic_snare_rimshot', 0.5), [(4, [0]), (8, [0]), (12, [0])], 1.2, -3),
    ('tomhi', [48, 50, 47], 'oh/htom/oh_htom_center', None, [(4, [0]), (9, [0]), (14, [0])], 1.4, 2),
    ('tomlo', [45, 43, 41], 'oh/ltom/oh_ltom_center', None, [(4, [0]), (9, [0]), (14, [0])], 1.6, 2),
    ('hhclosed', [42], 'oh/hh/oh_hh_closed', None, [(1, [1, 2]), (2, [1, 2]), (3, [1, 2]), (4, [1, 2])], 0.5, 0),
    ('hhpedal', [44], 'oh/hh/oh_hh_pedal', None, [(1, [1]), (2, [1]), (3, [1])], 0.5, 2),
    ('hhopen', [46], 'oh/hh/oh_hh_open', None, [(2, [1]), (4, [1])], 1.8, -1),
    ('ride', [51, 59], 'oh/ride/oh_ride_ride', None, [(1, [1, 2]), (2, [1, 2]), (3, [1, 2])], 3.2, 0),
    ('bell', [53], 'oh/ride/oh_ride_bell', None, [(1, [1]), (2, [1]), (3, [1])], 2.6, -2),
    ('crash', [49, 57, 52, 55], 'oh/crash/oh_crash_crash', None, [(1, [1]), (2, [1]), (3, [1])], 4.0, -2),
]


def src(root: Path, stem: str, vl: int, rr: int) -> Path:
    return root / 'Samples' / f'{stem}_vl{vl}' f'{"" if rr == 0 else f"_rr{rr}"}.flac'


def build(root: Path) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    manifest: dict = {'source': 'Virtuosity Drums by Versilian Studios, CC0 1.0 (github.com/sfzinstruments/virtuosity_drums)', 'voices': {}}
    for name, notes, oh, close, layers, secs, gain in KIT:
        lay = []
        for i, (vl, rrs) in enumerate(layers):
            files = []
            for rr in rrs:
                out = f'{name}_{i + 1}' + (f'_{rr}' if len(rrs) > 1 else '') + '.mp3'
                fade = max(0.05, secs * 0.35)
                tail = f'atrim=0:{secs},afade=t=out:st={secs - fade:.3f}:d={fade:.3f},aresample=44100'
                g = f'{10 ** (gain / 20):.3f}'
                ins = ['-i', str(src(root, oh, vl, rr))]
                if close:
                    ins += ['-i', str(src(root, close[0], vl, rr))]
                    fg = f'[0:a]volume={g}[o];[1:a]pan=stereo|c0=c0|c1=c0,volume={close[1] * float(g):.3f}[c];[o][c]amix=inputs=2:normalize=0,{tail}'
                else:
                    fg = f'[0:a]volume={g},{tail}'
                cmd = ['ffmpeg', '-v', 'error', '-y', *ins, '-filter_complex', fg, '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '112k', str(OUT / out)]
                subprocess.run(cmd, check=True)
                files.append(out)
            lay.append({'top': round(127 * (i + 1) / len(layers)), 'files': files})
        manifest['voices'][name] = {'notes': notes, 'layers': lay, 'choke': 'hh' if name.startswith('hh') else None}
    (OUT / 'kit.json').write_text(json.dumps(manifest, indent=1) + '\n')


def needed(root: Path) -> list[str]:
    out = []
    for _n, _notes, oh, close, layers, _s, _g in KIT:
        for vl, rrs in layers:
            for rr in rrs:
                out.append(str(src(root, oh, vl, rr).relative_to(root)))
                if close:
                    out.append(str(src(root, close[0], vl, rr).relative_to(root)))
    return out


if __name__ == '__main__':
    if len(sys.argv) > 2 and sys.argv[2] == '--list':
        print('\n'.join(needed(Path(sys.argv[1]))))
        sys.exit(0)
    build(Path(sys.argv[1]))

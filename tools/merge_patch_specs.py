#!/usr/bin/env python3
"""Merge researched per-model MIDI facts into instruments/hardware.json, for patch sharing between same synths.

Input: JSON files of {unitId: entry}, as gathered from makers' MIDI implementation documents and open-source editors
(entry: midi, programChange, params, dump {request, reply, replies, loads, deviceIdByte}, manualDump, confidence,
sources, notes). Only dumps read in a manual or a reliable secondary source, that load as the current sound
(loads == 'edit-buffer', never into a stored slot), become automatic requests. Everything else keeps at most its
front-panel how-to, so MEGAjam can tell the player how to send one by hand.

  python3 -I tools/merge_patch_specs.py facts1.json facts2.json ...
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

HW = Path(__file__).resolve().parent.parent / 'instruments' / 'hardware.json'
HEX = re.compile(r'^(F0)( [0-9A-F]{2})*$')


def clean(s: str) -> str:
    return ' '.join(s.upper().replace(',', ' ').replace('0X', '').split())


def main(paths: list[str]) -> None:
    facts: dict = {}
    for p in paths:
        facts.update(json.loads(Path(p).read_text()))
    data = json.loads(HW.read_text())
    auto = manual = 0
    for u in data['hardware']:
        f = facts.get(u['id'])
        u.pop('dump', None); u.pop('midi', None)
        if not f:
            continue
        if f.get('midi') is False:
            u['midi'] = False
            continue
        d, out = f.get('dump') or {}, {}
        ok = f.get('confidence') in ('manual', 'secondary') and d.get('loads') == 'edit-buffer'
        req, rep = clean(d.get('request') or ''), clean(d.get('reply') or '')
        # a request may be several messages (Roland: one RQ1 per block), each answered before the next goes
        if ok and HEX.match(req) and req.endswith('F7') and HEX.match(rep):
            n = d.get('replies') or 1
            out = {'request': req, 'reply': rep, 'replies': n if isinstance(n, int) else str(n)}
            if d.get('deviceIdByte') is not None:
                out['deviceIdByte'] = int(d['deviceIdByte'])
            auto += 1
        elif f.get('manualReply') and HEX.match(clean(f['manualReply'].get('reply', ''))):
            # no request command, but we know what its front-panel dump looks like
            mr = f['manualReply']
            out = {'reply': clean(mr['reply'])}
            if mr.get('deviceIdByte') is not None:
                out['deviceIdByte'] = int(mr['deviceIdByte'])
        if f.get('manualDump'):
            out['manualDump'] = str(f['manualDump'])[:160]
            manual += 'request' not in out
        if out:
            out['params'] = f.get('params') or 'cc'
            if f.get('sources'):
                out['source'] = f['sources'][0]
            u['dump'] = out
    data['about'] = data['about'].split(' Patch sharing:')[0] + (
        " Patch sharing: 'dump' holds a model's request for its current sound (SysEx, edit buffer), the reply's prefix and"
        " how many messages it has, or failing that how to send a dump from the front panel; gathered from makers' MIDI"
        " documentation and open-source editors, merged by tools/merge_patch_specs.py.")
    HW.write_text(json.dumps(data, indent=1, ensure_ascii=False) + '\n')
    print(f'{auto} units fetch their sound automatically, {manual} more by a front-panel dump')


if __name__ == '__main__':
    main(sys.argv[1:])

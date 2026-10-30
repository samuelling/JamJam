#!/usr/bin/env python3
"""Add researched hardware units to instruments/hardware.json, checked against the catalogue's vocabularies.

Input: JSON arrays of catalogue entries (id, maker, model, year, family, voices, osc, filter, types, character,
note). Each is checked: a known family, osc and filter from the vocabularies (anything else is mapped to the nearest
or rejected), types from the patch-type list, character keys the twins understand, and no clash with a unit already
listed (same id, or the same maker and model). Accepted units go in after the last unit from the same maker, so
the list stays grouped. Run tools/merge_patch_specs.py afterwards for their MIDI facts and set-up steps.

  python3 -I tools/add_units.py units1.json units2.json ...
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

HW = Path(__file__).resolve().parent.parent / 'instruments' / 'hardware.json'
OSC = set('vco dco va wavetable sample fm digital analog-drum hybrid-drum divide pd reed string electronic tine la additive tape tonewheel electromech'.split())
FILTER = set('ladder ota ssm cem sem diode ms20 steiner arp svf digital none'.split())
TYPES = set('bass lead pad keys brass strings pluck bell lofi 808 909 hybrid acoustic acid efm wurly soft'.split())
CHAR = set('detune drive chorus mono bits sub reso trem bright decay bell wave emphasis mix3 hpf lfoPitch kick.decay kick.pitch snare.snap snare.pitch chh.decay'.split())
NEAR = {'analog': 'vco', 'vca': 'vco', 'virtual-analog': 'va', 'granular': 'sample', 'physical': 'digital', 'karplus': 'string', 'phase-distortion': 'pd',
        'moog': 'ladder', 'transistor-ladder': 'ladder', 'lpg': 'ota', 'vactrol': 'ota', 'sallen-key': 'svf', 'state-variable': 'svf', 'polivoks': 'ota', 'korg35': 'ms20'}
squash = lambda s: re.sub(r'[^a-z0-9]', '', str(s).lower().replace('+', 'plus'))  # noqa: E731


def check(u: dict, fams: set, ids: set, models: set) -> tuple[dict | None, str]:
    req = ('id', 'maker', 'model', 'family')
    if any(not u.get(k) for k in req):
        return None, 'missing ' + ', '.join(k for k in req if not u.get(k))
    uid = re.sub(r'[^a-z0-9-]', '-', str(u['id']).lower()).strip('-')
    if uid in ids:
        return None, 'id already listed'
    if squash(u['maker']) + '|' + squash(u['model']) in models:
        return None, 'model already listed'
    if u['family'] not in fams:
        return None, f"unknown family {u['family']}"
    osc = NEAR.get(u.get('osc'), u.get('osc') or 'digital'); flt = NEAR.get(u.get('filter'), u.get('filter') or 'none')
    if osc not in OSC or flt not in FILTER:
        return None, f'unknown osc/filter {osc}/{flt}'
    types = [t for t in (u.get('types') or []) if t in TYPES][:4]
    if not types:
        return None, 'no usable patch types'
    out = {'id': uid, 'maker': str(u['maker']), 'model': str(u['model'])}
    if isinstance(u.get('year'), int):
        out['year'] = u['year']
    out['family'] = u['family']
    if isinstance(u.get('voices'), int) and u['voices'] > 0:
        out['voices'] = u['voices']
    out.update({'osc': osc, 'filter': flt, 'types': types})
    ch = {k: v for k, v in (u.get('character') or {}).items() if k in CHAR and isinstance(v, (int, float))}
    out['character'] = ch
    if u.get('note'):
        out['note'] = str(u['note'])[:140]
    if u.get('twin'):
        out['twin'] = str(u['twin'])
    return out, ''


def main(paths: list[str]) -> None:
    data = json.loads(HW.read_text())
    fams = set(data['families'])
    hw: list = data['hardware']
    ids = {u['id'] for u in hw}
    models = {squash(u['maker']) + '|' + squash(u['model']) for u in hw}
    added, skipped = 0, []
    for p in paths:
        for u in json.loads(Path(p).read_text()):
            e, why = check(u, fams, ids, models)
            if not e:
                skipped.append(f"{u.get('maker')} {u.get('model')}: {why}")
                continue
            at = max((i for i, x in enumerate(hw) if squash(x['maker']) == squash(e['maker'])), default=len(hw) - 1) + 1
            hw.insert(at, e); ids.add(e['id']); models.add(squash(e['maker']) + '|' + squash(e['model'])); added += 1
    HW.write_text(json.dumps(data, indent=1, ensure_ascii=False) + '\n')
    print(f'added {added} units ({len(hw)} in all); skipped {len(skipped)}')
    for s in skipped:
        print('  skipped', s)


if __name__ == '__main__':
    main(sys.argv[1:])

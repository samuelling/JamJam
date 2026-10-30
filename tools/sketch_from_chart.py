#!/usr/bin/env python3
"""Build a megajam.song/1 sketch from a chart: a JSON file of title, tempo, key, chord changes and form.

    python3 tools/sketch_from_chart.py training-data/charts/blue-in-green.json

Writes <chart folder>/../sketches/<name>.megajam.json, ready for Import a sketch in the Compose Room. Tine comps,
Monolith plays the bass, Studio Kit plays time and Blown plays the lead. The same chart always gives the same song.

The lead: a chart may carry "melody": {"Head": [[beat, length, midi note, velocity], ...]}, beats counted from the
top of that section. Without one, an original line is written over the changes as a placeholder.
"""
import json, random, re, sys
from pathlib import Path

# intervals above the root, for the comping voicing (rootless where a bass has the root)
QUALITIES = [
    (r'-69$', [3, 7, 9, 14]), (r'-7$', [3, 7, 10, 14]), (r'maj7#11$', [4, 7, 11, 18]), (r'7#5#9$', [4, 8, 10, 15]),
    (r'7#9$', [4, 10, 15]), (r'7b9$', [4, 10, 13]), (r'7b5$', [4, 6, 10]), (r'7$', [4, 7, 10]), (r'-$', [3, 7]), (r'$', [4, 7]),
]
ROOTS = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}
FIFTH = {'b5': 6, '#5': 8}
KICK, XSTICK, PEDAL, RIDE, CRASH = 36, 37, 44, 51, 49


def parse(symbol):
    m = re.match(r'([A-G])([#b]?)(.*)', symbol)
    root = (ROOTS[m[1]] + {'#': 1, 'b': -1, '': 0}[m[2]]) % 12
    tones = next(t for pat, t in QUALITIES if re.search(pat, m[3]))
    fifth = next((v for k, v in FIFTH.items() if k in m[3]), 7)
    return root, tones, fifth


def changes(bars, meter):
    """[(beat, length, symbol)] for a section"""
    out = []
    for i, bar in enumerate(bars):
        b = i * meter
        for sym, n in bar:
            out.append((b, n, sym))
            b += n
    return out


def note(ev, b, n, length, vel):
    ev.append({'b': round(b, 4), 'type': 'on', 'note': n, 'vel': vel})
    ev.append({'b': round(b + length, 4), 'type': 'off', 'note': n})


def voicing(symbol, prev):
    """the chord's tones in the middle of the keyboard, moving as little as it can from the last voicing"""
    root, tones, _ = parse(symbol)
    best, cost = None, 1e9
    for base in range(48, 66):
        if base % 12 != root:
            continue
        v = sorted(base + t for t in tones)
        if v[0] < 50 or v[-1] > 77:
            continue
        c = sum(abs(a - b) for a, b in zip(v, prev)) if prev else abs(sum(v) / len(v) - 62)
        if c < cost:
            best, cost = v, c
    return best


def comp(chs, rng, ending):
    """long chords, with a soft push ahead of some changes"""
    hits, prev = [], None   # [start, length, note, velocity]
    for k, (b, n, sym) in enumerate(chs):
        v = voicing(sym, prev)
        prev = v
        last = ending and k == len(chs) - 1
        push = 0 if k == 0 or last or n < 4 or rng.random() > 0.3 else -0.5
        hold = n - push - 0.1
        for i, p in enumerate(v):
            roll = i * 0.05 if last else 0
            hits.append([b + push + roll, hold - roll, p, rng.randint(50, 60)])
        if n >= 4 and not last and rng.random() < 0.45:
            for p in v:
                hits.append([b + 2.5, 1.2, p, rng.randint(40, 50)])
    # a note repeated before it has ended is cut short: the same pitch can't overlap itself in a take
    hits.sort()
    ev = []
    for i, (b, length, p, vel) in enumerate(hits):
        again = next((h[0] for h in hits[i + 1:] if h[2] == p), None)
        note(ev, b, p, length if again is None else min(length, again - b - 0.05), vel)
    return ev


def bass_note(pc, near):
    """Monolith's bass patch sounds an octave down, so these are written an octave up"""
    return min((n for n in range(40, 60) if n % 12 == pc), key=lambda n: abs(n - near))


def bass(chs, feel, rng, ending, section_beats):
    ev, last = [], 45
    for k, (b, n, sym) in enumerate(chs):
        root, _, fifth = parse(sym)
        following = parse(chs[k + 1][2])[0] if k + 1 < len(chs) else root
        if ending and k == len(chs) - 1:
            note(ev, b, bass_note(root, last), n - 0.1, 78)
            continue
        if feel == 'two':
            hits = [(0, root, 74)] if n < 4 else [(0, root, 76), (2, (root + fifth) % 12, 66)]
            step = 2 if n >= 4 else n
        else:
            line = [root, (root + fifth) % 12, (root + (10 if rng.random() < 0.5 else 3)) % 12, (following + rng.choice([-1, 1])) % 12]
            hits = [(i, line[i if n == 4 else 0 if i == 0 else 3], 72 - 4 * (i % 2)) for i in range(n)]
            step = 1
        for at, pc, vel in hits:
            last = bass_note(pc, last)
            note(ev, b + at, last, step - 0.08, vel)
    return ev


def drums(beats, meter, feel, rng, ending):
    """ride with a soft swing, pedal hat on 2 and 4, cross-stick now and then, a feathered kick"""
    ev = []
    if ending:
        for bar in range(beats // meter - 1):
            for beat in range(meter):
                note(ev, bar * meter + beat, RIDE, 0.2, 44 + rng.randint(-3, 3))
        note(ev, beats - meter, RIDE, 0.3, 58)
        note(ev, beats - meter, KICK, 0.3, 42)
        return ev
    for bar in range(beats // meter):
        at = bar * meter
        note(ev, at, CRASH if bar == 0 and feel == 'walk' else RIDE, 0.2, 50 if bar == 0 and feel == 'walk' else 48 + rng.randint(-4, 4))
        for beat in range(1, meter):
            note(ev, at + beat, RIDE, 0.2, (54 if beat % 2 else 46) + rng.randint(-4, 4))
            if beat % 2 and (feel == 'walk' or rng.random() < 0.5):
                note(ev, at + beat + 2 / 3, RIDE, 0.15, 36 + rng.randint(-4, 4))
            if beat % 2:
                note(ev, at + beat, PEDAL, 0.2, 52 + rng.randint(-5, 5))
        note(ev, at, KICK, 0.3, 40 + rng.randint(-4, 4))
        if bar % 2 == 1 and rng.random() < 0.6:
            note(ev, at + 3, XSTICK, 0.2, 46 + rng.randint(-5, 5))
    return ev


# the placeholder's phrases, two bars each: (beat, length). Rests leave room for whoever replaces it.
PHRASES = [
    [(1.5, 0.5), (2, 0.5), (2.5, 1.5), (5, 1), (6, 2)],
    [(0.5, 1), (1.5, 0.5), (2, 2), (4.5, 0.5), (5, 0.5), (5.5, 1.5)],
    [(2, 0.5), (2.5, 0.5), (3, 1), (4, 0.5), (4.5, 2.5)],
]


def lead(chs, beats, rng, ending):
    """an original line over the changes: chord tones in syncopated two-bar phrases, in a trumpet's middle register"""
    ev, last, start = [], 72, 0
    at_beat = lambda b: next((c for c in reversed(chs) if c[0] <= b), chs[0])
    while start < beats:
        for at, length in rng.choice(PHRASES):
            b = start + at
            if b >= beats:
                break
            root, tones, _ = parse(at_beat(b)[2])
            pool = [n for n in range(62, 82) if (n - root) % 12 in {t % 12 for t in tones}]
            n = min(pool, key=lambda p: (abs(p - last) if abs(p - last) > 0 else 3) + rng.random() * 3)
            note(ev, b, n, min(length, beats - b) - 0.06, rng.randint(70, 88))
            last = n
        start += 8
    return ev


def part(pid, name, role, inst, patch, drum, events, take, by='seed', params=None):
    events = sorted(events, key=lambda e: (e['b'], e['type'] != 'off'))
    p = {'id': pid, 'name': name, 'lane': name, 'role': role, 'inst': inst, 'patch': patch, 'drums': drum,
         'takes': [{'id': take, 'events': events, 'by': 'import', 'byName': by, 'at': 0}], 'current': take, 'by': 'import'}
    if params:
        p['params'] = params
    return p


def build(chart):
    rng = random.Random(chart['title'])
    meter = chart.get('meter', 4)
    song = {'format': 'megajam.song/1', 'title': chart['title'], 'bpm': chart['bpm'], 'key': chart['key'], 'meter': meter,
            'order': [], 'labels': [], 'rule': 'newest', 'variations': {}, 'sections': {}}
    trumpet = {'kind': 2, 'breath': 0.9, 'attack': 0.03, 'noise': 0.15, 'vib': 0.2, 'tone': 0.85}   # Blown's nearest: a bright reed
    for i, sec in enumerate(chart['arrangement']):
        sid, bars = f's{i + 1}', chart['form'][sec['from']][:sec['bars']]
        beats, chs, ending = len(bars) * meter, changes(bars, meter), sec.get('ending', False)
        tag = sid   # a take id per section: the render cache is keyed by part and take
        parts = [part('l-tine', 'Tine', 'comping', 'tine', 'keys', False, comp(chs, rng, ending), f'{tag}-tine'),
                 part('l-bass', 'Bass', 'bass line', 'monolith', 'bass', False, bass(chs, sec['feel'], rng, ending, beats), f'{tag}-bass'),
                 part('l-drums', 'Drums', 'time', 'studio', 'dark', True, drums(beats, meter, sec['feel'], rng, ending), f'{tag}-drums')]
        if sec.get('melody'):
            given = chart.get('melody', {}).get(sec['name'])
            ev = []
            if given is not None:
                for b, length, n, vel in given:
                    note(ev, b, n, length, vel)
            else:
                ev = lead(chs, beats, rng, ending)
            parts.append(part('l-trumpet', 'Trumpet', 'melody', 'blown', 'reed', False, ev, f'{tag}-trumpet', 'given' if given is not None else 'placeholder', trumpet))
        names = [str(sym) for sym in (b[0][0].replace('-', 'm') for b in bars)]
        song['sections'][sid] = {'id': sid, 'name': sec['name'], 'bars': len(bars), 'chords': names,
                                 'notes': ' | '.join(' '.join(f'{s} ({n})' for s, n in b) for b in bars), 'parts': {p['id']: p for p in parts}}
        song['order'].append(sid)
    return song


if __name__ == '__main__':
    src = Path(sys.argv[1])
    out = src.parent.parent / 'sketches' / (src.stem + '.megajam.json')
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(build(json.loads(src.read_text())), indent=1))
    print(out)

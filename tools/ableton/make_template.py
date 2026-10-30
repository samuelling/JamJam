#!/usr/bin/env python3
"""Make the Ableton Live set template the stem export builds its .als from.

Input: a Live set saved by Live (gzipped XML) with one MIDI track holding a MIDI clip and one audio track holding an
audio clip, both in the arrangement. Output: src/ableton-live11.xml, that set with everything personal or
instrument-specific taken out: no devices on any track (returns included), no take lanes, no file paths, the MIDI
clip emptied of notes, the transport at the top. The export clones the MIDI and audio tracks (and their clips) once
per song track and fills them in.

    python3 -I tools/ableton/make_template.py "path/to/Set.als"
"""
from __future__ import annotations

import gzip
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

OUT = Path(__file__).resolve().parents[2] / 'src' / 'ableton-live11.xml'


def strip_devices(track: ET.Element) -> None:
    devs = track.find('DeviceChain/DeviceChain/Devices')
    if devs is not None:
        for d in list(devs):
            devs.remove(d)


def strip_take_lanes(track: ET.Element) -> None:
    lanes = track.find('TakeLanes/TakeLanes')
    if lanes is not None:
        for d in list(lanes):
            lanes.remove(d)


def main(src: str) -> None:
    root = ET.fromstring(gzip.decompress(Path(src).read_bytes()))
    ls = root.find('LiveSet')
    assert ls is not None, 'not a Live set'
    tracks = ls.find('Tracks')
    assert tracks is not None
    kinds = [t.tag for t in tracks]
    assert 'MidiTrack' in kinds and 'AudioTrack' in kinds, f'need a MIDI and an audio track, got {kinds}'
    for t in tracks:
        strip_devices(t)
        strip_take_lanes(t)
    midi = tracks.find('MidiTrack')
    audio = tracks.find('AudioTrack')
    assert midi is not None and audio is not None
    mclip = midi.find('DeviceChain/MainSequencer/ClipTimeable/ArrangerAutomation/Events/MidiClip')
    aclip = audio.find('DeviceChain/MainSequencer/Sample/ArrangerAutomation/Events/AudioClip')
    assert mclip is not None and aclip is not None, 'put a MIDI clip and an audio clip in the arrangement'
    keys = mclip.find('Notes/KeyTracks')
    assert keys is not None
    for k in list(keys):
        keys.remove(k)
    for e in root.iter('FileRef'):
        for tag in ('Path', 'RelativePath'):
            p = e.find(tag)
            if p is not None:
                p.set('Value', '')
    for e in root.iter('OriginalFileSize'):
        e.set('Value', '0')
    for e in root.iter('OriginalCrc'):
        e.set('Value', '0')
    for e in root.iter('LastModDate'):
        e.set('Value', '0')
    cur = ls.find('Transport/CurrentTime')
    if cur is not None:
        cur.set('Value', '0')
    # only the first MIDI and audio track, then the returns
    for t in list(tracks):
        if t.tag in ('MidiTrack', 'AudioTrack') and t is not midi and t is not audio:
            tracks.remove(t)
    text = ET.tostring(root, encoding='unicode')
    assert '/Users/' not in text, 'a personal path survived'
    OUT.write_text('<?xml version="1.0" encoding="UTF-8"?>\n' + text + '\n', encoding='utf-8')
    print(f'wrote {OUT} ({len(text) // 1024} KB) from {root.get("Creator")}')


if __name__ == '__main__':
    main(sys.argv[1])

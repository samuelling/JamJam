#!/usr/bin/env python3
"""Build the Pads instrument's kits: sixteen short mono MP3s per kit, plus the kit table inside instruments/pads.js.

Every sound is CC0 / public domain, or made here:
  - VCSL, the Versilian Community Sample Library (CC0 1.0, github.com/sgossner/VCSL)
  - Sample Pi, the sounds of Sonic Pi, from freesound.org under CC0 1.0 (github.com/alex-esc/sample-pi)
  - the Meadowlark factory library (CC0 1.0, github.com/BillyDM/meadowlark-factory-library)
  - MEGAjam's own Studio Kit (from Virtuosity Drums, CC0 1.0), reprocessed
  - synthesized by this script (the Boom Box kit)
Loops become kits the MPC way: chopped at their hits, one slice per pad, so they play at any tempo.

Each sound is trimmed (from just before its first sound to where it has died away, with a fade), peak-normalised to -6 dBFS,
encoded as 96 kbps mono MP3 at 44.1 kHz, and described by a small recipe (what kind of hit, its pitch, decay and
brightness) that the Pads instrument plays as a stand-in until the file has loaded.

  python3 -I tools/build_pad_kits.py --vcsl DIR --samplepi DIR --meadow DIR
(checkouts; only the files used are read). Writes instruments/pads/<kit>/<pad>.mp3 and the block between the
'// <kits>' and '// </kits>' lines of instruments/pads.js.
"""
from __future__ import annotations

import argparse
import array
import json
import math
import random
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'instruments' / 'pads'
PADS_JS = ROOT / 'instruments' / 'pads.js'
SR = 44100

VC = 'vcsl'
PI = 'samplepi'
ML = 'meadow'
ST = 'studio'
S = 'Idiophones/Struck Idiophones/'
M = 'Membranophones/Struck Membranophones/'
P = 'drums/one-shots/'


def f(src: str, path: str, name: str, kind: str = '', secs: float = 1.0, gain: float = 0, tune: float = 0, choke: int = 0, fx: str = '') -> dict:
    return {'src': src, 'path': path, 'name': name, 'kind': kind, 'secs': secs, 'gain': gain, 'tune': tune, 'choke': choke, 'fx': fx}


def chop(src: str, path: str) -> dict:
    return {'chop': (src, path)}


DUSTY = 'asetrate=44100*0.89,aresample=44100,lowpass=f=4200,acrusher=bits=9:mode=log:aa=1:mix=0.6,asoftclip=type=tanh'
KITS: list[tuple[str, str, str, list[dict]]] = [
    ('hands', 'Hand Drums', 'VCSL (CC0)', [
        f(VC, M + 'Conga/Tumba_HitN_v3_rr1_Sum.wav', 'Tumba', 'tom', 0.9), f(VC, M + 'Conga/Conga_HitN_v3_rr1_Sum.wav', 'Conga', 'tom', 0.8),
        f(VC, M + 'Conga/Quinto_HitN_v3_rr1_Sum.wav', 'Quinto', 'tom', 0.7), f(VC, M + 'Conga/Conga_HitFM_v2_rr1_Sum.wav', 'Conga mute', 'tom', 0.3),
        f(VC, M + 'Bongos/BongoL_Hit1_v3_rr1_Mid.wav', 'Bongo lo', 'tom', 0.5), f(VC, M + 'Bongos/BongoH_Hit1_v3_rr1_Mid.wav', 'Bongo hi', 'tom', 0.4),
        f(VC, M + 'Bongos/BongoH_HitMuted1_v3_rr1_Mid.wav', 'Bongo mute', 'click', 0.25), f(VC, S + 'Cajon/Cajon_hit1_f_rr1.wav', 'Cajon bass', 'kick', 0.6),
        f(VC, S + 'Cajon/Cajon_hit2_f_rr1.wav', 'Cajon slap', 'snare', 0.4), f(VC, S + 'Cajon/Cajon_hit3_f_rr1.wav', 'Cajon tip', 'snare', 0.3),
        f(VC, M + 'Darbuka/Darbuka_1_hit_vl2_rr1.wav', 'Doum', 'tom', 0.7), f(VC, M + 'Darbuka/Darbuka_3_hit_vl2_rr1.wav', 'Tek', 'click', 0.3),
        f(VC, M + 'Darbuka/Darbuka_5_hit_vl2_rr1.wav', 'Ka', 'click', 0.3), f(VC, M + 'Frame Drum/HDrumL_Hit_v3_rr1_Sum.wav', 'Frame lo', 'tom', 0.9),
        f(VC, M + 'Frame Drum/HDrumS_Hit_v3_rr1_Sum.wav', 'Frame hi', 'tom', 0.7), f(VC, M + 'Frame Drum/HDrumL_HitMuted_v3_rr1_Sum.wav', 'Frame mute', 'click', 0.3),
    ]),
    ('shakers', 'Shakers & Bells', 'VCSL (CC0)', [
        f(VC, S + 'Shaker, Small/Mid_ShakerDouble_Down_rr1.wav', 'Shake down', 'hat', 0.35), f(VC, S + 'Shaker, Small/Mid_ShakerDouble_Up_rr1.wav', 'Shake up', 'hat', 0.35),
        f(VC, S + 'Shaker, Small/Mid_Shaker_Slap_rr1.wav', 'Shaker slap', 'hat', 0.3), f(VC, S + 'Cabasa/Cabasa1_Hit_rr1_Mid.wav', 'Cabasa', 'hat', 0.3),
        f(VC, S + 'Tambourine 1/Tamb1_Hit_v2_rr1_Mid.wav', 'Tambourine', 'hat', 0.6), f(VC, S + 'Tambourine 1/Tamb1_Shake_rr1_Mid.wav', 'Tamb shake', 'hat', 0.8),
        f(VC, S + 'Guiro/Guiro_Hit_rr1_Mid.wav', 'Guiro', 'hat', 0.4), f(VC, S + 'Guiro/Guiro_Fast_rr1_Mid.wav', 'Guiro scrape', 'hat', 0.8),
        f(VC, S + 'Claves/Claves1_Hit_v3_rr1_Mid.wav', 'Claves', 'click', 0.3), f(VC, S + 'Woodblock/wood_click_f_rr1.wav', 'Woodblock', 'click', 0.3),
        f(VC, S + 'Agogo Bells/Agogo_Low_v2_rr1_Mid.wav', 'Agogo lo', 'tone', 0.7), f(VC, S + 'Agogo Bells/Agogo_High_v2_rr1_Mid.wav', 'Agogo hi', 'tone', 0.7),
        f(VC, S + 'Cowbells/Cowbell1_Normal_v3_rr1_Mid.wav', 'Cowbell', 'tone', 0.6), f(VC, S + 'Cowbells/Cowbell2_Muted_v3_rr1_Mid.wav', 'Cowbell mute', 'tone', 0.25),
        f(VC, S + 'Triangles/Triangle1_Hit_v2_rr1_Mid.wav', 'Triangle', 'tone', 1.8, choke=1), f(VC, S + 'Triangles/Triangle1_HitM_v1_rr2_Mid.wav', 'Triangle mute', 'tone', 0.2, choke=1),
    ]),
    ('orchestra', 'Orchestral', 'VCSL (CC0)', [
        f(VC, M + 'Bass Drum 2/bassdrum_hit_f.wav', 'Bass drum', 'kick', 2.0), f(VC, M + 'Snare Drum, Modern 1/Snare2_HitSN_v7_rr1_Mid.wav', 'Snare', 'snare', 0.7),
        f(VC, M + 'Snare Drum, Rope Tension/RopeSnare_stick_Main_vl1_rr1.wav', 'Rope snare', 'snare', 0.6), f(VC, M + 'Snare Drum, Modern 1/Snare2_HitNS_v6_rr1_Mid.wav', 'Snares off', 'tom', 0.6),
        f(VC, M + 'Timpani 1/Hit/Timpani1_Hit_v4_rr1_Sum.wav', 'Timpani 1', 'tom', 2.0), f(VC, M + 'Timpani 1/Hit/Timpani3_Hit_v4_rr1_Sum.wav', 'Timpani 2', 'tom', 2.0),
        f(VC, M + 'Timpani 1/Hit/Timpani5_Hit_v4_rr1_Sum.wav', 'Timpani 3', 'tom', 2.0), f(VC, M + 'Tom 1/Mallet/TomH_HitM_v4_rr1_Mid.wav', 'Tom', 'tom', 1.0),
        f(VC, S + 'Suspended Cymbal 1/susCymb1_hit_f1.wav', 'Cymbal', 'hat', 3.0, choke=2), f(VC, S + 'Suspended Cymbal 1/susCymb1_hit_bell_mf1.wav', 'Cymbal bell', 'tone', 2.0, choke=2),
        f(VC, S + 'Gong 1/gong_mf.wav', 'Gong', 'tone', 3.0), f(VC, S + 'Triangles/Triangle3_Hit_v1_rr1_Mid.wav', 'Triangle', 'tone', 2.0),
        f(VC, S + 'Tambourine 1/Tamb1_Hit_v1_rr1_Mid.wav', 'Tambourine', 'hat', 0.6), f(VC, S + 'Woodblock/wood_click_mp.wav', 'Woodblock', 'click', 0.3),
        f(VC, S + 'Vibraslap/Legacy/vibraslap_rr1.wav', 'Vibraslap', 'hat', 1.4), f(VC, S + 'Mark Trees/Legacy/windchimes_desc1.wav', 'Chimes', 'hat', 2.5),
    ]),
    ('junkyard', 'Junkyard', 'VCSL (CC0)', [
        f(VC, S + 'Slit Drum/LogDrumLo_MedM_v3_rr1_Sum.wav', 'Log lo', 'tom', 0.8), f(VC, S + 'Slit Drum/LogDrumHi_MedM_v3_rr1_Sum.wav', 'Log hi', 'tom', 0.7),
        f(VC, S + 'Brake Drum/BrakeDrum1_Hammer_v3_rr1_Mid.wav', 'Brake drum', 'tone', 1.2), f(VC, S + 'Brake Drum/BrakeDrum2_Hammer3_v3_rr1_Mid.wav', 'Brake drum 2', 'tone', 1.2),
        f(VC, S + 'Anvil/Anvil_Hit1_v3_rr1_Mid.wav', 'Anvil', 'tone', 1.4), f(VC, S + 'Anvil/Anvil_Hit2_v3_rr1_Mid.wav', 'Anvil 2', 'tone', 1.4),
        f(VC, S + 'Anvil/Anvil_Hit3_v2_rr1_Mid.wav', 'Anvil tap', 'tone', 0.8), f(VC, S + 'Brake Drum/BrakeDrum1_YarnM_v3_rr1_Mid.wav', 'Brake soft', 'tone', 1.0),
        f(VC, S + 'Cowbells/Cowbell2_Double_v3_rr1_Mid.wav', 'Double bell', 'tone', 0.8), f(VC, S + 'Cowbells/Cowbell1_Muted_v3_rr1_Mid.wav', 'Clank', 'tone', 0.25),
        f(PI, P + 'percussion/perc_door.flac', 'Door', 'kick', 0.9), f(PI, P + 'percussion/perc_impact1.flac', 'Impact', 'kick', 1.0),
        f(PI, P + 'percussion/perc_till.flac', 'Till', 'tone', 1.2), f(PI, P + 'percussion/perc_snap.flac', 'Snap', 'click', 0.3),
        f(VC, S + 'Gong 1/gong_scrape_mf.wav', 'Scrape', 'hat', 2.0), f(VC, S + 'Suspended Cymbal 1/susCymb1_hit_stick_f1.wav', 'Trash', 'hat', 1.5),
    ]),
    ('sonic', 'Sonic Kit', 'Sample Pi (CC0)', [
        f(PI, P + 'kick/drum_heavy_kick.flac', 'Kick', 'kick', 0.8), f(PI, P + 'snare/drum_snare_hard.flac', 'Snare', 'snare', 0.6),
        f(PI, P + 'snare/drum_snare_soft.flac', 'Snare soft', 'snare', 0.5), f(PI, P + 'kick/drum_bass_soft.flac', 'Kick soft', 'kick', 0.6),
        f(PI, P + 'cymbal/drum_cymbal_closed.flac', 'Hat', 'hat', 0.25, choke=1), f(PI, P + 'cymbal/drum_cymbal_pedal.flac', 'Foot', 'hat', 0.3, choke=1),
        f(PI, P + 'cymbal/drum_cymbal_open.flac', 'Open', 'hat', 1.2, choke=1), f(PI, P + 'cymbal/drum_cymbal_soft.flac', 'Ride', 'hat', 2.0),
        f(PI, P + 'tom/drum_tom_lo_hard.flac', 'Lo tom', 'tom', 0.9), f(PI, P + 'tom/drum_tom_mid_hard.flac', 'Mid tom', 'tom', 0.8),
        f(PI, P + 'tom/drum_tom_hi_hard.flac', 'Hi tom', 'tom', 0.7), f(PI, P + 'cymbal/drum_cymbal_hard.flac', 'Crash', 'hat', 2.5),
        f(PI, P + 'other/drum_splash_hard.flac', 'Splash', 'hat', 1.5), f(PI, P + 'other/drum_cowbell.flac', 'Cowbell', 'tone', 0.5),
        f(PI, P + 'kick/drum_bass_hard.flac', 'Kick hard', 'kick', 0.7), f(PI, P + 'other/drum_roll.flac', 'Roll', 'snare', 1.5),
    ]),
    ('electro', 'Electro', 'Sample Pi (CC0)', [
        f(PI, P + 'kick/elec_soft_kick.flac', 'Kick', 'kick', 0.5), f(PI, P + 'snare/elec_snare.flac', 'Snare', 'snare', 0.4),
        f(PI, P + 'snare/elec_hi_snare.flac', 'Hi snare', 'snare', 0.3), f(PI, P + 'kick/elec_hollow_kick.flac', 'Hollow kick', 'kick', 0.5),
        f(PI, P + 'cymbal/elec_cymbal.flac', 'Cymbal', 'hat', 0.8), f(PI, P + 'electric/elec_tick.flac', 'Tick', 'click', 0.15),
        f(PI, P + 'electric/elec_triangle.flac', 'Triangle', 'tone', 0.6), f(PI, P + 'snare/elec_filt_snare.flac', 'Filter snare', 'snare', 0.6),
        f(PI, P + 'electric/elec_fuzz_tom.flac', 'Fuzz tom', 'tom', 0.5), f(PI, P + 'electric/elec_wood.flac', 'Wood', 'click', 0.3),
        f(PI, P + 'electric/elec_pop.flac', 'Pop', 'click', 0.2), f(PI, P + 'electric/elec_bong.flac', 'Bong', 'tone', 0.6),
        f(PI, P + 'electric/elec_blip.flac', 'Blip', 'tone', 0.3), f(PI, P + 'electric/elec_ping.flac', 'Ping', 'tone', 0.6),
        f(PI, P + 'electric/elec_twang.flac', 'Twang', 'tone', 0.7), f(PI, P + 'electric/elec_chime.flac', 'Chime', 'tone', 1.2),
    ]),
    ('clubkicks', 'Club', 'Sample Pi and Meadowlark (CC0)', [
        f(PI, P + 'kick/bd_haus.flac', 'Haus kick', 'kick', 0.6), f(PI, P + 'snare/sn_dolf.flac', 'Snare', 'snare', 0.5),
        f(VC, S + 'Claps/Clap_rr1.wav', 'Clap', 'snare', 0.5), f(PI, P + 'kick/bd_klub.flac', 'Klub kick', 'kick', 0.6),
        f(VC, S + 'Hi-Hat Cymbal/HiHat_HitC_v3_rr1_Mid.wav', 'Hat', 'hat', 0.2, choke=1), f(VC, S + 'Hi-Hat Cymbal/HiHat_HitLoose_rr1_Mid.wav', 'Loose hat', 'hat', 0.5, choke=1),
        f(VC, S + 'Hi-Hat Cymbal/HiHat_HitO_rr1_Mid.wav', 'Open hat', 'hat', 1.0, choke=1), f(PI, P + 'snare/sn_zome.flac', 'Snare 2', 'snare', 0.5),
        f(ML, 'Drums - One Shot/Kicks/Deep/Kickmess Deep 3.wav', 'Deep kick', 'kick', 0.9), f(ML, 'Drums - One Shot/Kicks/Snappy/Kickmess Snappy 2.wav', 'Snappy kick', 'kick', 0.5),
        f(ML, 'Drums - One Shot/Kicks/Distorted/Kickmess Distorted 1.wav', 'Dirty kick', 'kick', 0.7), f(PI, P + 'kick/bd_tek.flac', 'Tek kick', 'kick', 0.5),
        f(PI, P + 'kick/bd_zum.flac', 'Zum kick', 'kick', 0.7), f(PI, P + 'snare/sn_dub.flac', 'Dub snare', 'snare', 0.9),
        f(VC, S + 'Claps/SoloClap_vl3.wav', 'Solo clap', 'snare', 0.3), f(PI, P + 'kick/bd_boom.flac', 'Boom', 'kick', 1.5),
    ]),
    ('tabla', 'Tabla', 'Sample Pi (CC0)', [
        f(PI, P + 'tabla/tabla_ghe1.flac', 'Ghe', 'tom', 0.8), f(PI, P + 'tabla/tabla_na.flac', 'Na', 'tone', 0.6),
        f(PI, P + 'tabla/tabla_tun1.flac', 'Tun', 'tone', 0.9), f(PI, P + 'tabla/tabla_te1.flac', 'Te', 'click', 0.3),
        f(PI, P + 'tabla/tabla_ke1.flac', 'Ke', 'click', 0.3), f(PI, P + 'tabla/tabla_tas1.flac', 'Tas', 'tone', 0.5),
        f(PI, P + 'tabla/tabla_dhec.flac', 'Dhec', 'tom', 0.6), f(PI, P + 'tabla/tabla_re.flac', 'Re', 'click', 0.3),
        f(PI, P + 'tabla/tabla_ghe4.flac', 'Ghe 2', 'tom', 0.8), f(PI, P + 'tabla/tabla_na_o.flac', 'Na open', 'tone', 0.8),
        f(PI, P + 'tabla/tabla_tun3.flac', 'Tun 2', 'tone', 0.9), f(PI, P + 'tabla/tabla_te_ne.flac', 'Te ne', 'click', 0.4),
        f(PI, P + 'tabla/tabla_ghe8.flac', 'Ghe slide', 'tom', 1.0), f(PI, P + 'tabla/tabla_na_s.flac', 'Na short', 'tone', 0.4),
        f(PI, P + 'tabla/tabla_ke3.flac', 'Ke 2', 'click', 0.3), f(PI, P + 'tabla/tabla_te_m.flac', 'Te muted', 'click', 0.3),
    ]),
    ('glitch', 'Glitch', 'Sample Pi (CC0)', [
        f(PI, P + 'glitchy/glitch_bass_g.flac', 'Bass G', 'kick', 0.8), f(PI, P + 'glitchy/glitch_perc1.flac', 'Perc 1', 'snare', 0.4),
        f(PI, P + 'glitchy/glitch_perc2.flac', 'Perc 2', 'snare', 0.4), f(PI, P + 'glitchy/glitch_perc3.flac', 'Perc 3', 'click', 0.4),
        f(PI, P + 'glitchy/glitch_perc4.flac', 'Perc 4', 'click', 0.4), f(PI, P + 'glitchy/glitch_perc5.flac', 'Perc 5', 'click', 0.4),
        f(PI, P + 'glitchy/glitch_robot1.flac', 'Robot', 'tone', 0.8), f(PI, P + 'glitchy/glitch_robot2.flac', 'Robot 2', 'tone', 0.8),
        f(PI, P + 'mehackit/mehackit_robot1.flac', 'Bot 1', 'tone', 0.6), f(PI, P + 'mehackit/mehackit_robot2.flac', 'Bot 2', 'tone', 0.6),
        f(PI, P + 'mehackit/mehackit_robot3.flac', 'Bot 3', 'tone', 0.6), f(PI, P + 'mehackit/mehackit_robot4.flac', 'Bot 4', 'tone', 0.6),
        f(PI, P + 'mehackit/mehackit_phone1.flac', 'Dial 1', 'tone', 0.5), f(PI, P + 'mehackit/mehackit_phone2.flac', 'Dial 2', 'tone', 0.5),
        f(PI, P + 'electric/elec_blup.flac', 'Blup', 'tone', 0.3), f(PI, P + 'electric/elec_flip.flac', 'Flip', 'tone', 0.3),
    ]),
    ('breaks', 'Break chops', 'Sample Pi: a breakbeat by Snapper4298 (CC0)', [chop(PI, 'drums/loops/loop_breakbeat.flac')]),
    ('safari', 'Safari chops', 'Sample Pi: a percussion loop by nemaavla (CC0)', [chop(PI, 'drums/loops/loop_safari.flac')]),
    ('tablaloop', 'Tabla chops', 'Sample Pi: a tabla loop by lezaarth (CC0)', [chop(PI, 'drums/loops/loop_tabla.flac')]),
    ('dusty', 'Dusty', 'the Studio Kit, slowed, filtered and crushed', [
        f(ST, 'kick_3_1.mp3', 'Kick', 'kick', 0.8, fx=DUSTY), f(ST, 'snare_4.mp3', 'Snare', 'snare', 0.7, fx=DUSTY),
        f(ST, 'xstick_2.mp3', 'Stick', 'click', 0.4, fx=DUSTY), f(ST, 'rimshot_2.mp3', 'Rim', 'snare', 0.6, fx=DUSTY),
        f(ST, 'hhclosed_3_1.mp3', 'Hat', 'hat', 0.3, choke=1, fx=DUSTY), f(ST, 'hhpedal_2.mp3', 'Foot', 'hat', 0.3, choke=1, fx=DUSTY),
        f(ST, 'hhopen_2.mp3', 'Open', 'hat', 1.0, choke=1, fx=DUSTY), f(ST, 'ride_2_1.mp3', 'Ride', 'hat', 1.8, fx=DUSTY),
        f(ST, 'tomlo_2.mp3', 'Lo tom', 'tom', 1.0, fx=DUSTY), f(ST, 'tomhi_2.mp3', 'Hi tom', 'tom', 0.9, fx=DUSTY),
        f(ST, 'crash_2.mp3', 'Crash', 'hat', 2.5, fx=DUSTY), f(ST, 'bell_2.mp3', 'Bell', 'tone', 1.2, fx=DUSTY),
        f(ST, 'kick_1_1.mp3', 'Soft kick', 'kick', 0.7, gain=2, fx=DUSTY), f(ST, 'snare_1.mp3', 'Ghost', 'snare', 0.5, gain=4, fx=DUSTY),
        f(VC, S + 'Claps/Clap_rr3.wav', 'Clap', 'snare', 0.5, fx=DUSTY), f(VC, S + 'Shaker, Small/Mid_ShakerDouble_Down_rr2.wav', 'Shaker', 'hat', 0.3, fx=DUSTY),
    ]),
    ('boombox', 'Boom Box', 'synthesized by MEGAjam', [{'synth': n} for n in ('kick', 'snare', 'clap', 'rim', 'hat', 'pedal', 'open', 'cymbal', 'tomlo', 'tommid', 'tomhi', 'cowbell', 'boom', 'clave', 'shaker', 'zap')]),
    ('kalimba', 'Kalimba', 'VCSL (CC0): a Kenyan kalimba, one key per pad', 'kalimba'),
    ('mallets', 'Mallets', 'VCSL (CC0): marimba and glockenspiel notes', [
        f(VC, S + 'Marimba/Marimba_hit_Outrigger_F1_loud_01.wav', 'Marimba F1', 'tone', 2.0), f(VC, S + 'Marimba/Marimba_hit_Outrigger_C2_loud_01.wav', 'Marimba C2', 'tone', 1.8),
        f(VC, S + 'Marimba/Marimba_hit_Outrigger_G2_loud_01.wav', 'Marimba G2', 'tone', 1.6), f(VC, S + 'Marimba/Marimba_hit_Outrigger_B2_loud_01.wav', 'Marimba B2', 'tone', 1.5),
        f(VC, S + 'Marimba/Marimba_hit_Outrigger_F3_loud_01.wav', 'Marimba F3', 'tone', 1.3), f(VC, S + 'Marimba/Marimba_hit_Outrigger_C4_loud_01.wav', 'Marimba C4', 'tone', 1.1),
        f(VC, S + 'Marimba/Marimba_hit_Outrigger_G4_loud_01.wav', 'Marimba G4', 'tone', 1.0), f(VC, S + 'Marimba/Marimba_hit_Outrigger_B4_loud_01.wav', 'Marimba B4', 'tone', 0.9),
        f(VC, S + 'Marimba/Marimba_hit_Outrigger_F5_loud_01.wav', 'Marimba F5', 'tone', 0.8), f(VC, S + 'Marimba/Marimba_hit_Outrigger_C6_loud_01.wav', 'Marimba C6', 'tone', 0.7),
        f(VC, S + 'Glockenspiel/glock_medium_G4_01.wav', 'Glock G4', 'tone', 1.6), f(VC, S + 'Glockenspiel/glock_medium_C5_01.wav', 'Glock C5', 'tone', 1.6),
        f(VC, S + 'Glockenspiel/glock_medium_G5_01.wav', 'Glock G5', 'tone', 1.5), f(VC, S + 'Glockenspiel/glock_medium_C6_01.wav', 'Glock C6', 'tone', 1.4),
        f(VC, S + 'Glockenspiel/glock_medium_G6_01.wav', 'Glock G6', 'tone', 1.3), f(VC, S + 'Glockenspiel/glock_medium_C7_01.wav', 'Glock C7', 'tone', 1.2),
    ]),
]


# ---------- audio in and out ----------
def decode(path: Path, fx: str = '') -> list[float]:
    cmd = ['ffmpeg', '-v', 'error', '-i', str(path), '-ac', '1', '-ar', str(SR)]
    if fx:
        cmd += ['-af', fx]
    cmd += ['-f', 'f32le', '-']
    raw = subprocess.run(cmd, check=True, capture_output=True).stdout
    a = array.array('f'); a.frombytes(raw)
    return list(a)


def encode(x: list[float], out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    a = array.array('f', x)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(SR), '-ac', '1', '-i', '-', '-c:a', 'libmp3lame', '-b:a', '96k', str(out)], input=a.tobytes(), check=True)


def env(x: list[float], hop: int = 441) -> list[float]:
    return [math.sqrt(sum(v * v for v in x[i:i + hop]) / hop) if i + hop <= len(x) else 0.0 for i in range(0, len(x), hop)]


def trim(x: list[float], secs: float, pre: float = 0.002) -> list[float]:
    pk = max((abs(v) for v in x), default=0.0)
    if pk < 1e-6:
        return x[: int(SR * 0.05)]
    i0 = next(i for i, v in enumerate(x) if abs(v) > pk * 0.03)
    i0 = max(0, i0 - int(pre * SR))
    y = x[i0: i0 + int(secs * SR)]
    # end where it has died away (-50 dB of the peak, in 10 ms steps), then fade the last part
    e = env(y); top = max(e) or 1.0
    last = max((k for k, v in enumerate(e) if v > top * 0.003), default=len(e) - 1)
    y = y[: min(len(y), (last + 2) * 441)]
    n = len(y); fade = max(int(0.01 * SR), int(n * 0.2))
    for k in range(fade):
        y[n - fade + k] *= 0.5 + 0.5 * math.cos(math.pi * (k + 1) / fade)
    for k in range(min(32, n)):   # no click at the start of a chop
        y[k] *= k / 32
    g = 10 ** (-6.0 / 20) / max(abs(v) for v in y)   # -6 dBFS: room for a few pads at once in the band's mix
    return [v * g for v in y]


def recipe(x: list[float], kind: str) -> dict:
    e = env(x); pk = max(e) or 1.0; ip = e.index(pk)
    end = next((k for k in range(ip, len(e)) if e[k] < pk * 0.1), len(e))
    r: dict = {'kind': kind or 'snare', 'decay': round(max(0.02, (end - ip) * 0.01), 3)}
    a = x[int(0.005 * SR): int(0.055 * SR)]
    zc = sum(1 for i in range(1, len(a)) if (a[i - 1] < 0) != (a[i] < 0)) / max(1, len(a)) * SR / 2
    r['bright'] = round(min(1.0, zc / 6000), 2)
    if r['kind'] in ('kick', 'tom', 'tone'):
        # the pitch: autocorrelation on a 4x decimated window after the attack, first lag near the best
        d = x[int(0.012 * SR):: 4][:1024]; sr4 = SR / 4
        if len(d) > 200:
            lo, hi = int(sr4 / 1500), min(len(d) - 1, int(sr4 / 30))
            c = [sum(d[i] * d[i + L] for i in range(len(d) - L)) / (len(d) - L) for L in range(lo, hi)]
            k0 = next((k for k, v in enumerate(c) if v < 0), None)   # past the first dip: short lags always correlate
            if k0 is not None and max(c[k0:]) > 0:
                best = max(c[k0:])
                L = next(k for k in range(k0, len(c)) if c[k] >= best * 0.9) + lo
                r['f'] = round(sr4 / L, 1)
    return r


# ---------- chops: a loop cut at its hits ----------
def chops(x: list[float], n: int = 16) -> list[list[float]]:
    hop = 256
    e = [math.log(1e-6 + sum(v * v for v in x[i:i + hop])) for i in range(0, len(x) - hop, hop)]
    flux = [max(0.0, e[i] - max(e[max(0, i - 3):i])) for i in range(1, len(e))]   # a rise over the last few hops
    gap, top = int(0.09 * SR / hop), max(flux)
    peaks = [i for i in range(1, len(flux) - 1) if flux[i] >= flux[i - 1] and flux[i] > flux[i + 1] and flux[i] > top * 0.3]
    peaks.sort(key=lambda i: -flux[i])
    chosen: list[int] = []
    for i in peaks:
        if all(abs(i - j) > gap for j in chosen):
            chosen.append(i)
        if len(chosen) == n:
            break
    chosen.sort()
    if len(chosen) < n * 3 // 4:   # too few clear hits (a short, busy loop): sixteen even slices, the 16ths of one bar
        step = len(x) // n
        return [x[k * step:(k + 1) * step] for k in range(n)]
    at = [max(0, (i + 1) * hop - int(0.004 * SR)) for i in chosen]
    return [x[a: (at[k + 1] if k + 1 < len(at) else min(len(x), a + int(1.2 * SR)))] for k, a in enumerate(at)]


# ---------- the Boom Box: drum sounds made here ----------
class Biquad:
    def __init__(self, kind: str, fc: float, q: float = 0.7) -> None:
        w = 2 * math.pi * fc / SR; al = math.sin(w) / (2 * q); c = math.cos(w)
        if kind == 'lp':
            b = [(1 - c) / 2, 1 - c, (1 - c) / 2]
        elif kind == 'hp':
            b = [(1 + c) / 2, -(1 + c), (1 + c) / 2]
        else:
            b = [al, 0.0, -al]
        a0 = 1 + al
        self.b = [v / a0 for v in b]; self.a = [-2 * c / a0, (1 - al) / a0]; self.z = [0.0, 0.0, 0.0, 0.0]

    def __call__(self, v: float) -> float:
        x1, x2, y1, y2 = self.z
        y = self.b[0] * v + self.b[1] * x1 + self.b[2] * x2 - self.a[0] * y1 - self.a[1] * y2
        self.z = [v, x1, y, y1]
        return y


def synth(name: str) -> tuple[list[float], str, int]:
    rnd = random.Random(sum(map(ord, name)))
    noise = lambda: rnd.uniform(-1, 1)  # noqa: E731
    out: list[float] = []

    def drum(f0: float, f1: float, sweep: float, dec: float, secs: float, click: float = 0.3, drive: float = 1.0) -> list[float]:
        ph, y = 0.0, []
        for i in range(int(secs * SR)):
            t = i / SR; fr = f1 + (f0 - f1) * math.exp(-t / sweep); ph += 2 * math.pi * fr / SR
            v = math.sin(ph) * math.exp(-t / dec) + click * noise() * math.exp(-t / 0.002)
            y.append(math.tanh(v * drive))
        return y

    def metal(dec: float, secs: float, hp: float = 7000) -> list[float]:
        fs = [205.3, 304.4, 369.6, 522.7, 540.0, 800.0]   # six detuned square waves: a metallic cluster
        bp, hpf, y = Biquad('bp', 9000, 1.2), Biquad('hp', hp), []
        for i in range(int(secs * SR)):
            t = i / SR; v = sum(1.0 if math.sin(2 * math.pi * fq * t) > 0 else -1.0 for fq in fs) / 6
            y.append(hpf(bp(v)) * math.exp(-t / dec) * 2.2)
        return y

    kind, choke = 'snare', 0
    if name == 'kick':
        out, kind = drum(160, 48, 0.035, 0.32, 0.8, 0.4, 1.6), 'kick'
    elif name == 'boom':
        out, kind = drum(110, 42, 0.06, 0.9, 1.6, 0.2, 2.2), 'kick'
    elif name in ('tomlo', 'tommid', 'tomhi'):
        f = {'tomlo': 90, 'tommid': 130, 'tomhi': 185}[name]
        out, kind = drum(f * 1.8, f, 0.05, 0.28, 0.8, 0.15), 'tom'
    elif name == 'snare':
        bp, ph = Biquad('hp', 1500), 0.0
        for i in range(int(0.45 * SR)):
            t = i / SR; ph += 2 * math.pi * (180 + 80 * math.exp(-t / 0.01)) / SR
            out.append(0.6 * math.sin(ph) * math.exp(-t / 0.06) + 0.8 * bp(noise()) * math.exp(-t / 0.13))
    elif name == 'clap':
        bp = Biquad('bp', 1100, 1.8)
        for i in range(int(0.5 * SR)):
            t = i / SR; e = sum(math.exp(-(t - k * 0.011) / 0.005) for k in range(3) if t >= k * 0.011) + 0.6 * (math.exp(-(t - 0.033) / 0.12) if t > 0.033 else 0)
            out.append(bp(noise()) * e * 2.5)
    elif name == 'rim':
        bp = Biquad('bp', 1700, 4)
        for i in range(int(0.12 * SR)):
            t = i / SR; out.append(bp(noise() + 3 * math.sin(2 * math.pi * 1700 * t)) * math.exp(-t / 0.012) * 2)
        kind = 'click'
    elif name == 'clave':
        out, kind = [math.sin(2 * math.pi * 2500 * i / SR) * math.exp(-i / SR / 0.035) for i in range(int(0.2 * SR))], 'click'
    elif name in ('hat', 'pedal', 'open', 'cymbal'):
        dec, secs = {'hat': (0.035, 0.25), 'pedal': (0.05, 0.3), 'open': (0.3, 1.2), 'cymbal': (0.9, 2.5)}[name]
        out, kind, choke = metal(dec, secs, 5000 if name == 'cymbal' else 7000), 'hat', 0 if name == 'cymbal' else 1
    elif name == 'cowbell':
        bp = Biquad('bp', 700, 2)
        for i in range(int(0.6 * SR)):
            t = i / SR; v = (1.0 if math.sin(2 * math.pi * 540 * t) > 0 else -1.0) + (1.0 if math.sin(2 * math.pi * 800 * t) > 0 else -1.0)
            out.append(bp(v) * (0.7 * math.exp(-t / 0.02) + 0.3 * math.exp(-t / 0.25)) * 2)
        kind = 'tone'
    elif name == 'shaker':
        hp = Biquad('hp', 6000)
        for i in range(int(0.2 * SR)):
            t = i / SR; out.append(hp(noise()) * min(1.0, t / 0.015) * math.exp(-t / 0.045) * 2)
        kind = 'hat'
    elif name == 'zap':
        ph = 0.0
        for i in range(int(0.35 * SR)):
            t = i / SR; ph += 2 * math.pi * (90 + 2400 * math.exp(-t / 0.025)) / SR; out.append(math.sin(ph) * math.exp(-t / 0.1))
        kind = 'tone'
    return out, kind, choke


NAMES = {'kick': 'Kick', 'snare': 'Snare', 'clap': 'Clap', 'rim': 'Rim', 'hat': 'Hat', 'pedal': 'Foot', 'open': 'Open', 'cymbal': 'Cymbal', 'tomlo': 'Lo tom',
         'tommid': 'Mid tom', 'tomhi': 'Hi tom', 'cowbell': 'Cowbell', 'boom': 'Boom', 'clave': 'Clave', 'shaker': 'Shaker', 'zap': 'Zap'}


def build(roots: dict[str, Path]) -> None:
    kits = []
    for kid, title, source, spec in KITS:
        pads: list[dict | None] = []
        files: list[tuple[list[float], str, str, dict]] = []
        if spec == 'kalimba':
            d = roots[VC] / 'Idiophones/Plucked Idiophones/Kalimba, Kenya'
            order = 'C C# D D# E F F# G G# A A# B'.split()
            def midi(fn: str) -> int:
                nm = fn.split('Spirit_')[1].split('_')[0]; return order.index(nm[:-1]) + 12 * (int(nm[-1]) + 1)
            notes = sorted({midi(p.name): p for p in d.glob('*.wav')}.items())
            # its keys low to high, then the lowest keys again an octave up (tuned on the pad) to fill sixteen pads
            ups = [(n + 12, p, 12) for n, p in notes]
            # (named by place, not note: the file names' octaves don't match what the keys sound)
            for k, (n, p, up) in enumerate(([(n, p, 0) for n, p in notes] + ups)[:16]):
                x = trim(decode(p), 2.5); files.append((x, f'Key {k + 1}', 'tone', {'tune': up}))
        elif len(spec) == 1 and 'chop' in spec[0]:
            src, path = spec[0]['chop']
            for k, x in enumerate(chops(decode(roots[src] / path))):
                files.append((trim(x, 1.2, pre=0.0), f'Chop {k + 1}', '', {}))
        else:
            for it in spec:
                if 'synth' in it:
                    x, kind, choke = synth(it['synth']); files.append((trim(x, 2.5), NAMES[it['synth']], kind, {'choke': choke, 'gain': -3}))
                    continue
                base = ROOT / 'instruments' / 'studio' if it['src'] == ST else roots[it['src']]
                x = trim(decode(base / it['path'], it['fx']), it['secs'])
                files.append((x, it['name'], it['kind'], {'gain': it['gain'], 'tune': it['tune'], 'choke': it['choke']}))
        for k, (x, name, kind, o) in enumerate(files[:16]):
            if not kind:   # a chop: what kind of hit, from how bright it is and how fast it dies
                r0 = recipe(x, 'snare'); kind = 'kick' if r0['bright'] < 0.12 else 'hat' if r0['bright'] > 0.45 else 'snare'
            out = OUT / kid / f'{k + 1:02d}.mp3'
            encode(x, out)
            pad = {'src': f'instruments/pads/{kid}/{k + 1:02d}.mp3', 'name': name, 'start': 0, 'end': 1, 'tune': o.get('tune', 0), 'gain': o.get('gain', 0), 'choke': o.get('choke', 0), 'recipe': recipe(x, kind)}
            pads.append(pad)
        while len(pads) < 16:
            pads.append(None)
        kits.append({'id': kid, 'name': title, 'source': source, 'pads': pads})
        print(f'{kid:10s} {sum(1 for p in pads if p)} pads  {sum((OUT / kid / f"{k + 1:02d}.mp3").stat().st_size for k in range(16) if pads[k]) // 1024} KB')
    credits = ['# Where the Pads kits come from', '', 'Built by `tools/build_pad_kits.py`. Every sound is CC0 / public domain, or made by MEGAjam; no credit is required, but here it is.', '',
               '- **VCSL**, the Versilian Community Sample Library by Versilian Studios and contributors, CC0 1.0: github.com/sgossner/VCSL',
               '- **Sample Pi**, the sounds of Sonic Pi gathered by alex-esc, all from freesound.org under CC0 1.0 (the freesound authors are listed in its README): github.com/alex-esc/sample-pi',
               '- **Meadowlark factory library** by BillyDM and contributors, CC0 1.0: github.com/BillyDM/meadowlark-factory-library',
               '- **Studio Kit**: MEGAjam\'s own kit, from Virtuosity Drums by Versilian Studios, CC0 1.0', '', '| Kit | Sounds from |', '|---|---|']
    credits += [f"| {k['name']} | {k['source']} |" for k in kits]
    (OUT / 'CREDITS.md').write_text('\n'.join(credits) + '\n')
    block = '// <kits> written by tools/build_pad_kits.py from CC0 / public-domain sounds (and some made here); not by hand\nconst KITS = ' + json.dumps(kits, separators=(',', ':')) + ';\n// </kits>'
    js = PADS_JS.read_text()
    a, b = js.index('// <kits>'), js.index('// </kits>') + len('// </kits>')
    PADS_JS.write_text(js[:a] + block + js[b:])


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--vcsl', type=Path, required=True); ap.add_argument('--samplepi', type=Path, required=True); ap.add_argument('--meadow', type=Path, required=True)
    a = ap.parse_args()
    build({VC: a.vcsl, PI: a.samplepi, ML: a.meadow})

# Hardware research

What MEGAjam knows about each hardware unit beyond its twin profile, gathered by research passes (makers' manuals and MIDI implementation documents, open-source editors such as KnobKraft-orm and Edisyn, Ctrlr panels) and kept here so `instruments/hardware.json` can be rebuilt and checked:

- `units-*.json`: catalogue entries for units added after the first list (twin profile: family, circuit, patch types, character), merged by `tools/add_units.py`.
- `midi-*.json`: per-unit MIDI facts for patch sharing (has MIDI, program change, how knob moves travel, the edit-buffer dump request and its reply, or a front-panel dump how-to), with a confidence (manual, secondary, guess) and sources.
- `setup-*.json`: the steps shown in My gear's Set up checklist, with confidence and sources.

`tools/merge_patch_specs.py` turns the MIDI facts and set-up steps into `hardware.json` (`dump`, `setup`). Only dumps read in a manual or a reliable secondary source, that load as the current sound (never into a saved slot), are used for automatic requests. None has been tried on every real unit.

To rebuild after adding research:

    python3 -I tools/add_units.py tools/hardware-research/units-*.json
    python3 -I tools/merge_patch_specs.py tools/hardware-research/midi-*.json tools/hardware-research/setup-*.json

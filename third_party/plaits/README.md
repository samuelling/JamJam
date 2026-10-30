# Plaits DSP (vendored)

The DSP behind MEGAjam's **Big Macro** instrument is **Plaits** by Émilie Gillet / Mutable Instruments, released under
the MIT license. The copyright and permission notice is at the top of every source file here and in
`stmlib/LICENSE`. MEGAjam does not use Mutable Instruments' module names or artwork for the instrument.

## Where it came from

- `plaits/dsp/`, `plaits/resources.{h,cc}`, `plaits/user_data.h`: https://github.com/pichenettes/eurorack
  at commit `f4cfa7697095a28d292bff758beb51deb49b5a86` (2026-10-12). The repository's README: "Code (STM32F
  projects): MIT license."
- `stmlib/` (`stmlib.h`, `LICENSE`, `dsp/`, `utils/`): https://github.com/pichenettes/stmlib at commit
  `e3bd7c9cc00e4364166f9905c0509b6ffd0535ec`, the commit that eurorack revision pins as its submodule.
- The Python table generators were left out. Nothing else was removed from the copied folders.

## What was changed

- `plaits/user_data.h` is replaced by a stub (marked in the file): the original reads custom wavetables, FM banks
  and waveshapes from the STM32's flash, which doesn't exist here, so every engine uses its built-in data.
- No DSP source was edited. The build defines `TEST`, which selects stmlib's portable C code instead of ARM
  assembly (saturation and square root).

## Ours, not from the upstream repositories

- `shim/`: the few C/C++ library pieces the DSP uses (`<algorithm>`'s min/max/copy/fill/sort, sin/cos/tan,
  fabs/sqrt, memcpy/memset), for a freestanding wasm32 build with no libc.
- `glue/macro_osc.cc`: six complete `plaits::Voice`s with a shared patch, per-voice trigger/level/note/pan,
  deterministic seeding of the random generator per note, and a block render into float buffers.

## Building

`tools/build_bigmacro.sh` (clang and wasm-ld, LLVM 15 or later) compiles everything into
`instruments/bigmacro.wasm` (about 360 KB) and writes its SHA-256 into `instruments/bigmacro.js`.
Plaits runs at 48 kHz in 12-sample blocks; the instrument's AudioWorklet resamples when the audio context runs at
another rate, and corrects the module's tuning (it is tuned for its hardware's 47,872 Hz clock).

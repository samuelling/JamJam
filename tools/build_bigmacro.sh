#!/usr/bin/env bash
# Builds instruments/bigmacro.wasm: the Plaits DSP (Emilie Gillet / Mutable Instruments, MIT; vendored in
# third_party/plaits) plus our glue, for a freestanding wasm32 target (no emscripten, no libc). Needs clang and
# wasm-ld (LLVM 15 or later). Then writes the wasm's SHA-256 into instruments/bigmacro.js, so the instrument's
# version hash (what the app compares between jammers) changes whenever the DSP does.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=third_party/plaits
OUT=instruments/bigmacro.wasm
CXX=${CXX:-clang}
LD=${LD:-wasm-ld}
OBJ=$(mktemp -d)
trap 'rm -rf "$OBJ"' EXIT
FLAGS=(--target=wasm32 -O3 -msimd128 -ffreestanding -nostdlib -nostdinc++ -fno-exceptions -fno-rtti -fno-threadsafe-statics
  -fvisibility=hidden -ffunction-sections -fdata-sections -std=c++14 -DTEST -I"$SRC/shim" -I"$SRC"
  -Wno-unused-private-field -Wno-deprecated-register -Wno-unused-variable -Wno-unused-parameter -Wno-unused-but-set-variable -Wno-shift-negative-value)
FILES=$(cd "$SRC" && find plaits/dsp -name '*.cc' | sort; echo plaits/resources.cc stmlib/utils/random.cc stmlib/dsp/units.cc glue/macro_osc.cc)
pids=()
for f in $FILES; do
  "$CXX" "${FLAGS[@]}" -c "$SRC/$f" -o "$OBJ/$(echo "$f" | tr / _).o" & pids+=($!)
done
for p in "${pids[@]}"; do wait "$p"; done
"$LD" --no-entry --gc-sections --strip-all --export=__wasm_call_ctors -z stack-size=65536 --initial-memory=1048576 \
  "$OBJ"/*.o -o "$OUT"
SHA=$(sha256sum "$OUT" | cut -d' ' -f1)
sed -i "s/^const WASM_SHA = '[0-9a-f]*';/const WASM_SHA = '$SHA';/" instruments/bigmacro.js
echo "$OUT: $(stat -c %s "$OUT") bytes, sha256 $SHA"

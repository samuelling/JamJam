// MEGAjam glue (our own code, not part of the vendored sources): a polyphonic bank of Plaits voices for the browser.
// Each voice is a complete plaits::Voice with its own working memory. The patch (engine, harmonics, timbre, morph,
// decay, LPG colour, envelope routings) is shared; trigger, level and note are per voice. The host (an
// AudioWorklet) picks voices, sends events between blocks and calls mo_render once per 12-sample block at 48 kHz.

#include "plaits/dsp/voice.h"
#include "stmlib/utils/random.h"

using namespace plaits;

namespace {

const int kVoices = 6;
const size_t kVoiceRam = 16384;
// the module runs at 47872.34 Hz and is tuned for that rate; here it runs at exactly 48 kHz
const float kTuning = -0.04608f;   // 12 * log2(47872.34 / 48000) semitones

struct Slot {
  Voice voice;
  char ram[kVoiceRam];
  Modulations mod;
  float gain;        // velocity
  float pan_l, pan_r;
  float note;
  int quiet;         // blocks in a row with nothing to hear (after the gate went low)
  bool retrigger;    // a new note on a voice whose gate is still high: one block low first, so the module sees an edge
  bool on;           // rendering
};

Slot slots[kVoices];
Patch patch;
float aux_mix = 0.0f;
bool gate_mode = false;   // false: each note pings the low-pass gate; true: the gate follows the key (level patched)
float out_l[kBlockSize], out_r[kBlockSize];
Voice::Frame frames[kBlockSize];

}  // namespace

extern "C" {

// the C library pieces the DSP links against
void* memcpy(void* d, const void* s, size_t n) { char* a = (char*)d; const char* b = (const char*)s; while (n--) *a++ = *b++; return d; }
void* memset(void* d, int c, size_t n) { char* a = (char*)d; while (n--) *a++ = (char)c; return d; }
void* memmove(void* d, const void* s, size_t n) {
  char* a = (char*)d; const char* b = (const char*)s;
  if (a < b) { while (n--) *a++ = *b++; } else { a += n; b += n; while (n--) *--a = *--b; }
  return d;
}
void __cxa_pure_virtual() { __builtin_trap(); }
int __cxa_atexit(void (*)(void*), void*, void*) { return 0; }
void* __dso_handle = 0;

__attribute__((export_name("mo_voices"))) int mo_voices() { return kVoices; }
__attribute__((export_name("mo_block"))) int mo_block() { return kBlockSize; }
__attribute__((export_name("mo_out_l"))) float* mo_out_l() { return out_l; }
__attribute__((export_name("mo_out_r"))) float* mo_out_r() { return out_r; }

__attribute__((export_name("mo_init"))) void mo_init(uint32_t seed) {
  stmlib::Random::Seed(seed);
  patch.note = 48.0f; patch.harmonics = 0.5f; patch.timbre = 0.5f; patch.morph = 0.5f;
  patch.frequency_modulation_amount = 0.0f; patch.timbre_modulation_amount = 0.0f; patch.morph_modulation_amount = 0.0f;
  patch.engine = 8; patch.decay = 0.5f; patch.lpg_colour = 0.5f;
  for (int i = 0; i < kVoices; ++i) {
    Slot& s = slots[i];
    stmlib::BufferAllocator allocator(s.ram, kVoiceRam);
    s.voice.Init(&allocator);
    Modulations& m = s.mod;
    m.engine = m.note = m.frequency = m.harmonics = m.timbre = m.morph = 0.0f;
    m.trigger = 0.0f; m.level = 0.0f;
    m.frequency_patched = m.timbre_patched = m.morph_patched = false;
    m.trigger_patched = true; m.level_patched = false;
    s.gain = 0.0f; s.pan_l = s.pan_r = 0.7071f; s.note = 60.0f; s.quiet = 0; s.on = false; s.retrigger = false;
  }
}

// 0 engine, 1 harmonics, 2 timbre, 3 morph, 4 decay, 5 lpg colour, 6 env > pitch, 7 env > timbre, 8 env > morph,
// 9 aux mix, 10 gate mode (0 ping, 1 gate)
__attribute__((export_name("mo_param"))) void mo_param(int id, float v) {
  switch (id) {
    case 0: patch.engine = static_cast<int>(v); break;
    case 1: patch.harmonics = v; break;
    case 2: patch.timbre = v; break;
    case 3: patch.morph = v; break;
    case 4: patch.decay = v; break;
    case 5: patch.lpg_colour = v; break;
    case 6: patch.frequency_modulation_amount = v; break;
    case 7: patch.timbre_modulation_amount = v; break;
    case 8: patch.morph_modulation_amount = v; break;
    case 9: aux_mix = v; break;
    case 10:
      gate_mode = v > 0.5f;
      for (int i = 0; i < kVoices; ++i) slots[i].mod.level_patched = gate_mode;
      break;
  }
}

__attribute__((export_name("mo_note_on"))) void mo_note_on(int i, float note, float gain, float pan, uint32_t seed) {
  if (i < 0 || i >= kVoices) return;
  Slot& s = slots[i];
  stmlib::Random::Seed(seed);   // every note's randomness starts the same way in every browser
  s.note = note; s.gain = gain;
  s.pan_l = __builtin_sqrtf(0.5f * (1.0f - pan)); s.pan_r = __builtin_sqrtf(0.5f * (1.0f + pan));
  s.retrigger = s.on && s.mod.trigger > 0.5f;
  s.mod.trigger = s.retrigger ? 0.0f : 1.0f; s.mod.level = gain; s.quiet = 0; s.on = true;
}
__attribute__((export_name("mo_note_off"))) void mo_note_off(int i) {
  if (i < 0 || i >= kVoices) return;
  slots[i].mod.trigger = 0.0f; slots[i].mod.level = 0.0f; slots[i].retrigger = false;
}
// glide a sounding voice to another note (legato)
__attribute__((export_name("mo_retune"))) void mo_retune(int i, float note) { if (i >= 0 && i < kVoices) slots[i].note = note; }
__attribute__((export_name("mo_active"))) int mo_active(int i) { return i >= 0 && i < kVoices && slots[i].on ? 1 : 0; }
__attribute__((export_name("mo_kill"))) void mo_kill(int i) { if (i >= 0 && i < kVoices) { slots[i].on = false; slots[i].mod.trigger = 0.0f; slots[i].mod.level = 0.0f; } }

// one block of kBlockSize frames into out_l / out_r
__attribute__((export_name("mo_render"))) void mo_render() {
  for (size_t j = 0; j < kBlockSize; ++j) out_l[j] = out_r[j] = 0.0f;
  for (int i = 0; i < kVoices; ++i) {
    Slot& s = slots[i];
    if (!s.on) continue;
    Patch p = patch;
    p.note = s.note + kTuning;
    s.voice.Render(p, s.mod, frames, kBlockSize);
    if (s.retrigger) { s.retrigger = false; s.mod.trigger = 1.0f; }
    float peak = 0.0f;
    const float g = s.gain * (1.0f / 32768.0f), a = aux_mix, o = 1.0f - aux_mix;
    for (size_t j = 0; j < kBlockSize; ++j) {
      const float x = (o * frames[j].out + a * frames[j].aux) * g;
      out_l[j] += x * s.pan_l; out_r[j] += x * s.pan_r;
      const float ax = __builtin_fabsf(x); if (ax > peak) peak = ax;
    }
    // a voice whose key is up goes to sleep after a quarter second of near silence
    if (s.mod.trigger < 0.5f && peak < 1e-4f) { if (++s.quiet > 1000) s.on = false; } else s.quiet = 0;
  }
}

}  // extern "C"

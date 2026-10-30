// MEGAjam: the few C/C++ library pieces the Plaits DSP uses, for a freestanding wasm32 build (no libc, no libc++).
// Our own code (not part of the vendored sources).
#ifndef MEGAJAM_SHIM_LIBM_H_
#define MEGAJAM_SHIM_LIBM_H_
#include <stddef.h>
#include <stdint.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

extern "C" {
void* memcpy(void* d, const void* s, size_t n);
void* memset(void* d, int c, size_t n);
void* memmove(void* d, const void* s, size_t n);
}

inline float fabsf(float x) { return __builtin_fabsf(x); }
inline double fabs(double x) { return __builtin_fabs(x); }
inline float sqrtf(float x) { return __builtin_sqrtf(x); }
inline double sqrt(double x) { return __builtin_sqrt(x); }
inline float floorf(float x) { return __builtin_floorf(x); }
inline double floor(double x) { return __builtin_floor(x); }
inline float ceilf(float x) { return __builtin_ceilf(x); }
inline float truncf(float x) { return __builtin_truncf(x); }

namespace mj_shim {
// sin and cos on [-pi/4, pi/4] (double precision Taylor/minimax-grade series), with range reduction by pi/2
inline double ksin(double x) { double x2 = x * x; return x * (1 + x2 * (-1.0 / 6 + x2 * (1.0 / 120 + x2 * (-1.0 / 5040 + x2 * (1.0 / 362880 + x2 * (-1.0 / 39916800 + x2 * (1.0 / 6227020800.0))))))); }
inline double kcos(double x) { double x2 = x * x; return 1 + x2 * (-0.5 + x2 * (1.0 / 24 + x2 * (-1.0 / 720 + x2 * (1.0 / 40320 + x2 * (-1.0 / 3628800 + x2 * (1.0 / 479001600.0)))))); }
inline void sincos(double x, double* s, double* c) {
  const double q = __builtin_floor(x * (2.0 / M_PI) + 0.5);
  const double r = (x - q * 1.57079632679489655800) - q * 6.12323399573676603587e-17;
  const double sr = ksin(r), cr = kcos(r);
  switch (static_cast<int64_t>(q) & 3) {
    case 0: *s = sr; *c = cr; break;
    case 1: *s = cr; *c = -sr; break;
    case 2: *s = -sr; *c = -cr; break;
    default: *s = -cr; *c = sr; break;
  }
}
}  // namespace mj_shim

inline double sin(double x) { double s, c; mj_shim::sincos(x, &s, &c); return s; }
inline double cos(double x) { double s, c; mj_shim::sincos(x, &s, &c); return c; }
inline double tan(double x) { double s, c; mj_shim::sincos(x, &s, &c); return s / c; }
inline float sinf(float x) { return static_cast<float>(sin(x)); }
inline float cosf(float x) { return static_cast<float>(cos(x)); }
inline float tanf(float x) { return static_cast<float>(tan(x)); }

#endif

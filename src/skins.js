// How each instrument looks: an illustrated icon (rack shelf, gear wall, booths) and a faceplate style.
// An instrument file can bring its own `icon` (an SVG string); otherwise one of these is used, or the generic box.

const keys = (x, y, w, h, n = 14) => {
  let s = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="1.5" fill="#ecebe4"/>`;
  const kw = w / n;
  for (let i = 1; i < n; i++) s += `<line x1="${x + i * kw}" y1="${y}" x2="${x + i * kw}" y2="${y + h}" stroke="#9c998f" stroke-width=".6"/>`;
  const blacks = [0, 1, 3, 4, 5];
  for (let i = 0; i < n - 1; i++) if (blacks.includes(i % 7)) s += `<rect x="${x + (i + 0.65) * kw}" y="${y}" width="${kw * 0.7}" height="${h * 0.6}" fill="#1b1b1d"/>`;
  return s;
};

export const ICONS = {
  juniper: `<svg viewBox="0 0 120 80" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
    <rect x="6" y="14" width="108" height="56" rx="4" fill="#141415"/><rect x="6" y="14" width="108" height="5" rx="2" fill="#e2502a"/>
    <rect x="42" y="14" width="36" height="5" fill="#f0a12a"/><rect x="78" y="14" width="36" height="5" rx="2" fill="#d7d4c8"/>
    ${[14, 21, 28, 35, 46, 53, 60, 71, 78, 85, 96, 103].map((x, i) => `<rect x="${x}" y="24" width="1.6" height="16" fill="#050505"/><rect x="${x - 2.4}" y="${26 + ((i * 5) % 11)}" width="6.4" height="3.4" rx=".8" fill="#efeee8"/>`).join('')}
    <text x="10" y="49" font-family="Inter Tight,Arial" font-weight="800" font-size="6.5" letter-spacing="1.4" fill="#efeee8">JUNIPER</text>
    ${keys(10, 52, 100, 15, 17)}</svg>`,
  monolith: `<svg viewBox="0 0 120 80" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
    <path d="M16 8h88l6 26H10z" fill="#0d0d0d"/><path d="M16 8h88l1 3H15z" fill="#c9cbcf"/>
    ${[22, 34, 46, 58, 70, 82, 94].map((x, i) => `<circle cx="${x}" cy="${i % 2 ? 26 : 19}" r="4.6" fill="#1f1f1f" stroke="#3a3a3a"/><line x1="${x}" y1="${i % 2 ? 26 : 19}" x2="${x + 2}" y2="${(i % 2 ? 26 : 19) - 3.6}" stroke="#eee" stroke-width="1"/>`).join('')}
    <rect x="4" y="32" width="10" height="40" rx="2" fill="#6a4127"/><rect x="106" y="32" width="10" height="40" rx="2" fill="#6a4127"/>
    <rect x="14" y="34" width="92" height="38" fill="#121212"/>
    <text x="60" y="44" text-anchor="middle" font-family="Georgia,serif" font-style="italic" font-size="7" fill="#f2efe6">monolith</text>
    ${keys(17, 48, 86, 21, 15)}</svg>`,
  machina: `<svg viewBox="0 0 120 80" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
    <rect x="5" y="8" width="110" height="64" rx="4" fill="#2d2f33"/><rect x="5" y="8" width="110" height="2" rx="1" fill="#4b4e54"/>
    <rect x="11" y="14" width="34" height="14" rx="2" fill="#16242e"/><text x="14" y="23.5" font-family="JetBrains Mono,monospace" font-size="5" fill="#bfe3ff">BD TRX 01</text>
    ${[52, 60, 68, 76, 84, 92, 100, 108].map((x) => `<circle cx="${x}" cy="21" r="3.2" fill="#3b3e44" stroke="#17181b"/><line x1="${x}" y1="21" x2="${x}" y2="18.2" stroke="#d9dbe0" stroke-width=".9"/>`).join('')}
    ${Array.from({ length: 9 }, (_, i) => `<rect x="${11 + i * 11.2}" y="33" width="9.4" height="6" rx="1" fill="#44474d"/>`).join('')}
    ${Array.from({ length: 16 }, (_, i) => `<rect x="${11 + i * 6.3}" y="50" width="5.2" height="13" rx="1" fill="${i % 4 === 0 ? '#c9cbd0' : '#e2e3e6'}"/><rect x="${12.3 + i * 6.3}" y="52" width="2.6" height="1.6" fill="${[0, 4, 6, 10, 12, 14].includes(i) ? '#ff3b1f' : '#5a1d14'}"/>`).join('')}
    <text x="11" y="46" font-family="Inter Tight,Arial" font-weight="800" font-size="5.2" letter-spacing="2" fill="#d9dbe0">MACHINA</text></svg>`,
  poly: `<svg viewBox="0 0 120 80" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
    <rect x="8" y="12" width="104" height="58" rx="6" fill="#dcdcd6"/><rect x="8" y="12" width="104" height="58" rx="6" fill="none" stroke="#b9b9b2"/>
    <rect x="15" y="19" width="36" height="20" rx="3" fill="#111"/><path d="M19 33 q6 -14 12 0 t12 0" stroke="#1fc46e" stroke-width="1.4" fill="none"/>
    ${[['#2f80ff', 62], ['#1fc46e', 74], ['#e9e9e4', 86], ['#ff5a1f', 98]].map(([c, x]) => `<circle cx="${x}" cy="29" r="5" fill="${c}" stroke="#0003"/>`).join('')}
    ${Array.from({ length: 12 }, (_, i) => `<rect x="${15 + i * 7.9}" y="46" width="6.6" height="18" rx="1.2" fill="${[1, 3, 6, 8, 10].includes(i) ? '#2a2a2a' : '#f4f4f0'}" stroke="#b9b9b2" stroke-width=".5"/>`).join('')}</svg>`,
  tine: `<svg viewBox="0 0 120 80" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
    <path d="M10 22 Q60 8 110 22 V36 H10z" fill="#1a1412"/><rect x="10" y="34" width="100" height="4" fill="#b7b7b7"/>
    <rect x="46" y="18" width="28" height="7" rx="2" fill="#d9d9d9"/><text x="60" y="23.6" text-anchor="middle" font-family="Georgia,serif" font-style="italic" font-size="5.4" fill="#2a2a2a">tine</text>
    ${keys(12, 38, 96, 16, 16)}<rect x="10" y="54" width="100" height="5" fill="#1a1412"/>
    <rect x="16" y="59" width="3" height="16" fill="#9a9a9a"/><rect x="101" y="59" width="3" height="16" fill="#9a9a9a"/>
    <circle cx="20" cy="30" r="2.2" fill="#cfcfcf"/><circle cx="27" cy="30" r="2.2" fill="#cfcfcf"/></svg>`,
  generic: `<svg viewBox="0 0 120 80" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
    <rect x="10" y="16" width="100" height="50" rx="6" fill="#25272b"/>${[28, 46, 64, 82].map((x) => `<circle cx="${x}" cy="32" r="5" fill="#3b3e44"/>`).join('')}${keys(16, 44, 88, 16, 14)}</svg>`,
};

// faceplate styles: 'knob' (colour-arc encoder), 'fader' (slider with a cap), options as 'stepper' or 'buttons'
export const SKINS = {
  juniper: { cls: 'skin-juniper', knob: 'fader', option: 'buttons', wood: false },
  monolith: { cls: 'skin-monolith', knob: 'knob', option: 'stepper', wood: true },
  machina: { cls: 'skin-machina', knob: 'knob', option: 'stepper', wood: false, custom: 'machina' },
  poly: { cls: 'skin-poly', knob: 'knob', option: 'stepper', wood: false },
  tine: { cls: 'skin-tine', knob: 'knob', option: 'stepper', wood: false },
  generic: { cls: 'skin-generic', knob: 'knob', option: 'stepper', wood: true },
};

export function iconEl(def, extra = '') {
  const el = document.createElement('span');
  el.className = 'ico' + (extra ? ' ' + extra : '');
  el.innerHTML = (def && (def.icon || ICONS[def.id])) || ICONS.generic;
  el.setAttribute('aria-hidden', 'true');
  return el;
}
export const skinOf = (def) => SKINS[def?.id] || SKINS.generic;

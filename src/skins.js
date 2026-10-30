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
  midi: `<svg viewBox="0 0 120 80" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
    <rect x="14" y="10" width="92" height="60" rx="8" fill="#1d1f23"/><circle cx="60" cy="40" r="20" fill="#0c0d0f" stroke="#55585f" stroke-width="2"/>
    ${[[-12, 0], [12, 0], [-8.5, 8.5], [8.5, 8.5], [0, 12]].map(([dx, dy]) => `<circle cx="${60 + dx}" cy="${38 + dy - 6}" r="2.4" fill="#c9cbd0"/>`).join('')}
    <rect x="56" y="57" width="8" height="4" rx="1" fill="#55585f"/><text x="60" y="20" text-anchor="middle" font-family="JetBrains Mono,monospace" font-size="6" font-weight="700" fill="#ffcf26">MIDI</text></svg>`,
  'acoustic/guitar': `<svg viewBox="0 0 120 80" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
    <defs><linearGradient id="agw" x1="0" x2="1"><stop offset="0" stop-color="#c98a45"/><stop offset=".5" stop-color="#e2ad62"/><stop offset="1" stop-color="#b8743a"/></linearGradient></defs>
    <rect x="62" y="35" width="52" height="8" rx="2" fill="#4a2f1c"/>${[0, 1, 2, 3, 4, 5, 6].map((i) => `<rect x="${68 + i * 6.5}" y="35" width="1" height="8" fill="#c9cbd0"/>`).join('')}
    <rect x="110" y="32" width="9" height="14" rx="2" fill="#3b2617"/>
    <path d="M20 22c10-6 22-3 27 4 4-5 13-6 18 0 6 8 5 22-2 28-5 4-12 4-16 0-6 8-19 10-28 4-10-7-12-27 1-36z" fill="url(#agw)" stroke="#5a3418" stroke-width="2"/>
    <circle cx="47" cy="39" r="7" fill="#20140c"/><circle cx="47" cy="39" r="9" fill="none" stroke="#3a2414" stroke-width="1.5"/>
    <rect x="25" y="34" width="4" height="10" rx="1" fill="#2a1a10"/>
    ${[0, 1, 2, 3, 4, 5].map((i) => `<line x1="27" y1="${35.5 + i * 1.4}" x2="118" y2="${35.5 + i * 1.4}" stroke="#ece6d6" stroke-width=".45"/>`).join('')}</svg>`,
  studio: `<svg viewBox="0 0 120 80" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
    <ellipse cx="60" cy="56" rx="20" ry="18" fill="#7a1f24"/><ellipse cx="60" cy="56" rx="15" ry="13.5" fill="#efe8da"/><ellipse cx="60" cy="56" rx="4" ry="3.6" fill="#d9cfbd"/>
    <ellipse cx="36" cy="40" rx="11" ry="5" fill="#d9d2c4"/><rect x="25" y="40" width="22" height="9" fill="#7a1f24"/><ellipse cx="36" cy="49" rx="11" ry="4" fill="#5e171b"/>
    <ellipse cx="84" cy="37" rx="10" ry="4.5" fill="#d9d2c4"/><rect x="74" y="37" width="20" height="10" fill="#7a1f24"/><ellipse cx="84" cy="47" rx="10" ry="4" fill="#5e171b"/>
    <ellipse cx="22" cy="18" rx="15" ry="3" fill="#d8a83a"/><line x1="22" y1="18" x2="22" y2="44" stroke="#8a8a8a" stroke-width="1.4"/>
    <ellipse cx="99" cy="15" rx="17" ry="3.4" fill="#c99a2e"/><line x1="99" y1="15" x2="99" y2="40" stroke="#8a8a8a" stroke-width="1.4"/></svg>`,
  pads: `<svg viewBox="0 0 120 80" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
    <rect x="16" y="6" width="88" height="70" rx="5" fill="#2b2d31"/><rect x="22" y="11" width="30" height="9" rx="1.5" fill="#16242e"/><rect x="24" y="13" width="18" height="2" fill="#ffcf26"/>
    ${[58, 68, 78, 88].map((x) => `<circle cx="${x + 4}" cy="15.5" r="3" fill="#3b3e44" stroke="#17181b"/>`).join('')}
    ${Array.from({ length: 16 }, (_, i) => `<rect x="${24 + (i % 4) * 18.5}" y="${25 + Math.floor(i / 4) * 12.5}" width="16" height="10.5" rx="1.8" fill="${[5, 10].includes(i) ? '#ffcf26' : '#55585f'}" stroke="#18191c" stroke-width=".8"/>`).join('')}</svg>`,
  tonewheel: `<svg viewBox="0 0 120 80" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
    <rect x="6" y="20" width="108" height="46" rx="3" fill="#5a3a22"/><rect x="6" y="20" width="108" height="4" fill="#3e2716"/>
    ${[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => `<rect x="${16 + i * 5}" y="10" width="3.2" height="${18 + ((i * 7) % 9)}" fill="${i < 2 ? '#7a2a20' : i < 7 ? '#e9e4d6' : '#1b1b1b'}"/><rect x="${15.2 + i * 5}" y="${26 + ((i * 7) % 9)}" width="4.8" height="3" rx="1" fill="#efeee8"/>`).join('')}
    ${keys(64, 30, 46, 11, 9)}${keys(10, 46, 100, 14, 17)}</svg>`,
  hammerwork: `<svg viewBox="0 0 120 80" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
    <path d="M12 52 L12 30 Q12 16 34 16 L70 16 Q92 16 104 34 Q110 44 108 52 Z" fill="#121214"/><path d="M18 18 L70 6 L74 16 Z" fill="#1d1d20"/>
    <path d="M20 28 Q30 22 60 22 Q84 22 98 36" stroke="#c9a14a" stroke-width="1" fill="none"/>
    ${keys(12, 52, 96, 12, 17)}<rect x="12" y="64" width="96" height="3" fill="#121214"/>
    <rect x="18" y="67" width="3" height="10" fill="#121214"/><rect x="99" y="67" width="3" height="10" fill="#121214"/></svg>`,
  blown: `<svg viewBox="0 0 120 80" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
    <rect x="8" y="34" width="96" height="9" rx="4.5" fill="#1b1b1d"/><path d="M104 32 L116 26 L116 51 L104 45 Z" fill="#1b1b1d"/>
    ${[22, 32, 42, 56, 66, 76, 88].map((x) => `<circle cx="${x}" cy="38.5" r="2.4" fill="#c9cbd0" stroke="#7d7f85" stroke-width=".6"/>`).join('')}
    <rect x="2" y="36" width="8" height="5" rx="1" fill="#7a5a2a"/>
    <rect x="8" y="55" width="104" height="5" rx="2.5" fill="#c9cbd0"/>${[20, 30, 40, 52, 62, 72, 84, 94].map((x) => `<circle cx="${x}" cy="57.5" r="1.6" fill="#7d7f85"/>`).join('')}</svg>`,
  chip: `<svg viewBox="0 0 120 80" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
    <rect x="8" y="14" width="104" height="54" rx="4" fill="#c9bfa6"/><rect x="8" y="14" width="104" height="8" rx="4" fill="#b3a88e"/>
    <rect x="34" y="28" width="52" height="26" rx="2" fill="#1b1b1d"/>${Array.from({ length: 12 }, (_, i) => `<rect x="${37 + i * 4}" y="24" width="2" height="4" fill="#c9cbd0"/><rect x="${37 + i * 4}" y="54" width="2" height="4" fill="#c9cbd0"/>`).join('')}
    <text x="60" y="44" text-anchor="middle" font-family="JetBrains Mono,monospace" font-size="7" font-weight="700" fill="#e9e9e4">CHIP</text>
    <rect x="16" y="58" width="10" height="5" rx="1" fill="#e5383b"/><rect x="94" y="58" width="10" height="5" rx="1" fill="#55585f"/></svg>`,
  complexosc: `<svg viewBox="0 0 120 80" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
    <rect x="18" y="4" width="84" height="72" rx="3" fill="#ece9df"/><rect x="18" y="4" width="84" height="7" fill="#d8d2c2"/>
    ${[[34, 24, '#2f80ff'], [60, 22, '#1b1b1d'], [86, 24, '#e5383b'], [34, 46, '#1b1b1d'], [60, 46, '#ffcf26'], [86, 46, '#1b1b1d']].map(([x, y, c]) => `<circle cx="${x}" cy="${y}" r="7" fill="${c}"/><line x1="${x}" y1="${y}" x2="${x + 4}" y2="${y - 5}" stroke="#efeee8" stroke-width="1.2"/>`).join('')}
    ${[30, 44, 58, 72, 86].map((x) => `<circle cx="${x}" cy="66" r="3.2" fill="#1b1b1d" stroke="#888"/>`).join('')}
    <path d="M44 66 C 52 50, 64 80, 72 66" stroke="#e5383b" stroke-width="2.2" fill="none"/></svg>`,
  analog: `<svg viewBox="0 0 120 80" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
    <rect x="4" y="10" width="112" height="60" rx="3" fill="#d9d4c7"/><rect x="4" y="10" width="112" height="18" fill="#2b2b2b"/>
    ${[12, 24, 36, 48, 60, 72, 84, 96].map((x, i) => `<circle cx="${x + 2}" cy="19" r="3.6" fill="${['#e5383b', '#ff8a3d', '#ffcf26', '#efeee8'][i % 4]}"/>`).join('')}
    ${Array.from({ length: 16 }, (_, i) => `<rect x="${8 + i * 6.6}" y="52" width="5.4" height="11" rx="1" fill="${['#e5383b', '#ff8a3d', '#ffcf26', '#efeee8'][Math.floor(i / 4)]}"/>`).join('')}
    <text x="8" y="44" font-family="Inter Tight,Arial" font-weight="800" font-size="6" letter-spacing="1" fill="#2b2b2b">ANALOG DRUMS</text></svg>`,
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

// a module from a library with no icon of its own gets a cartridge with its name and accent colour
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function cartridge(def) {
  const name = esc((def.name || def.id || '?').slice(0, 14)), accent = /^#[0-9a-f]{3,8}$/i.test(def.accent || '') ? def.accent : '#ffcf26';
  return `<svg viewBox="0 0 120 80" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
    <rect x="10" y="10" width="100" height="60" rx="7" fill="#232529"/><rect x="10" y="10" width="100" height="14" rx="7" fill="${accent}"/><rect x="10" y="18" width="100" height="6" fill="${accent}"/>
    ${[26, 44, 62, 80].map((x) => `<circle cx="${x + 6}" cy="38" r="5.5" fill="#3b3e44" stroke="#15161a"/><line x1="${x + 6}" y1="38" x2="${x + 6}" y2="33.5" stroke="${accent}" stroke-width="1.2"/>`).join('')}
    <text x="60" y="61" text-anchor="middle" font-family="JetBrains Mono,monospace" font-size="8" font-weight="700" fill="#e9e9e4">${name}</text></svg>`;
}
export function iconEl(def, extra = '') {
  const el = document.createElement('span');
  el.className = 'ico' + (extra ? ' ' + extra : '');
  el.innerHTML = (def && (def.icon || ICONS[def.id] || (def.lib || String(def.id).includes('/') ? cartridge(def) : null))) || ICONS.generic;
  el.setAttribute('aria-hidden', 'true');
  return el;
}
export const skinOf = (def) => SKINS[def?.id] || (def?.skin ? { ...SKINS.generic, ...def.skin } : SKINS.generic);

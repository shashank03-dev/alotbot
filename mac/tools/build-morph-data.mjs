import fs from 'node:fs';
import * as OD from './od.mjs';
const g = JSON.parse(fs.readFileSync('grok-shapes.json', 'utf8'));
const src = fs.readFileSync(process.argv[2], 'utf8');
const i = src.indexOf('Oo={cloud:'); const Oo = Function('return ' + src.slice(i + 3, src.indexOf('}}', i) + 2))();
const cmds = new Set();
for (const v of Object.values(g)) for (const c of v.path.match(/[A-Za-z]/g)) cmds.add(c);
console.log('path commands used:', [...cmds].join(''));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
// Grok id -> eye-table id
const eyeId = { heart: 'heartChubby', flower: 'starFlower', star: 'star6' };
// Hand-tuned after checking the contact sheet: the table's offsets put these eyes off the body.
const faceFix = { heart: { y: 14, sx: 0.7 }, sparkle: { y: 4, sx: 0.55, eye: 0.7 } };
const tilt = { square: 0.55, house: 0.3, sparkle: 1, clover: 1, heart: 1, flower: 1, star: 1 };
const shapes = {};
const ids = ['blob','pebble','bean','egg','squircle','tablet','capsule','cylinder','hex','gem','crystal','wedge','shield','dome','arch','cloud','teardrop','leaf','square','sparkle','clover','flower','heart','house','star'];
for (const id of ids) {
  const repo = OD.SHAPES[id];
  const grok = g[id === 'heart' ? 'heart' : id === 'star' ? 'star6' : id];
  const geo = grok ?? repo;
  let face = repo?.face, tiltScale = repo?.tiltScale;
  if (!face) {
    const o = Oo[eyeId[id] ?? id];
    face = { x: 0, y: Math.round(clamp((o.shiftY - 0.12) * 380, -10, 24)), sx: +clamp(o.gap / 0.563, 0.6, 1).toFixed(2), sy: +clamp(o.height / 0.524, 0.65, 1).toFixed(2), eye: +clamp(o.width / 0.239, 0.75, 1.05).toFixed(2) };
    Object.assign(face, faceFix[id] ?? {});
    tiltScale = tilt[id];
  }
  shapes[id] = { path: geo.path, ring: geo.ring, top: geo.top, bottom: geo.bottom, beltRadius: geo.beltRadius, spanSamples: geo.spanSamples.map(([a, b]) => [+a.toFixed(2), +b.toFixed(2)]), face, tiltScale };
}
const states = ['idle', 'listening', 'thinking', 'happy', 'curious'];
const data = {
  headC: OD.HEAD_C, eyeHalf: OD.EYE_HALF, circleRing: OD.CIRCLE_RING,
  expressions: OD.EXPRESSIONS,
  pools: Object.fromEntries(states.map((s) => [s, OD.ORIGINAL_STATE_DATA.EXPRESSION_POOLS[s]])),
  cadence: Object.fromEntries(states.map((s) => [s, OD.ORIGINAL_STATE_DATA.EXPRESSION_CADENCE[s]])),
  blink: Object.fromEntries(states.map((s) => [s, OD.ORIGINAL_STATE_DATA.BLINK_CADENCE[s] ?? null])),
  shapes,
};
fs.writeFileSync(process.argv[3], JSON.stringify(data));
console.log('expressions', data.expressions.length, 'pools', JSON.stringify(data.pools), 'cadence', JSON.stringify(data.cadence), 'blink', JSON.stringify(data.blink));
for (const id of ['square','sparkle','clover','flower','heart','house','star']) console.log(id, JSON.stringify(shapes[id].face), shapes[id].tiltScale);
console.log('bytes', fs.statSync(process.argv[3]).size);

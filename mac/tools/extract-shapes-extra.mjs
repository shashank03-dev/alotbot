import fs from 'node:fs';
import vm from 'node:vm';
const s = fs.readFileSync(process.argv[2], 'utf8');
const a = s.indexOf('var L=114.2705');
// run through to the end of the 3D shape table (cc) so Lc, Ks, qs exist
let b = s.indexOf('var vl=Math.PI*2', a);
if (b < 0) b = s.indexOf('vl=Math.PI*2', a);
// cut at the statement boundary before vl
b = s.lastIndexOf('}', b) + 1;
const code = s.slice(a, b) + ';globalThis.__out={Hs,Ws,L,Lc:typeof Lc!=="undefined"?Lc:null,Ks,qs,Vs};';
const ctx = { console, Math, Float64Array, Float32Array, Number, Array, Map, Set, Object, JSON, Error, Symbol };
ctx.globalThis = ctx;
try { vm.runInNewContext(code, ctx); } catch (e) { console.log('eval error', String(e).slice(0, 300)); process.exit(1); }
const { Ws, L, Lc, Ks, qs, Vs } = ctx.__out;
const all = JSON.parse(fs.readFileSync('grok-shapes.json', 'utf8'));
const pack = (g) => ({ path: g.path, ring: Array.from(g.ring, (p) => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100]), top: g.top, bottom: g.bottom, beltRadius: g.beltRadius, spanSamples: Array.from({ length: 160 }, (_, i) => g.spanAt(g.top + ((g.bottom - g.top) * (i + 0.5)) / 160)) });
all.teardrop = pack(Ks(88, 48));
all.wedge = pack(qs(60, 80));
const pts = Lc();
console.log('Lc points', pts.length, JSON.stringify(pts.slice(0, 2)));
const poly = pts.map((p) => [p.x * L + L, -p.y * L + L]);
const d = 'M' + poly.map(([x, y]) => `${x.toFixed(3)} ${y.toFixed(3)}`).join('L') + 'Z';
try { all.flower = pack(Vs(d)); } catch (e) { console.log('flower via Vs failed', String(e)); }
fs.writeFileSync('grok-shapes.json', JSON.stringify(all));
console.log(Object.keys(all).join(' '));
console.log('flower', all.flower && all.flower.ring.length, all.flower && all.flower.beltRadius);

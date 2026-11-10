import fs from 'node:fs';
import vm from 'node:vm';
const s = fs.readFileSync(process.argv[2], 'utf8');
const a = s.indexOf('var L=114.2705');
const w = s.indexOf('function Ws(e){', a);
const b = s.indexOf('}', s.indexOf('return Us.set(e,n),n', w)) + 1;
const code = s.slice(a, b) + ';globalThis.__out={Hs,Ws,L};';
const ctx = { console, Math, Float64Array, Number, Array, Map, Set, Object, JSON };
ctx.globalThis = ctx;
vm.runInNewContext(code, ctx);
const { Hs, Ws } = ctx.__out;
const out = {};
for (const id of Object.keys(Hs)) {
  try {
    const g = Ws(id);
    out[id] = { path: g.path, ring: Array.from(g.ring, (p) => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100]), top: g.top, bottom: g.bottom, beltRadius: g.beltRadius,
      spanSamples: Array.from({ length: 160 }, (_, i) => g.spanAt(g.top + ((g.bottom - g.top) * (i + 0.5)) / 160)) };
  } catch (e) { out[id] = { error: String(e) }; }
}
fs.writeFileSync('grok-shapes.json', JSON.stringify(out));
for (const [k, v] of Object.entries(out)) console.log(k, v.error ?? `ring ${v.ring.length} belt ${v.beltRadius}`);

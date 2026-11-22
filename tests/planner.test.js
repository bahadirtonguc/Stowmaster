const assert = require('assert');
const P = require('../src/planner.js');

const SAMPLE = `ad,uzunluk,genislik,yukseklik,agirlik,adet,oncelik,istiflenebilir,kisit
Kutu A,1.2,0.8,0.8,0.6,20,2,yes,
Palet B,1.2,1.0,1.1,0.9,15,2,yes,
Makine C,2.5,1.2,1.4,4.0,4,1,no,
Celik bobin,2.0,2.0,1.5,8.0,4,3,no,
Ozel yuk D,1.0,1.0,1.0,1.0,6,1,yes,H3`;

const v = { n: 3, L: 24, bB: 16, bT: 13, H: 12 };
const maxT = 350;

function checkPlan(res, v, maxT) {
  res.holds.forEach(h => {
    const wt = h.placed.reduce((s, q) => s + q.wt, 0);
    assert(wt <= maxT + 1e-6, `hold ${h.hi + 1} overweight ${wt}`);
    h.placed.forEach(q => {
      // inside hold length and height
      assert(q.x >= -1e-9 && q.x + q.ax <= v.L + 1e-6, `${q.id} outside length`);
      assert(q.z >= -1e-9 && q.z + q.h <= v.H + 1e-6, `${q.id} outside height`);
      // inside tapered breadth at item top (conservative)
      const half = P.widthAt(v, q.z + q.h) / 2;
      assert(q.y >= -half - 1e-6 && q.y + q.by <= half + 1e-6, `${q.id} outside breadth`);
      // restriction respected
      if (q.restr) assert.strictEqual(q.restr, 'H' + (h.hi + 1));
    });
    // no overlaps within the same layer (same z)
    for (let i = 0; i < h.placed.length; i++) for (let j = i + 1; j < h.placed.length; j++) {
      const a = h.placed[i], b = h.placed[j];
      if (Math.abs(a.z - b.z) > 1e-9) continue;
      const ox = Math.min(a.x + a.ax, b.x + b.ax) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.by, b.y + b.by) - Math.max(a.y, b.y);
      assert(!(ox > 1e-6 && oy > 1e-6), `overlap ${a.id} / ${b.id} in hold ${h.hi + 1}`);
    }
    // nothing placed above a non-stackable item in the same hold
    h.placed.filter(q => !q.stack).forEach(q => {
      assert(!h.placed.some(r => r.z > q.z + 1e-9), `item stacked on non-stackable ${q.id}`);
    });
  });
}

const items = P.parseCargo(SAMPLE);
assert.strictEqual(items.length, 20 + 15 + 4 + 4 + 6);

const res = P.planBest(v, items, maxT);
checkPlan(res, v, maxT);
const placedN = res.holds.reduce((s, h) => s + h.placed.length, 0);
console.log('sample: placed', placedN, 'unplaced', res.pending.length);
assert.strictEqual(placedN + res.pending.length, items.length);

// restriction: 'Ozel yuk D' only in hold 3
res.holds.forEach(h => h.placed.forEach(q => {
  if (q.name === 'Ozel yuk D') assert.strictEqual(h.hi + 1, 3);
}));

// symmetric taper: placed footprint should be centred around 0
const all = res.holds.flatMap(h => h.placed);
const ys = all.map(q => q.y).concat(all.map(q => q.y + q.by));
console.log('breadth range', Math.min(...ys).toFixed(2), Math.max(...ys).toFixed(2));

// stress test on random cargo
let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
for (let t = 0; t < 200; t++) {
  const rows = ['ad,uzunluk,genislik,yukseklik,agirlik,adet,oncelik,istiflenebilir,kisit'];
  const nRows = 3 + Math.floor(rnd() * 10);
  for (let i = 0; i < nRows; i++) {
    rows.push([`X${i}`, (0.5 + rnd() * 3).toFixed(2), (0.5 + rnd() * 2.5).toFixed(2),
      (0.5 + rnd() * 2.5).toFixed(2), (0.2 + rnd() * 6).toFixed(2),
      1 + Math.floor(rnd() * 8), 1 + Math.floor(rnd() * 3),
      rnd() < 0.3 ? 'no' : 'yes', ''].join(','));
  }
  const vv = { n: 1 + Math.floor(rnd() * 4), L: 10 + rnd() * 20, bB: 8 + rnd() * 10, bT: 6 + rnd() * 8, H: 6 + rnd() * 8 };
  vv.bT = Math.min(vv.bT, vv.bB);
  const mt = 50 + rnd() * 300;
  const its = P.parseCargo(rows.join('\n'));
  const r = P.planBest(vv, its, mt);
  checkPlan(r, vv, mt);
  const n = r.holds.reduce((s, h) => s + h.placed.length, 0);
  assert.strictEqual(n + r.pending.length, its.length);
}
console.log('random tests passed (200 cases)');

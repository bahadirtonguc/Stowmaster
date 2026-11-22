const assert = require('assert');
const P = require('../src/planner.js');

const HEADER = 'ad,uzunluk,genislik,yukseklik,agirlik,adet,oncelik,istiflenebilir,kisit';
const SAMPLE = `${HEADER}
Kutu A,1.2,0.8,0.8,0.6,20,2,yes,
Palet B,1.2,1.0,1.1,0.9,15,2,yes,
Makine C,2.5,1.2,1.4,4.0,4,1,no,
Celik bobin,2.0,2.0,1.5,8.0,4,3,no,
Ozel yuk D,1.0,1.0,1.0,1.0,6,1,yes,H3`;

const v = { n: 3, L: 24, bB: 16, bT: 13, H: 12 };
const maxT = 350;
const TOL = 1e-6;

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL:', name); throw e; }
}

const volOf = res => res.holds.reduce((s, h) => s + h.placed.reduce((t, q) => t + q.ax * q.by * q.h, 0), 0);

// Rules every plan must satisfy.
function checkPlan(res, v, maxT, items) {
  const seen = new Set();
  res.holds.forEach(h => {
    const wt = h.placed.reduce((s, q) => s + q.wt, 0);
    assert(wt <= maxT + TOL, `hold ${h.hi + 1} overweight ${wt}`);
    h.placed.forEach(q => {
      assert(!seen.has(q.uid), `${q.id} placed twice`);
      seen.add(q.uid);
      assert.strictEqual(q.hold, h.hi + 1);
      // footprint matches the item (possibly rotated), height unchanged
      assert((Math.abs(q.ax - q.l) < TOL && Math.abs(q.by - q.w) < TOL) ||
             (Math.abs(q.ax - q.w) < TOL && Math.abs(q.by - q.l) < TOL), `${q.id} footprint changed`);
      // inside hold length and height
      assert(q.x >= -TOL && q.x + q.ax <= v.L + TOL, `${q.id} outside length`);
      assert(q.z >= -TOL && q.z + q.h <= v.H + TOL, `${q.id} outside height`);
      // inside tapered breadth over the whole item height (narrowing or widening hold)
      const half = P.minWidth(v, q.z, q.z + q.h) / 2;
      assert(q.y >= -half - TOL && q.y + q.by <= half + TOL, `${q.id} outside breadth`);
      // inside its layer
      assert(q.z >= q.layerZ - TOL && q.z + q.h <= q.layerZ + q.layerH + TOL, `${q.id} outside its layer`);
      // restriction respected
      if (q.restr) assert.strictEqual(q.restr, 'H' + (h.hi + 1));
      // non-stackable only on the hold floor
      if (!q.stack) assert(q.z < TOL, `non-stackable ${q.id} above floor`);
      // inside a layer, an item above the layer base sits fully on a stackable item of the same footprint
      if (q.z > q.layerZ + TOL) {
        assert(h.placed.some(r => r !== q && r.stack && Math.abs(r.x - q.x) < TOL && Math.abs(r.y - q.y) < TOL &&
          Math.abs(r.ax - q.ax) < TOL && Math.abs(r.by - q.by) < TOL && Math.abs(r.z + r.h - q.z) < TOL),
          `${q.id} not supported inside its layer`);
      }
    });
    // no overlaps in 3D
    for (let i = 0; i < h.placed.length; i++) for (let j = i + 1; j < h.placed.length; j++) {
      const a = h.placed[i], b = h.placed[j];
      const ox = Math.min(a.x + a.ax, b.x + b.ax) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.by, b.y + b.by) - Math.max(a.y, b.y);
      const oz = Math.min(a.z + a.h, b.z + b.h) - Math.max(a.z, b.z);
      assert(!(ox > TOL && oy > TOL && oz > TOL), `overlap ${a.id} / ${b.id} in hold ${h.hi + 1}`);
    }
    // nothing placed above a non-stackable item in the same hold
    h.placed.filter(q => !q.stack).forEach(q => {
      assert(!h.placed.some(r => r.z > q.z + 1e-9), `item stacked on non-stackable ${q.id}`);
    });
  });
  res.pending.forEach(q => assert(!seen.has(q.uid), `${q.id} both placed and pending`));
  if (items) assert.strictEqual(seen.size + res.pending.length, items.length, 'items lost or duplicated');
  // metrics are finite and consistent
  const m = P.planMetrics(v, res);
  for (const k of ['holdVol', 'cargoVol', 'gapVol', 'utilization', 'utilizationWithGaps', 'gapShare', 'layerFill']) {
    assert(Number.isFinite(m[k]) && m[k] >= -TOL, `metric ${k} = ${m[k]}`);
  }
  assert(Math.abs(m.cargoVol - volOf(res)) < 1e-6);
  if (m.holdVol > 0) {
    assert(m.utilizationWithGaps <= 1 + 1e-6, 'cargo + gaps exceed hold volume');
    assert(Math.abs(m.utilizationWithGaps - m.utilization - m.gapShare) < 1e-9);
  }
  return m;
}

// ------------------------------------------------------------- sample plan

let sampleRes;
test('sample plan', () => {
  const items = P.parseCargo(SAMPLE);
  assert.strictEqual(items.length, 20 + 15 + 4 + 4 + 6);
  sampleRes = P.planBest(v, items, maxT);
  const m = checkPlan(sampleRes, v, maxT, items);
  const placedN = sampleRes.holds.reduce((s, h) => s + h.placed.length, 0);
  console.log(`sample: placed ${placedN} unplaced ${sampleRes.pending.length} | ` +
    `net %${(100 * m.utilization).toFixed(2)} | boşluk dahil %${(100 * m.utilizationWithGaps).toFixed(2)} | ` +
    `dikey boşluk ${m.gapVol.toFixed(2)} m3 | strateji ${sampleRes.strategy.order}/${sampleRes.strategy.strategy}`);
  // restriction: 'Ozel yuk D' only in hold 3
  sampleRes.holds.forEach(h => h.placed.forEach(q => {
    if (q.name === 'Ozel yuk D') assert.strictEqual(h.hi + 1, 3);
  }));
});

test('planBest is deterministic', () => {
  const a = P.planBest(v, P.parseCargo(SAMPLE), maxT);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(sampleRes)));
});

// ------------------------------------------------------------- metrics

test('vertical gap metric (hand computed)', () => {
  const hv = { n: 1, L: 2, bB: 1, bT: 1, H: 2 };
  const items = P.parseCargo(`${HEADER}\nUzun,1,1,2,1,1,1,yes,\nKisa,1,1,1,1,1,2,yes,`);
  // original method: layer height 2 (seed 'Uzun'), 'Kisa' beside it leaves 1 m gap on 1 m2
  const placed = P.planHold(hv, 0, items, 100, { layerMode: 'seed', stackInLayer: false });
  assert.strictEqual(placed.length, 2);
  const m = P.holdMetrics(hv, placed);
  assert(Math.abs(m.holdVol - 4) < 1e-9);
  assert(Math.abs(m.cargoVol - 3) < 1e-9);
  assert(Math.abs(m.gapVol - 1) < 1e-9);
  assert(Math.abs(m.maxGap - 1) < 1e-9);
  assert(Math.abs(m.utilization - 0.75) < 1e-9);
  assert(Math.abs(m.utilizationWithGaps - 1) < 1e-9);
  assert(Math.abs(m.layerFill - 0.75) < 1e-9);
  assert(Math.abs(m.headroom) < 1e-9);
  assert.strictEqual(m.layers.length, 1);
});

test('columns remove the vertical gap', () => {
  const hv = { n: 1, L: 2, bB: 1, bT: 1, H: 2 };
  const items = P.parseCargo(`${HEADER}\nUzun,1,1,2,1,1,1,yes,\nKisa,1,1,1,1,2,2,yes,`);
  const noCol = P.planHold(hv, 0, items, 100, { layerMode: 'seed', stackInLayer: false });
  const col = P.planHold(hv, 0, items, 100, { layerMode: 'seed', stackInLayer: true });
  assert.strictEqual(noCol.length, 2);
  assert.strictEqual(col.length, 3);
  assert(P.holdMetrics(hv, col).gapVol < 1e-9);
  checkPlan({ holds: [{ hi: 0, placed: col }], pending: [] }, hv, 100);
});

test('height grouping prefers a full layer', () => {
  // seed would be the 2 m item; bestFill builds a 1 m layer of short items first
  const hv = { n: 1, L: 4, bB: 1, bT: 1, H: 3 };
  const items = P.parseCargo(`${HEADER}\nUzun,1,1,2,1,1,1,yes,\nKisa,1,1,1,1,4,2,yes,`);
  const seed = P.planHold(hv, 0, items, 100, { layerMode: 'seed' });
  const bf = P.planHold(hv, 0, items, 100, { layerMode: 'bestFill' });
  assert(P.holdMetrics(hv, bf).gapVol < P.holdMetrics(hv, seed).gapVol);
  assert.strictEqual(bf.length, 5);
});

test('headroom above the top layer', () => {
  const hv = { n: 1, L: 1, bB: 1, bT: 1, H: 5 };
  const placed = P.planHold(hv, 0, P.parseCargo(`${HEADER}\nA,1,1,2,1,1,1,yes,`), 100);
  assert(Math.abs(P.holdMetrics(hv, placed).headroom - 3) < 1e-9);
});

// ------------------------------------------------------------- edge cases

test('empty list', () => {
  for (const txt of ['', '   ', HEADER, `${HEADER}\n\n\n`]) {
    const r = P.parseCargoChecked(txt);
    assert.strictEqual(r.items.length, 0);
    assert.strictEqual(r.errors.length, 0);
    const res = P.planBest(v, r.items, maxT);
    checkPlan(res, v, maxT, r.items);
    assert.strictEqual(res.pending.length, 0);
    assert.strictEqual(P.planMetrics(v, res).utilization, 0);
  }
});

test('zero capacity holds', () => {
  const items = P.parseCargo(SAMPLE);
  const cases = [
    [{ ...v }, 0],                       // max weight 0
    [{ ...v, L: 0 }, maxT],
    [{ ...v, H: 0 }, maxT],
    [{ ...v, bB: 0, bT: 0 }, maxT],
    [{ ...v, n: 0 }, maxT]
  ];
  for (const [vv, mt] of cases) {
    const res = P.planBest(vv, items, mt);
    const m = checkPlan(res, vv, mt, items);
    assert.strictEqual(res.pending.length, items.length, JSON.stringify(vv) + ' ' + mt);
    assert.strictEqual(m.cargoVol, 0);
    assert.strictEqual(m.utilization, 0);
  }
  // zero-weight item still fits a 0 t hold
  const z = P.parseCargo(`${HEADER}\nBos,1,1,1,0,1,1,yes,`);
  const res = P.planBest(v, z, 0);
  checkPlan(res, v, 0, z);
  assert.strictEqual(res.pending.length, 0);
});

test('single item', () => {
  const one = row => P.parseCargo(`${HEADER}\n${row}`);
  const fits = one('Tek,2,1,1,1,1,1,yes,');
  let res = P.planBest(v, fits, maxT);
  checkPlan(res, v, maxT, fits);
  assert.strictEqual(res.holds[0].placed.length, 1);
  const q = res.holds[0].placed[0];
  assert.strictEqual(q.z, 0);
  assert.strictEqual(q.x, 0);

  for (const [row, why] of [
    ['Uzun,1,1,13,1,1,1,yes,', 'taller than hold'],
    ['Genis,30,30,1,1,1,1,yes,', 'larger than footprint'],
    ['Agir,1,1,1,400,1,1,yes,', 'heavier than hold limit'],
    ['Kisitli,1,1,1,1,1,1,yes,H9', 'restricted to a missing hold']
  ]) {
    const it = one(row);
    res = P.planBest(v, it, maxT);
    checkPlan(res, v, maxT, it);
    assert.strictEqual(res.pending.length, 1, why);
  }

  // rotated to fit: 20 m item is wider than the hold, fits only along the 24 m length
  const rot = one('Cubuk,1,20,1,1,1,1,yes,');
  res = P.planBest(v, rot, maxT);
  checkPlan(res, v, maxT, rot);
  assert.strictEqual(res.holds[0].placed[0].ax, 20);

  // restricted single item goes to its hold
  const h2 = one('Ozel,1,1,1,1,1,1,yes,H2');
  res = P.planBest(v, h2, maxT);
  checkPlan(res, v, maxT, h2);
  assert.strictEqual(res.holds[1].placed.length, 1);
});

test('non-stackable keeps the rest of the hold empty above it', () => {
  const items = P.parseCargo(`${HEADER}\nMakine,2,2,1,1,1,1,no,\nKutu,1,1,1,1,50,2,yes,`);
  const hv = { n: 1, L: 4, bB: 4, bT: 4, H: 5 };
  for (const opts of [{ layerMode: 'seed' }, { layerMode: 'seed', stackInLayer: true }, { layerMode: 'bestFill', stackInLayer: true }]) {
    const res = P.planAll(hv, items, 1000, opts); // list order: machine first
    checkPlan(res, hv, 1000, items);
    assert(res.holds[0].placed.some(q => q.name === 'Makine'));
    assert(res.holds[0].placed.every(q => q.z < TOL));
  }
  // planBest maximises volume, so here it leaves the machine out and stacks the boxes
  const best = P.planBest(hv, items, 1000);
  checkPlan(best, hv, 1000, items);
  assert(volOf(best) > 16);
});

test('widening hold uses the narrowest breadth', () => {
  const hv = { n: 1, L: 2, bB: 2, bT: 6, H: 4 };
  // 3 m wide item: fits at the top (6 m) but not at the floor (2 m)
  const items = P.parseCargo(`${HEADER}\nGenis,1,3,1,1,1,1,yes,`);
  const res = P.planBest(hv, items, 100);
  checkPlan(res, hv, 100, items);
  assert.strictEqual(res.pending.length, 1);
});

// ------------------------------------------------------------- CSV validation

test('CSV: valid rows and defaults', () => {
  const r = P.parseCargoChecked(`${HEADER}\nA,1,1,1,1\nB,1.5,2,0.5,0,3,,NO,h2`);
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.items.length, 4);
  assert.strictEqual(r.items[0].prio, 9);
  assert.strictEqual(r.items[0].stack, true);
  assert.strictEqual(r.items[1].stack, false);
  assert.strictEqual(r.items[1].restr, 'H2');
  assert.strictEqual(r.items[1].wt, 0);
});

test('CSV: errors are reported with line and column', () => {
  const txt = [HEADER,
    'Iyi,1,1,1,1,1,1,yes,',      // 2 ok
    'Eksik,1,1,1',                // 3 missing agirlik
    'Harf,1,abc,1,1,1,1,yes,',    // 4 genislik not a number
    'Sifir,0,1,1,1,1,1,yes,',     // 5 zero length
    'Adet,1,1,1,1,2.5,1,yes,',    // 6 qty not integer
    'Istif,1,1,1,1,1,1,belki,',   // 7 bad yes/no
    'Kisit,1,1,1,1,1,1,yes,X1',   // 8 bad restriction
    'Fazla,1,1,1,1,1,1,yes,,x',   // 9 too many columns
    ',1,1,1,1,1,1,yes,',          // 10 empty name
    'Neg,1,1,1,-2,1,1,yes,',      // 11 negative weight
    'Bos,1,,1,1,1,1,yes,',        // 12 empty genislik
    'Hex,0x10,1,1,1,1,1,yes,',    // 13 not a decimal number
    'Tirnak "x",1,1,1,1,1,1,yes,' // 14 quotes
  ].join('\n');
  const r = P.parseCargoChecked(txt);
  const byLine = l => r.errors.filter(e => e.line === l);
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(byLine(2).length, 0);
  assert(/Eksik kolon/.test(byLine(3)[0].message) && /agirlik/.test(byLine(3)[0].message));
  assert.strictEqual(byLine(4)[0].column, 'genislik');
  assert(/sayı değil/.test(byLine(4)[0].message));
  assert.strictEqual(byLine(5)[0].column, 'uzunluk');
  assert.strictEqual(byLine(6)[0].column, 'adet');
  assert.strictEqual(byLine(7)[0].column, 'istiflenebilir');
  assert.strictEqual(byLine(8)[0].column, 'kisit');
  assert(/Fazla kolon/.test(byLine(9)[0].message));
  assert.strictEqual(byLine(10)[0].column, 'ad');
  assert.strictEqual(byLine(11)[0].column, 'agirlik');
  assert.strictEqual(byLine(12)[0].column, 'genislik');
  assert.strictEqual(byLine(13)[0].column, 'uzunluk');
  assert(/Tırnak/.test(byLine(14)[0].message));
  for (let l = 3; l <= 14; l++) assert(byLine(l).length >= 1, `line ${l} has no error`);
  // strict parser refuses the list instead of dropping rows
  assert.throws(() => P.parseCargo(txt), e => Array.isArray(e.errors) && e.errors.length === r.errors.length);
  assert(/^Satır 4 \(genislik\): /.test(P.formatIssue(byLine(4)[0])));
});

test('CSV: missing header and line numbers with blank lines', () => {
  const r = P.parseCargoChecked('\nA,1,1,1,1,1,1,yes,\nB,1,1,1,1');
  assert.strictEqual(r.errors.length, 1);
  assert.strictEqual(r.errors[0].line, 2);
  assert(/başlık/.test(r.errors[0].message));
  const r2 = P.parseCargoChecked(`${HEADER}\n\nA,1,x,1,1`);
  assert.strictEqual(r2.errors[0].line, 3);
});

test('CSV: limits and warnings', () => {
  const r = P.parseCargoChecked(`${HEADER}\nA,1,1,1,1,${P.MAX_QTY + 1},1,yes,`);
  assert.strictEqual(r.errors[0].column, 'adet');
  const w = P.parseCargoChecked(`${HEADER}\nA,1,1,1,1,1,1,yes,H5`, { holds: 3 });
  assert.strictEqual(w.errors.length, 0);
  assert.strictEqual(w.warnings.length, 1);
  assert.strictEqual(w.items.length, 1);
  const rows = [HEADER];
  for (let i = 0; i < 6; i++) rows.push(`R${i},1,1,1,1,${P.MAX_QTY},1,yes,`);
  const big = P.parseCargoChecked(rows.join('\n'));
  assert(big.errors.some(e => /sınırını aşıyor/.test(e.message)));
});

test('vessel validation', () => {
  assert.deepStrictEqual(P.validateVessel(v, maxT), []);
  assert.deepStrictEqual(P.validateVessel({ n: 1, L: 0, bB: 0, bT: 0, H: 0 }, 0), []);
  assert.strictEqual(P.validateVessel({ ...v, L: NaN }, maxT).length, 1);
  assert.strictEqual(P.validateVessel({ ...v, H: -1 }, maxT).length, 1);
  assert.strictEqual(P.validateVessel({ ...v, n: 1.5 }, maxT).length, 1);
  assert.strictEqual(P.validateVessel(v, NaN).length, 1);
});

// ------------------------------------------------------------- random scenarios (fixed seed)

const RANDOM_CASES = 1000;
test(`random scenarios (${RANDOM_CASES})`, () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let gain = 0;
  for (let t = 0; t < RANDOM_CASES; t++) {
    const rows = [HEADER];
    const dense = t % 4 === 0; // every 4th case: more cargo than space
    const nRows = 1 + Math.floor(rnd() * 12);
    for (let i = 0; i < nRows; i++) {
      const restr = rnd() < 0.1 ? 'H' + (1 + Math.floor(rnd() * 5)) : '';
      rows.push([`X${i}`, (0.5 + rnd() * 3).toFixed(2), (0.5 + rnd() * 2.5).toFixed(2),
        (0.3 + rnd() * 2.5).toFixed(dense ? 1 : 2), rnd() < 0.05 ? '0' : (0.2 + rnd() * 6).toFixed(2),
        1 + Math.floor(rnd() * (dense ? 30 : 8)), 1 + Math.floor(rnd() * 3),
        rnd() < 0.3 ? 'no' : 'yes', restr].join(','));
    }
    const vv = { n: 1 + Math.floor(rnd() * 4), L: 4 + rnd() * 26, bB: 3 + rnd() * 15, bT: 3 + rnd() * 12, H: 2 + rnd() * 12 };
    if (rnd() < 0.8) vv.bT = Math.min(vv.bT, vv.bB); // most holds narrow upwards, some widen
    const mt = rnd() < 0.05 ? 0 : 20 + rnd() * 330;
    const its = P.parseCargo(rows.join('\n'));
    const r = P.planBest(vv, its, mt, { iterations: 40, seed: t });
    checkPlan(r, vv, mt, its);
    // never worse than the original method on the same ordering
    const base = P.planAll(vv, [...its].sort((a, b) => a.prio - b.prio || b.l * b.w * b.h - a.l * a.w * a.h), mt,
      { layerMode: 'seed', stackInLayer: false });
    checkPlan(base, vv, mt, its);
    assert(volOf(r) >= volOf(base) - 1e-6, `case ${t}: worse than original method`);
    gain += volOf(r) - volOf(base);
  }
  console.log(`random: ${RANDOM_CASES} cases ok, extra volume vs original method ${gain.toFixed(1)} m3`);
});

console.log(`${passed} tests passed`);

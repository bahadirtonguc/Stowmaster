const assert = require('assert');
const D = require('../src/drawing.js');
const P = require('../src/planner.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL:', name); throw e; }
}

// ---------------------------------------------------------------- tiny raster for synthetic drawings

function canvas(W, H) {
  const g = new Uint8ClampedArray(W * H).fill(255);
  const dot = (x, y, t) => {
    for (let dy = -t; dy <= t; dy++) for (let dx = -t; dx <= t; dx++) {
      const px = Math.round(x + dx), py = Math.round(y + dy);
      if (px >= 0 && py >= 0 && px < W && py < H) g[py * W + px] = 0;
    }
  };
  const line = (x0, y0, x1, y1, t = 1, dash = 0) => {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= n; i++) {
      if (dash && Math.floor(i / dash) % 2) continue;
      dot(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, t);
    }
  };
  const poly = (pts, t = 1) => pts.forEach((p, i) => { const q = pts[(i + 1) % pts.length]; line(p[0], p[1], q[0], q[1], t); });
  const block = (x, y, w, h) => { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) g[yy * W + xx] = 0; };
  // a "text" label: a row of small glyph-like blocks
  const text = (x, y, n) => { for (let i = 0; i < n; i++) { block(x + i * 8, y, 5, 2); block(x + i * 8, y, 2, 8); block(x + i * 8, y + 6, 5, 2); } };
  return { g, W, H, line, poly, block, text };
}

// Part: length 4 m, width 2 m, height 3 m; side view is an L: full height for the first
// 2 m, 1.5 m for the rest. Real volume share: (2*3 + 2*1.5) / (4*3) = 0.75. Scale 50 px/m.
function lDrawing() {
  const c = canvas(700, 560);
  const s = 50;
  // top view at (100, 60): 200 x 100, with hidden line and centre line
  const tx = 100, ty = 60;
  c.poly([[tx, ty], [tx + 4 * s, ty], [tx + 4 * s, ty + 2 * s], [tx, ty + 2 * s]], 2); // visible outline, 5 px
  c.line(tx + 2 * s, ty, tx + 2 * s, ty + 2 * s, 2);                 // edge of the step
  c.line(tx - 10, ty + s, tx + 4 * s + 10, ty + s, 0, 6);            // centre line, dashed, sticks out
  // dimension below the top view, extension lines touching the outline
  c.line(tx, ty + 2 * s, tx, ty + 2 * s + 30, 0);                    // thin, 1 px
  c.line(tx + 4 * s, ty + 2 * s, tx + 4 * s, ty + 2 * s + 30, 0);
  c.line(tx, ty + 2 * s + 25, tx + 4 * s, ty + 2 * s + 25, 0);
  c.poly([[tx, ty + 2 * s + 25], [tx + 10, ty + 2 * s + 21], [tx + 10, ty + 2 * s + 29]]);
  c.text(tx + 80, ty + 2 * s + 10, 4);                               // "4000"
  // side view at (100, 300): L outline, hatching, hidden lines
  const sx = 100, sy = 300, base = sy + 3 * s;
  c.poly([[sx, base], [sx + 4 * s, base], [sx + 4 * s, base - 1.5 * s], [sx + 2 * s, base - 1.5 * s], [sx + 2 * s, sy], [sx, sy]], 2);
  for (let k = 0; k < 10; k++) c.line(sx + 5 + k * 18, base - 5, sx + 5 + k * 18 + 25, base - 1.5 * s + 5, 0); // hatch inside
  c.line(sx + 30, sy + 10, sx + 30, base - 10, 0, 5);                // hidden line
  // height dimension on the right, extension lines touching
  c.line(sx + 4 * s, base, sx + 4 * s + 40, base, 0);
  c.line(sx + 2 * s, sy, sx + 4 * s + 40, sy, 0);
  c.line(sx + 4 * s + 30, sy, sx + 4 * s + 30, base, 0);
  c.text(sx + 4 * s + 45, sy + 70, 4);
  // title block far away
  c.poly([[450, 450], [690, 450], [690, 550], [450, 550]]);
  c.text(470, 480, 10);
  return {
    c,
    // loose boxes include the dimensions; tight boxes stop just outside the outline
    top: { x: 70, y: 40, w: 300, h: 190 }, side: { x: 70, y: 280, w: 330, h: 190 },
    topTight: { x: 90, y: 50, w: 225, h: 118 }, sideTight: { x: 90, y: 290, w: 222, h: 168 }
  };
}

const iou = (a, b) => {
  let i = 0, u = 0;
  for (let k = 0; k < a.length; k++) { if (a[k] && b[k]) i++; if (a[k] || b[k]) u++; }
  return u ? i / u : 1;
};

// ---------------------------------------------------------------- tests

test('morphology basics', () => {
  const w = 9, h = 7, m = new Uint8Array(w * h);
  m[3 * w + 4] = 1;
  const d = D.morph(m, w, h, 1, true);
  assert.strictEqual(d.reduce((a, b) => a + b, 0), 9);
  assert.deepStrictEqual(D.morph(d, w, h, 1, false), m);
  // a 1 px line disappears under opening with radius 1, a separate 5x5 block survives
  const h2 = 10, L = new Uint8Array(w * h2);
  for (let x = 0; x < w; x++) L[1 * w + x] = 1;
  for (let y = 3; y < 8; y++) for (let x = 2; x < 7; x++) L[y * w + x] = 1;
  const o = D.morph(D.morph(L, w, h2, 1, false), w, h2, 1, true);
  assert.strictEqual(o.slice(w, 2 * w).reduce((a, b) => a + b, 0), 0);
  assert.strictEqual(o.reduce((a, b) => a + b, 0), 25);
});

test('outline is filled and the largest piece kept', () => {
  const c = canvas(60, 40);
  c.poly([[10, 10], [40, 10], [40, 30], [10, 30]]);
  c.block(50, 5, 4, 4); // separate blob
  const s = D.extractSilhouette(c.g, 60, 40, { x: 0, y: 0, w: 60, h: 40 }, { clean: 1 });
  assert.deepStrictEqual(s.bbox, { x: 9, y: 9, w: 33, h: 23 });
  assert(s.area > 0.99);
});

test('dimension lines that close a box with the outline', () => {
  const { c, top } = lDrawing();
  // loose box, no stroke filter: the box between outline and dimension line is filled (known limit)
  const bad = D.extractSilhouette(c.g, c.W, c.H, top);
  assert(bad.h > 115, String(bad.h));
});

for (const [label, pick, opts] of [
  ['loose boxes + min stroke', d => [d.top, d.side], { minStroke: 4 }],
  ['tight boxes, no stroke filter', d => [d.topTight, d.sideTight], {}]
]) test(`L-shaped part from a noisy two-view drawing (${label})`, () => {
  const d = lDrawing(), c = d.c;
  const [top, side] = pick(d);
  const st = D.extractSilhouette(c.g, c.W, c.H, top, opts);
  const ss = D.extractSilhouette(c.g, c.W, c.H, side, opts);
  assert(st && ss);
  // outlines are 200 x 100 and 200 x 150 px plus the 5 px outline stroke; dimension lines and text removed
  assert(st.w >= 200 && st.w <= 206 && st.h >= 100 && st.h <= 106, JSON.stringify(st.bbox));
  assert(ss.w >= 200 && ss.w <= 206 && ss.h >= 150 && ss.h <= 156, JSON.stringify(ss.bbox));
  const n = 16;
  const g = D.viewsToGrids(st, ss, n);
  assert.deepStrictEqual(g.warnings, []);
  const idealTop = new Array(n * n).fill(1);
  const idealSide = [];
  for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) idealSide.push(k < n / 2 || i < n / 2 ? 1 : 0);
  assert(iou(g.top, idealTop) > 0.95, 'top ' + iou(g.top, idealTop));
  assert(iou(g.side, idealSide) > 0.9, 'side ' + iou(g.side, idealSide));
  const hull = P.hullShape(g.top, g.side, n, n, n);
  // never smaller than the part, not much larger
  assert(hull.volFrac >= 0.75 - 1e-9 && hull.volFrac < 0.85, String(hull.volFrac));
  // proportions read from the drawing match 4 x 2 x 3 m
  assert(Math.abs(4 * g.ratios.wPerL - 2) < 0.1 && Math.abs(4 * g.ratios.hPerL - 3) < 0.1, JSON.stringify(g.ratios));
  assert.deepStrictEqual(D.checkDims(g.ratios, 4, 2, 3), []);
  assert.strictEqual(D.checkDims(g.ratios, 4, 3, 3).length, 1);
  console.log(`L drawing (${label}): top ${st.w}x${st.h} px, side ${ss.w}x${ss.h} px, hull ${(100 * hull.volFrac).toFixed(1)}% of box (exact 75%)`);
});

test('views drawn at different lengths are flagged; rotation', () => {
  const { c, top } = lDrawing();
  const st = D.extractSilhouette(c.g, c.W, c.H, top, { minStroke: 4 });
  const rot = D.rotateSilhouette(st);
  assert.strictEqual(rot.w, st.h);
  assert.strictEqual(rot.h, st.w);
  assert.strictEqual(D.rotateSilhouette(D.rotateSilhouette(D.rotateSilhouette(rot))).mask.join(''), st.mask.join(''));
  const g = D.viewsToGrids(st, rot, 8);
  assert.strictEqual(g.warnings.length, 1);
});

test('sampling is conservative', () => {
  // one pixel of part in a cell makes the cell part
  const s = { mask: new Uint8Array(100), w: 10, h: 10 };
  s.mask[0] = 1;
  const g = D.sampleGrid(s, 2, 2, false);
  assert.deepStrictEqual(g, [1, 0, 0, 0]);
  assert.deepStrictEqual(D.sampleGrid(s, 2, 2, true), [0, 0, 1, 0]); // flipped: image top row is the top of the part
});

test('empty or tiny selections', () => {
  const c = canvas(50, 50);
  assert.strictEqual(D.extractSilhouette(c.g, 50, 50, { x: 0, y: 0, w: 50, h: 50 }), null);
  assert.strictEqual(D.extractSilhouette(c.g, 50, 50, { x: 0, y: 0, w: 2, h: 50 }), null);
});

test('toGray treats transparent as white', () => {
  const g = D.toGray(new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 0]), 2, 1);
  assert.deepStrictEqual([...g], [0, 255]);
});

console.log(`${passed} drawing tests passed`);

// Stowage planner core (pure functions, no DOM). Units: meters, tonnes.
// Hold model: rectangular footprint L x width(z), width narrows linearly from bB (z=0) to bT (z=H).
// Items are placed in horizontal layers. Each layer has base z and height = height of its seed item.
// Breadth coordinate y is measured from the hold centreline (symmetric taper).

const EPS = 1e-9;

function parseCargo(text) {
  const rows = text.trim().split(/\r?\n/).slice(1).filter(r => r.trim());
  let uid = 0;
  const items = [];
  rows.forEach(r => {
    const c = r.split(',').map(s => s.trim());
    const l = +c[1], w = +c[2], h = +c[3], wt = +c[4];
    if (!(l > 0 && w > 0 && h > 0)) return;
    const qty = parseInt(c[5]) || 1;
    for (let k = 0; k < qty; k++) {
      items.push({
        uid: uid++, id: `${c[0]} #${k + 1}`, name: c[0],
        l, w, h, wt: wt || 0,
        prio: +c[6] || 9,
        stack: (c[7] || 'yes').toLowerCase() !== 'no',
        restr: (c[8] || '').toUpperCase()
      });
    }
  });
  return items;
}

function widthAt(v, z) {
  const t = Math.min(Math.max(z / v.H, 0), 1);
  return v.bB + (v.bT - v.bB) * t;
}

function allowed(it, hi, z) {
  if (it.restr && it.restr !== 'H' + (hi + 1)) return false;
  return it.stack || z < EPS; // non-stackable: only on the first layer
}

function fitsWidth(v, it, z) {
  const W = widthAt(v, z + it.h);
  return (it.l <= v.L + EPS && it.w <= W + EPS) || (it.w <= v.L + EPS && it.l <= W + EPS);
}

// Plans one hold from the pending list. Returns placed records.
function planHold(v, hi, pending, maxT) {
  const out = [];
  const used = new Set();
  let z = 0, wt = 0, stop = false;

  while (!stop && v.H - z > EPS) {
    const avail = v.H - z;
    const seed = pending.find(it =>
      !used.has(it.uid) && allowed(it, hi, z) && it.h <= avail + EPS &&
      wt + it.wt <= maxT + EPS && fitsWidth(v, it, z));
    if (!seed) break;

    const layerH = seed.h;
    const W = widthAt(v, z + layerH); // narrowest width within the layer
    const half = W / 2;
    const layer = [];
    let x0 = 0, y = -half, sL = 0; // strip origin, breadth cursor (centred), strip length

    const place = (it, a, b, x, yy) =>
      layer.push({ ...it, hold: hi + 1, x, y: yy, z, ax: a, by: b });

    const fit = it => {
      for (const [a, b] of [[it.l, it.w], [it.w, it.l]]) {
        if (b > W + EPS) continue;
        if (y + b <= half + EPS && x0 + Math.max(sL, a) <= v.L + EPS) {
          place(it, a, b, x0, y);
          y += b;
          sL = Math.max(sL, a);
          return true;
        }
        if (x0 + sL + a <= v.L + EPS) {
          x0 += sL;
          y = -half;
          place(it, a, b, x0, y);
          y = -half + b;
          sL = a;
          return true;
        }
      }
      return false;
    };

    for (const it of pending) {
      if (used.has(it.uid) || !allowed(it, hi, z) || it.h > layerH + EPS || wt + it.wt > maxT + EPS) continue;
      if (fit(it)) { used.add(it.uid); wt += it.wt; }
    }

    if (!layer.length) break;
    out.push(...layer);
    if (layer.some(r => !r.stack)) stop = true;
    z += layerH;
  }
  return out;
}

// Runs all holds for one ordering of the cargo list.
function planAll(v, items, maxT) {
  let pending = [...items];
  const holds = [];
  for (let hi = 0; hi < v.n; hi++) {
    const placed = planHold(v, hi, pending, maxT);
    const ids = new Set(placed.map(q => q.uid));
    pending = pending.filter(q => !ids.has(q.uid));
    holds.push({ hi, placed });
  }
  return { holds, pending };
}

// Tries several orderings and keeps the plan that stows the most volume.
function planBest(v, items, maxT) {
  const vol = it => it.l * it.w * it.h;
  const orders = [
    [...items].sort((a, b) => a.prio - b.prio || vol(b) - vol(a)),
    [...items].sort((a, b) => a.prio - b.prio || b.l * b.w - a.l * a.w),
    [...items].sort((a, b) => a.prio - b.prio || b.h - a.h),
    [...items].sort((a, b) => vol(b) - vol(a))
  ];
  let best = null, bestScore = -1;
  for (const ord of orders) {
    const res = planAll(v, ord, maxT);
    const score = res.holds.reduce((s, h) => s + h.placed.reduce((t, q) => t + q.ax * q.by * q.h, 0), 0);
    if (score > bestScore) { bestScore = score; best = res; }
  }
  return best;
}

if (typeof module !== 'undefined') {
  module.exports = { parseCargo, widthAt, allowed, fitsWidth, planHold, planAll, planBest };
}

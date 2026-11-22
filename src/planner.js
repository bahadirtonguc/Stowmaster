// Stowage planner core (pure functions, no DOM). Units: meters, tonnes.
// PROTOTYPE: heuristic placement only. No stability, trim or strength calculation.
//
// Hold model: rectangular footprint L x width(z), width varies linearly from bB (z=0) to bT (z=H).
// Items are placed in horizontal layers. Each layer has a base z and a height (layerH).
// Breadth coordinate y is measured from the hold centreline (symmetric taper).
// Within a layer, a stackable item may carry further items with an identical footprint
// ("column"), as long as the column stays inside the layer height.

const EPS = 1e-9;
const CARGO_COLUMNS = ['ad', 'uzunluk', 'genislik', 'yukseklik', 'agirlik', 'adet', 'oncelik', 'istiflenebilir', 'kisit', 'ust_yuk'];
const REQUIRED_COLUMNS = 5; // ad .. agirlik
const MAX_QTY = 1000;       // per row
const MAX_ITEMS = 5000;     // per list

// ---------------------------------------------------------------- CSV input

const NUM_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
function parseNum(s) {
  return NUM_RE.test(s) ? Number(s) : NaN;
}

// Parses the cargo list and reports every problem instead of skipping rows.
// Returns { items, errors, warnings }; each message is { line, column?, message }.
// opts.holds: number of holds, used to warn about restrictions that point to a missing hold.
function parseCargoChecked(text, opts = {}) {
  const errors = [], warnings = [], items = [];
  const err = (line, message, column) => errors.push({ line, column, message });
  const lines = String(text == null ? '' : text).split(/\r?\n/);

  let headerIdx = lines.findIndex(r => r.trim());
  if (headerIdx < 0) return { items, errors, warnings }; // empty list: nothing to do, not an error

  const header = lines[headerIdx].split(',').map(s => s.trim());
  if (header.length > 1 && NUM_RE.test(header[1])) {
    err(headerIdx + 1, 'İlk satır başlık satırı olmalı (ad,uzunluk,genislik,...). Bu satır veri gibi görünüyor ve atlanırdı.');
  }

  let uid = 0;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    const line = i + 1;
    if (raw.includes('"')) {
      err(line, 'Tırnak işareti desteklenmiyor; ad alanında virgül ve tırnak kullanma.');
      continue;
    }
    const c = raw.split(',').map(s => s.trim());
    if (c.length < REQUIRED_COLUMNS) {
      const missing = CARGO_COLUMNS.slice(c.length, REQUIRED_COLUMNS).join(', ');
      err(line, `Eksik kolon: ${c.length} kolon var, en az ${REQUIRED_COLUMNS} gerekli (eksik: ${missing}).`);
      continue;
    }
    if (c.length > CARGO_COLUMNS.length) {
      err(line, `Fazla kolon: ${c.length} kolon var, en fazla ${CARGO_COLUMNS.length} olabilir. Ondalık ayırıcı olarak virgül kullanılmış olabilir; nokta kullan (1.5).`);
      continue;
    }

    const before = errors.length;
    const name = c[0];
    if (!name) err(line, 'Ad boş olamaz.', 'ad');

    const dim = (idx, col) => {
      const s = c[idx];
      if (s === '') { err(line, `${col} boş.`, col); return NaN; }
      const n = parseNum(s);
      if (!Number.isFinite(n)) err(line, `${col} sayı değil: "${s}".`, col);
      else if (!(n > 0)) err(line, `${col} sıfırdan büyük olmalı: ${s}.`, col);
      return n;
    };
    const l = dim(1, 'uzunluk'), w = dim(2, 'genislik'), h = dim(3, 'yukseklik');

    let wt = NaN;
    if (c[4] === '') err(line, 'agirlik boş.', 'agirlik');
    else {
      wt = parseNum(c[4]);
      if (!Number.isFinite(wt)) err(line, `agirlik sayı değil: "${c[4]}".`, 'agirlik');
      else if (wt < 0) err(line, `agirlik negatif olamaz: ${c[4]}.`, 'agirlik');
    }

    let qty = 1;
    if (c[5] !== undefined && c[5] !== '') {
      qty = parseNum(c[5]);
      if (!Number.isInteger(qty) || qty < 1) err(line, `adet pozitif tam sayı olmalı: "${c[5]}".`, 'adet');
      else if (qty > MAX_QTY) err(line, `adet en fazla ${MAX_QTY} olabilir: ${c[5]}.`, 'adet');
    }

    let prio = 9;
    if (c[6] !== undefined && c[6] !== '') {
      prio = parseNum(c[6]);
      if (!Number.isFinite(prio)) err(line, `oncelik sayı değil: "${c[6]}".`, 'oncelik');
    }

    let stack = true;
    if (c[7] !== undefined && c[7] !== '') {
      const s = c[7].toLowerCase();
      if (s === 'yes') stack = true;
      else if (s === 'no') stack = false;
      else err(line, `istiflenebilir "yes" ya da "no" olmalı: "${c[7]}".`, 'istiflenebilir');
    }

    const restr = (c[8] || '').toUpperCase();
    if (restr && !/^H[1-9]\d*$/.test(restr)) {
      err(line, `kisit boş ya da H1, H2 ... biçiminde olmalı: "${c[8]}".`, 'kisit');
    } else if (restr && opts.holds != null && +restr.slice(1) > opts.holds) {
      warnings.push({ line, column: 'kisit', message: `${restr} kısıtı var ama gemide ${opts.holds} hold tanımlı; bu kalem yerleşmeyecek.` });
    }

    // max weight (t) that may rest on this item; empty = no limit
    let maxTop = null;
    if (c[9] !== undefined && c[9] !== '') {
      maxTop = parseNum(c[9]);
      if (!Number.isFinite(maxTop)) err(line, `ust_yuk sayı değil: "${c[9]}".`, 'ust_yuk');
      else if (maxTop < 0) err(line, `ust_yuk negatif olamaz: ${c[9]}.`, 'ust_yuk');
    }

    if (errors.length > before) continue;
    if (items.length + qty > MAX_ITEMS) {
      err(line, `Toplam kalem sayısı ${MAX_ITEMS} sınırını aşıyor.`);
      break;
    }
    for (let k = 0; k < qty; k++) {
      items.push({ uid: uid++, id: `${name} #${k + 1}`, name, l, w, h, wt, prio, stack, restr, maxTop, line });
    }
  }
  return { items, errors, warnings };
}

// Strict variant: throws if the list has any error, so bad rows are never dropped silently.
function parseCargo(text, opts) {
  const r = parseCargoChecked(text, opts);
  if (r.errors.length) {
    const e = new Error('Yük listesinde hata var:\n' + r.errors.map(formatIssue).join('\n'));
    e.errors = r.errors;
    throw e;
  }
  return r.items;
}

function formatIssue(m) {
  return `Satır ${m.line}${m.column ? ` (${m.column})` : ''}: ${m.message}`;
}

// Hold inputs: everything must be a finite number >= 0; hold count a whole number.
function validateVessel(v, maxT, rules) {
  const errors = [];
  const fields = [['n', 'Hold sayısı'], ['L', 'Hold boyu'], ['bB', 'Taban genişliği'], ['bT', 'Üst genişlik'], ['H', 'Hold yüksekliği']];
  for (const [k, label] of fields) {
    if (!Number.isFinite(v[k]) || v[k] < 0) errors.push(`${label} sıfır ya da pozitif bir sayı olmalı.`);
  }
  if (Number.isFinite(v.n) && !Number.isInteger(v.n)) errors.push('Hold sayısı tam sayı olmalı.');
  if (Number.isFinite(v.n) && v.n > 50) errors.push('Hold sayısı en fazla 50 olabilir.');
  if (!Number.isFinite(maxT) || maxT < 0) errors.push('Hold başına max yük sıfır ya da pozitif bir sayı olmalı.');
  if (rules && rules.floorLoad != null && !(Number.isFinite(rules.floorLoad) && rules.floorLoad > 0)) {
    errors.push('Taban yük sınırı (t/m²) boş ya da pozitif bir sayı olmalı.');
  }
  return errors;
}

// ---------------------------------------------------------------- geometry

function widthAt(v, z) {
  if (!(v.H > 0)) return Math.min(v.bB, v.bT);
  const t = Math.min(Math.max(z / v.H, 0), 1);
  return v.bB + (v.bT - v.bB) * t;
}

// Narrowest breadth between z0 and z1 (width is linear, so it is at one of the ends).
// Works for holds that narrow upwards (bT < bB) and for ones that widen (bT > bB).
function minWidth(v, z0, z1) {
  return Math.min(widthAt(v, z0), widthAt(v, z1));
}

function allowed(it, hi, z) {
  if (it.restr && it.restr !== 'H' + (hi + 1)) return false;
  return it.stack || z < EPS; // non-stackable: only on the hold floor
}

function fitsWidth(v, it, z) {
  const W = minWidth(v, z, z + it.h);
  return (it.l <= v.L + EPS && it.w <= W + EPS) || (it.w <= v.L + EPS && it.l <= W + EPS);
}

const near = (a, b) => Math.abs(a - b) <= 1e-6;

// ---------------------------------------------------------------- placement

// Placement rules (all optional; layout heuristics only, not a stability or strength check):
//   balanceHolds     build holds layer by layer, always continuing the lightest hold
//   balancePortStbd  start each strip on the lighter side of the centreline
//   heavyBelow       an item may not rest on a lighter item
//   floorLoad        t/m2 limit on the hold floor, every item's weight projected straight down
// Per-item limit item.maxTop (t): total weight resting on the item, same projection.
function rulesOf(opts) {
  return { balanceHolds: false, balancePortStbd: false, heavyBelow: false, floorLoad: null, ...(opts && opts.rules) };
}

function overlapXY(a, b) {
  const ox = Math.min(a.x + a.ax, b.x + b.ax) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.by, b.y + b.by) - Math.max(a.y, b.y);
  return ox > 1e-9 && oy > 1e-9 ? ox * oy : 0;
}

// Largest sum of (weight / footprint area) at any point of `region`, over the given records.
function maxPressureIn(region, recs) {
  const xs = [region.x, region.x + region.ax], ys = [region.y, region.y + region.by];
  for (const r of recs) {
    for (const x of [r.x, r.x + r.ax]) if (x > region.x && x < region.x + region.ax) xs.push(x);
    for (const y of [r.y, r.y + r.by]) if (y > region.y && y < region.y + region.by) ys.push(y);
  }
  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);
  let best = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    if (xs[i + 1] - xs[i] < 1e-6) continue;
    const cx = (xs[i] + xs[i + 1]) / 2;
    for (let j = 0; j + 1 < ys.length; j++) {
      if (ys[j + 1] - ys[j] < 1e-6) continue;
      const cy = (ys[j] + ys[j + 1]) / 2;
      let p = 0;
      for (const r of recs) {
        if (cx > r.x && cx < r.x + r.ax && cy > r.y && cy < r.y + r.by) p += r.wt / (r.ax * r.by);
      }
      if (p > best) best = p;
    }
  }
  return best;
}

// Checks the weight rules for a record about to be placed on top of `below` (all records
// already in this hold, including the current layer).
// anyTop: true if some record in `below` has a maxTop limit (lets callers skip the scan).
function loadOk(rec, below, rules, anyTop = below.some(r => r.maxTop != null)) {
  const needScan = rec.z > EPS && (rules.heavyBelow || anyTop);
  if (needScan) {
    for (const r of below) {
      if (r.z + r.h > rec.z + 1e-6) continue; // not below
      const ov = overlapXY(rec, r);
      if (!ov) continue;
      if (rules.heavyBelow) {
        const direct = Math.abs(r.z + r.h - rec.z) < 1e-6 || Math.abs(r.layerZ + r.layerH - rec.z) < 1e-6;
        if (direct && rec.wt > r.wt + 1e-9) return false;
      }
      if (r.maxTop != null) {
        let load = rec.wt * ov / (rec.ax * rec.by);
        for (const q of below) {
          if (q === r || q.z < r.z + r.h - 1e-6) continue;
          const o = overlapXY(q, r);
          if (o) load += q.wt * o / (q.ax * q.by);
        }
        if (load > r.maxTop + 1e-9) return false;
      }
    }
  }
  if (rules.floorLoad != null) {
    const recs = below.filter(r => overlapXY(rec, r));
    recs.push(rec);
    if (maxPressureIn(rec, recs) > rules.floorLoad + 1e-9) return false;
  }
  return true;
}

const momentOf = r => r.wt * (r.y + r.by / 2);

function newHold(hi) {
  // done: no further layer fits now; closed: no further layer can ever fit (full height or non-stackable)
  return { hi, z: 0, wt: 0, moment: 0, placed: [], done: false, closed: false };
}

// Fills one layer (base hs.z, height layerH) from the pending list without mutating state.
// Strip packing along the length; optional same-footprint columns inside the layer.
function fillLayer(v, hs, pending, used, layerH, maxT, opts) {
  const rules = rulesOf(opts);
  const hi = hs.hi, z = hs.z;
  const W = minWidth(v, z, z + layerH);
  const half = W / 2;
  const layer = [];
  const taken = new Set();
  let wt = hs.wt, vol = 0, colN = 0, moment = hs.moment;
  let x0 = 0, sL = 0, dir = 1, y = -half; // strip origin, strip length, fill direction, breadth cursor
  // Records the weight checks look at. Direct support can only come from the layer below
  // or from this layer, so the whole hold is needed only for ust_yuk limits further down
  // and for the floor load.
  const anyTop = hs.placed.some(r => r.maxTop != null);
  let layerTop = false; // some record of this layer has an ust_yuk limit
  const below = anyTop || rules.floorLoad != null
    ? [...hs.placed]
    : hs.placed.filter(r => Math.abs(r.layerZ + r.layerH - z) < 1e-6 || Math.abs(r.z + r.h - z) < 1e-6);

  // New strip starts on the lighter side when port/starboard balance is on.
  const stripStart = () => (rules.balancePortStbd && moment < -1e-9 ? [-1, half] : [1, -half]);

  const ok = (it, zz) => !used.has(it.uid) && !taken.has(it.uid) && allowed(it, hi, zz) && wt + it.wt <= maxT + EPS;
  const make = (it, a, b, x, yy, zz, col) => ({ ...it, hold: hi + 1, x, y: yy, z: zz, ax: a, by: b, layerZ: z, layerH, col });
  const commit = rec => {
    layer.push(rec);
    below.push(rec);
    taken.add(rec.uid);
    if (rec.maxTop != null) layerTop = true;
    wt += rec.wt;
    vol += rec.ax * rec.by * rec.h;
    moment += momentOf(rec);
    return rec;
  };

  // Items with the same footprint on top of a stackable base, inside the layer height.
  const stackOn = base => {
    if (!opts.stackInLayer || !base.stack) return;
    let top = base.z + base.h;
    for (const it of pending) {
      if (top + it.h > z + layerH + EPS) continue;
      if (!ok(it, top) || !it.stack) continue;
      const same = (near(it.l, base.ax) && near(it.w, base.by)) || (near(it.w, base.ax) && near(it.l, base.by));
      if (!same) continue;
      const rec = make(it, base.ax, base.by, base.x, base.y, top, base.col);
      if (!loadOk(rec, below, rules, anyTop || layerTop)) continue;
      commit(rec);
      top += it.h;
    }
  };

  const fit = it => {
    const rots = it.fixedRot ? [[it.l, it.w]] : [[it.l, it.w], [it.w, it.l]];
    for (const [a, b] of rots) {
      if (b > W + EPS) continue;
      // continue the current strip
      const yy = dir > 0 ? y : y - b;
      if (yy >= -half - EPS && yy + b <= half + EPS && x0 + Math.max(sL, a) <= v.L + EPS) {
        const rec = make(it, a, b, x0, yy, z, colN);
        if (loadOk(rec, below, rules, anyTop || layerTop)) {
          colN++;
          y = dir > 0 ? y + b : y - b;
          sL = Math.max(sL, a);
          return commit(rec);
        }
      }
      // open a new strip
      if (x0 + sL + a <= v.L + EPS) {
        const [d, y0] = stripStart();
        const rec = make(it, a, b, x0 + sL, d > 0 ? y0 : y0 - b, z, colN);
        if (loadOk(rec, below, rules, anyTop || layerTop)) {
          colN++;
          x0 += sL;
          dir = d;
          y = d > 0 ? y0 + b : y0 - b;
          sL = a;
          return commit(rec);
        }
      }
    }
    return null;
  };

  [dir, y] = stripStart();
  for (const it of pending) {
    if (it.h > layerH + EPS || !ok(it, z)) continue;
    const base = fit(it);
    if (base) stackOn(base);
  }
  // Hold rule: nothing may sit higher than a non-stackable item in the same hold,
  // so a layer holding one is rebuilt without columns.
  if (opts.stackInLayer && layer.some(r => !r.stack) && layer.some(r => r.z > z + EPS)) {
    return fillLayer(v, hs, pending, used, layerH, maxT, { ...opts, stackInLayer: false });
  }
  if (rules.balancePortStbd) moment = shiftStrips(layer, hs, half, rules, moment);
  return { layer, wt, vol, W, moment };
}

// Slides each strip of the layer across the breadth (inside the hold) so that the hold's
// port/starboard moment gets as close to zero as possible. A shift is kept only if every
// moved item still passes the weight rules.
function shiftStrips(layer, hs, half, rules, moment) {
  const strips = new Map();
  for (const r of layer) {
    if (!strips.has(r.x)) strips.set(r.x, []);
    strips.get(r.x).push(r);
  }
  for (const recs of strips.values()) {
    const sw = recs.reduce((s, r) => s + r.wt, 0);
    if (!(sw > 0)) continue;
    const lo = Math.min(...recs.map(r => r.y)), hi = Math.max(...recs.map(r => r.y + r.by));
    const d = Math.min(half - hi, Math.max(-half - lo, -moment / sw));
    if (Math.abs(d) < 1e-9) continue;
    const moved = recs.map(r => ({ ...r, y: r.y + d }));
    const others = hs.placed.concat(layer.filter(r => !recs.includes(r)));
    const order = [...moved].sort((a, b) => a.z - b.z);
    const okAll = order.every((r, i) => loadOk(r, others.concat(order.slice(0, i)), rules));
    if (!okAll) continue;
    recs.forEach((r, i) => { r.y = moved[i].y; });
    moment += d * sw;
  }
  return moment;
}

// Builds the next layer of one hold. Returns false when nothing more fits.
// opts.layerMode: 'seed'     -> layer height = first eligible item in list order (original method)
//                 'bestFill' -> try the heights of the first few eligible items and keep the
//                               layer with the smallest share of empty space (groups similar heights)
// opts.stackInLayer: allow same-footprint columns inside a layer.
function stepHold(v, hs, pending, used, maxT, opts) {
  if (hs.done || hs.closed || !(v.H - hs.z > EPS)) { hs.done = hs.closed = true; return false; }
  const avail = v.H - hs.z;
  const elig = it => !used.has(it.uid) && allowed(it, hs.hi, hs.z) && it.h <= avail + EPS &&
    hs.wt + it.wt <= maxT + EPS && fitsWidth(v, it, hs.z);

  let best = null;
  if (opts.layerMode === 'bestFill') {
    const heights = [];
    for (const it of pending) {
      if (!elig(it)) continue;
      if (!heights.some(h => near(h, it.h))) heights.push(it.h);
      if (heights.length >= (opts.maxCandidates || 8)) break;
    }
    for (const h of heights) {
      const r = fillLayer(v, hs, pending, used, h, maxT, opts);
      if (!r.layer.length) continue;
      const ratio = r.vol / (v.L * r.W * h);
      if (!best || ratio > best.ratio + 1e-9 || (Math.abs(ratio - best.ratio) <= 1e-9 && r.vol > best.vol)) {
        best = { ...r, ratio, h };
      }
    }
  } else {
    // first eligible item that the weight rules also accept as a layer seed
    for (const it of pending) {
      if (!elig(it)) continue;
      const r = fillLayer(v, hs, pending, used, it.h, maxT, opts);
      if (r.layer.length) { best = { ...r, h: it.h }; break; }
    }
  }

  if (!best) { hs.done = true; return false; }
  hs.placed.push(...best.layer);
  best.layer.forEach(r => used.add(r.uid));
  hs.wt = best.wt;
  hs.moment = best.moment;
  if (best.layer.some(r => !r.stack)) hs.done = hs.closed = true; // nothing above a non-stackable item
  hs.z += best.h;
  return true;
}

// Plans one hold from the pending list. Returns placed records.
function planHold(v, hi, pending, maxT, opts = {}) {
  const hs = newHold(hi), used = new Set();
  while (stepHold(v, hs, pending, used, maxT, opts));
  return hs.placed;
}

// Runs all holds for one ordering of the cargo list.
// Without hold balance: hold 1 is filled completely, then hold 2, ... (original method).
// With hold balance: one layer at a time, always in the hold that carries the least weight;
// first with every hold capped at an equal share of the total weight, then the rest
// (new layers on top) with the full hold limit.
function planAll(v, items, maxT, opts = {}) {
  const rules = rulesOf(opts);
  const pending = [...items];
  const used = new Set();
  const hs = [];
  for (let hi = 0; hi < v.n; hi++) hs.push(newHold(hi));
  if (rules.balanceHolds && hs.length) {
    const share = items.reduce((s, it) => s + it.wt, 0) / hs.length;
    for (const cap of [Math.min(maxT, share), maxT]) {
      hs.forEach(h => { h.done = h.closed; });
      for (;;) {
        const open = hs.filter(h => !h.done);
        if (!open.length) break;
        open.sort((a, b) => a.wt - b.wt || a.hi - b.hi);
        stepHold(v, open[0], pending, used, cap, opts);
      }
    }
  } else {
    for (const h of hs) while (stepHold(v, h, pending, used, maxT, opts));
  }
  return { holds: hs.map(h => ({ hi: h.hi, placed: h.placed })), pending: pending.filter(q => !used.has(q.uid)) };
}

// ---------------------------------------------------------------- metrics

// Volumes of one hold. "Vertical gap" = empty height between the top of each column of
// items and the top of its layer, times the column footprint (space that is used up by
// the layer but holds no cargo).
function holdMetrics(v, placed) {
  const holdVol = Math.max(0, v.L * (v.bB + v.bT) / 2 * v.H);
  const cols = new Map(), layers = new Map();
  let cargoVol = 0;
  for (const q of placed) {
    cargoVol += q.ax * q.by * q.h;
    const key = q.layerZ + ':' + q.col;
    const c = cols.get(key) || { area: q.ax * q.by, layerZ: q.layerZ, layerH: q.layerH, top: q.layerZ };
    c.top = Math.max(c.top, q.z + q.h);
    cols.set(key, c);
    const L = layers.get(q.layerZ) || { z: q.layerZ, h: q.layerH, items: 0, cargoVol: 0, gapVol: 0, maxGap: 0 };
    L.items++;
    L.cargoVol += q.ax * q.by * q.h;
    layers.set(q.layerZ, L);
  }
  let gapVol = 0, maxGap = 0;
  for (const c of cols.values()) {
    const g = Math.max(0, c.layerH - (c.top - c.layerZ));
    const L = layers.get(c.layerZ);
    L.gapVol += g * c.area;
    L.maxGap = Math.max(L.maxGap, g);
    gapVol += g * c.area;
    maxGap = Math.max(maxGap, g);
  }
  const layerList = [...layers.values()].sort((a, b) => a.z - b.z);
  const wm = weightMetrics(placed);
  const stackTop = layerList.reduce((m, L) => Math.max(m, L.z + L.h), 0);
  const occupiedVol = cargoVol + gapVol;
  return {
    holdVol, cargoVol, gapVol, occupiedVol, maxGap,
    headroom: Math.max(0, v.H - stackTop),       // empty height above the top layer
    utilization: holdVol > 0 ? cargoVol / holdVol : 0,              // net: cargo / hold
    utilizationWithGaps: holdVol > 0 ? occupiedVol / holdVol : 0,   // cargo + vertical gaps / hold
    gapShare: holdVol > 0 ? gapVol / holdVol : 0,                   // lost to vertical gaps / hold
    layerFill: occupiedVol > 0 ? cargoVol / occupiedVol : 0,        // 1 = no vertical gaps
    layers: layerList,
    ...wm
  };
}

// Weight layout of one hold (layout only: no stability, trim or strength meaning).
// Items straddling the centreline are split by footprint share. Floor pressure projects
// every item's weight straight down over its footprint.
function weightMetrics(placed) {
  let weight = 0, port = 0, stbd = 0, moment = 0;
  for (const q of placed) {
    weight += q.wt;
    moment += momentOf(q);
    const pShare = Math.min(1, Math.max(0, -q.y / q.by));
    port += q.wt * pShare;
    stbd += q.wt * (1 - pShare);
  }
  return {
    weight, portWeight: port, stbdWeight: stbd,
    centroidY: weight > 0 ? moment / weight : 0,   // + = starboard
    maxFloorPressure: floorPressure(placed)
  };
}

function floorPressure(placed) {
  if (!placed.length) return 0;
  const xs = [...new Set(placed.flatMap(r => [r.x, r.x + r.ax]))].sort((a, b) => a - b);
  const ys = [...new Set(placed.flatMap(r => [r.y, r.y + r.by]))].sort((a, b) => a - b);
  const X = xs.length, Y = ys.length;
  const d = new Float64Array((X + 1) * (Y + 1));
  const ix = x => xs.indexOf(x), iy = y => ys.indexOf(y);
  for (const r of placed) {
    const p = r.wt / (r.ax * r.by);
    const i0 = ix(r.x), i1 = ix(r.x + r.ax), j0 = iy(r.y), j1 = iy(r.y + r.by);
    d[i0 * (Y + 1) + j0] += p; d[i1 * (Y + 1) + j0] -= p;
    d[i0 * (Y + 1) + j1] -= p; d[i1 * (Y + 1) + j1] += p;
  }
  let best = 0;
  for (let i = 0; i < X; i++) for (let j = 0; j < Y; j++) {
    const k = i * (Y + 1) + j;
    if (i > 0) d[k] += d[k - (Y + 1)];
    if (j > 0) d[k] += d[k - 1];
    if (i > 0 && j > 0) d[k] -= d[k - (Y + 1) - 1];
    // skip slivers left by rounding where two items only touch
    if (xs[i + 1] - xs[i] < 1e-6 || ys[j + 1] - ys[j] < 1e-6) continue;
    if (d[k] > best) best = d[k];
  }
  return best;
}

function planMetrics(v, res) {
  const holds = res.holds.map(h => holdMetrics(v, h.placed));
  const sum = k => holds.reduce((s, m) => s + m[k], 0);
  const holdVol = sum('holdVol'), cargoVol = sum('cargoVol'), gapVol = sum('gapVol');
  const ws = holds.map(m => m.weight);
  return {
    holds, holdVol, cargoVol, gapVol, occupiedVol: cargoVol + gapVol,
    weight: sum('weight'),
    holdWeightSpread: ws.length ? Math.max(...ws) - Math.min(...ws) : 0, // heaviest - lightest hold
    maxFloorPressure: holds.reduce((m, h) => Math.max(m, h.maxFloorPressure), 0),
    utilization: holdVol > 0 ? cargoVol / holdVol : 0,
    utilizationWithGaps: holdVol > 0 ? (cargoVol + gapVol) / holdVol : 0,
    gapShare: holdVol > 0 ? gapVol / holdVol : 0,
    layerFill: cargoVol + gapVol > 0 ? cargoVol / (cargoVol + gapVol) : 0
  };
}

// ---------------------------------------------------------------- search

function scorePlan(v, res) {
  let vol = 0, gap = 0;
  for (const h of res.holds) {
    const m = holdMetrics(v, h.placed);
    vol += m.cargoVol;
    gap += m.gapVol;
  }
  return { vol, gap };
}

const better = (a, b) => !b || a.vol > b.vol + 1e-9 || (Math.abs(a.vol - b.vol) <= 1e-9 && a.gap < b.gap - 1e-9);

function lcg(seed) {
  let s = (Math.floor(seed) % 2147483646) + 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

const STRATEGIES = [
  { name: 'original', layerMode: 'seed', stackInLayer: false },
  { name: 'columns', layerMode: 'seed', stackInLayer: true },
  { name: 'height-groups', layerMode: 'bestFill', stackInLayer: true }
];

// Tries several orderings x layer strategies, keeps the plan that stows the most volume
// (ties: fewer vertical gaps), then improves it with a local search over the ordering
// (swap two items / move one item), deterministic for a given opts.seed.
// opts.iterations: local search steps (default 150, 0 disables).
// opts.rules: weight rules, see rulesOf(); they are hard limits for every candidate plan.
function planBest(v, items, maxT, opts = {}) {
  const vol = it => it.l * it.w * it.h;
  const orders = [
    ['prio,volume', [...items].sort((a, b) => a.prio - b.prio || vol(b) - vol(a))],
    ['prio,area', [...items].sort((a, b) => a.prio - b.prio || b.l * b.w - a.l * a.w)],
    ['prio,height', [...items].sort((a, b) => a.prio - b.prio || b.h - a.h)],
    ['volume', [...items].sort((a, b) => vol(b) - vol(a))],
    ['height,area', [...items].sort((a, b) => b.h - a.h || b.l * b.w - a.l * a.w)],
    ['prio,footprint', [...items].sort((a, b) => a.prio - b.prio ||
      Math.max(b.l, b.w) - Math.max(a.l, a.w) || Math.min(b.l, b.w) - Math.min(a.l, a.w) || b.h - a.h)]
  ];

  let best = null;
  for (const [oname, ord] of orders) {
    for (const st0 of STRATEGIES) {
      const st = { ...st0, rules: opts.rules };
      const res = planAll(v, ord, maxT, st);
      const sc = scorePlan(v, res);
      if (better(sc, best && best.score)) best = { res, score: sc, order: ord, st, info: { order: oname, strategy: st.name } };
    }
  }
  if (!best) return { holds: [], pending: [...items], strategy: null };

  const totalVol = items.reduce((s, it) => s + vol(it), 0);
  const iters = opts.iterations == null ? 150 : opts.iterations;
  const rnd = lcg(opts.seed == null ? 1 : opts.seed);
  let improved = 0;
  for (let k = 0; k < iters && items.length > 1; k++) {
    if (best.score.vol >= totalVol - 1e-9 && best.score.gap <= 1e-9) break; // nothing left to gain
    const ord = [...best.order];
    const i = Math.floor(rnd() * ord.length);
    let j = Math.floor(rnd() * (ord.length - 1));
    if (j >= i) j++;
    if (rnd() < 0.5) [ord[i], ord[j]] = [ord[j], ord[i]];
    else ord.splice(j, 0, ord.splice(i, 1)[0]);
    const res = planAll(v, ord, maxT, best.st);
    const sc = scorePlan(v, res);
    if (better(sc, best.score)) {
      best = { ...best, res, score: sc, order: ord };
      improved++;
    }
  }
  return { ...best.res, strategy: { ...best.info, localSearchImprovements: improved } };
}

if (typeof module !== 'undefined') {
  module.exports = {
    parseCargo, parseCargoChecked, formatIssue, validateVessel, parseNum,
    widthAt, minWidth, allowed, fitsWidth, fillLayer, planHold, planAll, planBest,
    holdMetrics, planMetrics, weightMetrics, floorPressure, rulesOf, loadOk,
    CARGO_COLUMNS, MAX_QTY, MAX_ITEMS
  };
}

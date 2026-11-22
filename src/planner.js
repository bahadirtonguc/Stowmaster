// Stowage planner core (pure functions, no DOM). Units: meters, tonnes.
// PROTOTYPE: heuristic placement only. No stability, trim or strength calculation.
//
// Hold model: rectangular footprint L x width(z), width varies linearly from bB (z=0) to bT (z=H).
// Items are placed in horizontal layers. Each layer has a base z and a height (layerH).
// Breadth coordinate y is measured from the hold centreline (symmetric taper).
// Within a layer, a stackable item may carry further items with an identical footprint
// ("column"), as long as the column stays inside the layer height.

const EPS = 1e-9;
const CARGO_COLUMNS = ['ad', 'uzunluk', 'genislik', 'yukseklik', 'agirlik', 'adet', 'oncelik', 'istiflenebilir', 'kisit'];
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

    if (errors.length > before) continue;
    if (items.length + qty > MAX_ITEMS) {
      err(line, `Toplam kalem sayısı ${MAX_ITEMS} sınırını aşıyor.`);
      break;
    }
    for (let k = 0; k < qty; k++) {
      items.push({ uid: uid++, id: `${name} #${k + 1}`, name, l, w, h, wt, prio, stack, restr, line });
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
function validateVessel(v, maxT) {
  const errors = [];
  const fields = [['n', 'Hold sayısı'], ['L', 'Hold boyu'], ['bB', 'Taban genişliği'], ['bT', 'Üst genişlik'], ['H', 'Hold yüksekliği']];
  for (const [k, label] of fields) {
    if (!Number.isFinite(v[k]) || v[k] < 0) errors.push(`${label} sıfır ya da pozitif bir sayı olmalı.`);
  }
  if (Number.isFinite(v.n) && !Number.isInteger(v.n)) errors.push('Hold sayısı tam sayı olmalı.');
  if (Number.isFinite(v.n) && v.n > 50) errors.push('Hold sayısı en fazla 50 olabilir.');
  if (!Number.isFinite(maxT) || maxT < 0) errors.push('Hold başına max yük sıfır ya da pozitif bir sayı olmalı.');
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

// Fills one layer (base z, height layerH) from the pending list without mutating state.
// Strip packing along the length; optional same-footprint columns inside the layer.
function fillLayer(v, hi, pending, used, z, layerH, wt0, maxT, opts) {
  const W = minWidth(v, z, z + layerH);
  const half = W / 2;
  const layer = [];
  const taken = new Set();
  let wt = wt0, vol = 0, colN = 0;
  let x0 = 0, y = -half, sL = 0; // strip origin, breadth cursor (centred), strip length

  const ok = (it, zz) => !used.has(it.uid) && !taken.has(it.uid) && allowed(it, hi, zz) && wt + it.wt <= maxT + EPS;
  const put = (it, a, b, x, yy, zz, col) => {
    const rec = { ...it, hold: hi + 1, x, y: yy, z: zz, ax: a, by: b, layerZ: z, layerH, col };
    layer.push(rec);
    taken.add(it.uid);
    wt += it.wt;
    vol += a * b * it.h;
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
      put(it, base.ax, base.by, base.x, base.y, top, base.col);
      top += it.h;
    }
  };

  const fit = it => {
    for (const [a, b] of [[it.l, it.w], [it.w, it.l]]) {
      if (b > W + EPS) continue;
      if (y + b <= half + EPS && x0 + Math.max(sL, a) <= v.L + EPS) {
        const r = put(it, a, b, x0, y, z, colN++);
        y += b;
        sL = Math.max(sL, a);
        return r;
      }
      if (x0 + sL + a <= v.L + EPS) {
        x0 += sL;
        const r = put(it, a, b, x0, -half, z, colN++);
        y = -half + b;
        sL = a;
        return r;
      }
    }
    return null;
  };

  for (const it of pending) {
    if (it.h > layerH + EPS || !ok(it, z)) continue;
    const base = fit(it);
    if (base) stackOn(base);
  }
  // Hold rule: nothing may sit higher than a non-stackable item in the same hold,
  // so a layer holding one is rebuilt without columns.
  if (opts.stackInLayer && layer.some(r => !r.stack) && layer.some(r => r.z > z + EPS)) {
    return fillLayer(v, hi, pending, used, z, layerH, wt0, maxT, { ...opts, stackInLayer: false });
  }
  return { layer, wt, vol, W };
}

// Plans one hold from the pending list. Returns placed records.
// opts.layerMode: 'seed'     -> layer height = first eligible item in list order (original method)
//                 'bestFill' -> try the heights of the first few eligible items and keep the
//                               layer with the smallest share of empty space (groups similar heights)
// opts.stackInLayer: allow same-footprint columns inside a layer.
function planHold(v, hi, pending, maxT, opts = {}) {
  const out = [];
  const used = new Set();
  let z = 0, wt = 0;

  while (v.H - z > EPS) {
    const avail = v.H - z;
    const elig = it => !used.has(it.uid) && allowed(it, hi, z) && it.h <= avail + EPS &&
      wt + it.wt <= maxT + EPS && fitsWidth(v, it, z);

    let best = null;
    if (opts.layerMode === 'bestFill') {
      const hs = [];
      for (const it of pending) {
        if (!elig(it)) continue;
        if (!hs.some(h => near(h, it.h))) hs.push(it.h);
        if (hs.length >= (opts.maxCandidates || 8)) break;
      }
      for (const h of hs) {
        const r = fillLayer(v, hi, pending, used, z, h, wt, maxT, opts);
        const ratio = r.vol / (v.L * r.W * h);
        if (!best || ratio > best.ratio + 1e-9 || (Math.abs(ratio - best.ratio) <= 1e-9 && r.vol > best.vol)) {
          best = { ...r, ratio, h };
        }
      }
    } else {
      const seed = pending.find(elig);
      if (seed) best = { ...fillLayer(v, hi, pending, used, z, seed.h, wt, maxT, opts), h: seed.h };
    }

    if (!best || !best.layer.length) break;
    out.push(...best.layer);
    best.layer.forEach(r => used.add(r.uid));
    wt = best.wt;
    if (best.layer.some(r => !r.stack)) break; // nothing above a non-stackable item
    z += best.h;
  }
  return out;
}

// Runs all holds for one ordering of the cargo list.
function planAll(v, items, maxT, opts = {}) {
  let pending = [...items];
  const holds = [];
  for (let hi = 0; hi < v.n; hi++) {
    const placed = planHold(v, hi, pending, maxT, opts);
    const ids = new Set(placed.map(q => q.uid));
    pending = pending.filter(q => !ids.has(q.uid));
    holds.push({ hi, placed });
  }
  return { holds, pending };
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
  const stackTop = layerList.reduce((m, L) => Math.max(m, L.z + L.h), 0);
  const occupiedVol = cargoVol + gapVol;
  return {
    holdVol, cargoVol, gapVol, occupiedVol, maxGap,
    headroom: Math.max(0, v.H - stackTop),       // empty height above the top layer
    utilization: holdVol > 0 ? cargoVol / holdVol : 0,              // net: cargo / hold
    utilizationWithGaps: holdVol > 0 ? occupiedVol / holdVol : 0,   // cargo + vertical gaps / hold
    gapShare: holdVol > 0 ? gapVol / holdVol : 0,                   // lost to vertical gaps / hold
    layerFill: occupiedVol > 0 ? cargoVol / occupiedVol : 0,        // 1 = no vertical gaps
    layers: layerList
  };
}

function planMetrics(v, res) {
  const holds = res.holds.map(h => holdMetrics(v, h.placed));
  const sum = k => holds.reduce((s, m) => s + m[k], 0);
  const holdVol = sum('holdVol'), cargoVol = sum('cargoVol'), gapVol = sum('gapVol');
  return {
    holds, holdVol, cargoVol, gapVol, occupiedVol: cargoVol + gapVol,
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
    for (const st of STRATEGIES) {
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
    holdMetrics, planMetrics, CARGO_COLUMNS, MAX_QTY, MAX_ITEMS
  };
}

// Drawing views -> silhouettes -> 3D shape. Pure functions on grayscale pixel arrays (no DOM).
// PROTOTYPE: reads outlines only. Dimensions are never read from the drawing; the item's
// length, width and height come from the cargo list.
//
// A view is a rectangle the user marks on the drawing. Inside it:
//   1. dark pixels are ink
//   2. small breaks in lines are closed (dilate, then erode)
//   3. everything the outside cannot reach is part (fills the outline)
//   4. thin strokes are removed (erode, then dilate): dimension lines, leaders, text
//   5. the largest connected piece is the part
// The silhouette is then sampled on an n x n grid; a cell counts as part if any pixel in it
// is part, so the shape is never smaller than the drawn outline.

// Square-kernel dilation (max) or erosion (min) with radius r, separable, using prefix sums.
// Outside the image counts as background, so erosion clears a border of r pixels.
function morph(src, w, h, r, dilate) {
  if (r <= 0) return Uint8Array.from(src, v => (v ? 1 : 0));
  const pass = (inp, len, count, stride, step) => {
    const out = new Uint8Array(w * h);
    const pre = new Int32Array(len + 1);
    for (let c = 0; c < count; c++) {
      const base = c * stride;
      for (let i = 0; i < len; i++) pre[i + 1] = pre[i] + (inp[base + i * step] ? 1 : 0);
      for (let i = 0; i < len; i++) {
        const lo = i - r, hi = i + r;
        const sum = pre[Math.min(len, hi + 1)] - pre[Math.max(0, lo)];
        out[base + i * step] = dilate ? (sum > 0 ? 1 : 0) : (lo >= 0 && hi < len && sum === 2 * r + 1 ? 1 : 0);
      }
    }
    return out;
  };
  const rows = pass(src, w, h, w, 1);   // along x
  return pass(rows, h, w, 1, w);        // along y
}

// Pixels of value 0 reachable from the border (4-connected).
function outsideOf(mask, w, h) {
  const out = new Uint8Array(w * h);
  const stack = [];
  const push = (x, y) => {
    const k = y * w + x;
    if (!mask[k] && !out[k]) { out[k] = 1; stack.push(k); }
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (stack.length) {
    const k = stack.pop(), x = k % w, y = (k - x) / w;
    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }
  return out;
}

// Largest 4-connected component of value 1.
function largestComponent(mask, w, h) {
  const label = new Int32Array(w * h);
  let best = 0, bestSize = 0, next = 1;
  const stack = [];
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || label[s]) continue;
    let size = 0;
    label[s] = next;
    stack.push(s);
    while (stack.length) {
      const k = stack.pop(), x = k % w;
      size++;
      for (const n of [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, k - w, k + w]) {
        if (n >= 0 && n < w * h && mask[n] && !label[n]) { label[n] = next; stack.push(n); }
      }
    }
    if (size > bestSize) { bestSize = size; best = next; }
    next++;
  }
  const out = new Uint8Array(w * h);
  if (best) for (let k = 0; k < w * h; k++) out[k] = label[k] === best ? 1 : 0;
  return { mask: out, size: bestSize };
}

// gray: 0..255 per pixel (W x H image); rect: {x, y, w, h} in image pixels.
// opts.threshold (ink below it, default 160), opts.close (px, default auto),
// opts.clean (px, thin strokes up to about 2*clean+1 px are removed, default auto),
// opts.minStroke (px, default 0 = off): lines thinner than this are ignored before the
//   outline is filled. Visible outlines are usually drawn thicker than dimension and
//   extension lines; without this, a dimension line that closes a box with the outline
//   would be filled as part of the part.
// Returns { mask, w, h, bbox: {x, y, w, h} (in image pixels), area } or null if nothing found.
function extractSilhouette(gray, W, H, rect, opts = {}) {
  const x0 = Math.max(0, Math.floor(rect.x)), y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(W, Math.ceil(rect.x + rect.w)), y1 = Math.min(H, Math.ceil(rect.y + rect.h));
  const w = x1 - x0, h = y1 - y0;
  if (w < 3 || h < 3) return null;
  const thr = opts.threshold == null ? 160 : opts.threshold;
  const size = Math.min(w, h);
  const close = opts.close == null ? Math.max(1, Math.round(size / 300)) : opts.close;
  const clean = opts.clean == null ? Math.max(2, Math.round(size / 100)) : opts.clean;

  let ink = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) ink[y * w + x] = gray[(y0 + y) * W + x0 + x] < thr ? 1 : 0;
  const thin = Math.floor((opts.minStroke || 0) / 2);
  if (thin > 0) ink = morph(morph(ink, w, h, thin, false), w, h, thin, true);
  ink = morph(morph(ink, w, h, close, true), w, h, close, false);
  const out = outsideOf(ink, w, h);
  let part = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) part[k] = out[k] ? 0 : 1;
  part = morph(morph(part, w, h, clean, false), w, h, clean, true);
  const comp = largestComponent(part, w, h);
  if (!comp.size) return null;

  let bx0 = w, by0 = h, bx1 = -1, by1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!comp.mask[y * w + x]) continue;
    if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
    if (y < by0) by0 = y; if (y > by1) by1 = y;
  }
  const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
  const mask = new Uint8Array(bw * bh);
  let area = 0;
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const v = comp.mask[(by0 + y) * w + bx0 + x];
    mask[y * bw + x] = v;
    area += v;
  }
  return { mask, w: bw, h: bh, bbox: { x: x0 + bx0, y: y0 + by0, w: bw, h: bh }, area: area / (bw * bh) };
}

// Turns a silhouette by 90 degrees clockwise (for views drawn the other way round).
function rotateSilhouette(s) {
  const w = s.h, h = s.w, mask = new Uint8Array(w * h);
  for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) mask[x * w + (w - 1 - y)] = s.mask[y * s.w + x];
  return { ...s, mask, w, h, bbox: { ...s.bbox, w: s.bbox.h, h: s.bbox.w } };
}

// Samples a silhouette on nx x ny cells; a cell is part if any pixel in it is part.
// flipY: row 0 of the result is the bottom row of the image (for side views, z up).
function sampleGrid(s, nx, ny, flipY) {
  const g = new Array(nx * ny).fill(0);
  for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
    if (!s.mask[y * s.w + x]) continue;
    const i = Math.min(nx - 1, Math.floor(x * nx / s.w));
    let j = Math.min(ny - 1, Math.floor(y * ny / s.h));
    if (flipY) j = ny - 1 - j;
    g[i + nx * j] = 1;
  }
  return g;
}

// top: silhouette of the top view (horizontal = length x, vertical = width y)
// side: silhouette of the side view (horizontal = length x, vertical = height z, up)
// Both views must show the length along the horizontal axis at the same drawing scale.
// Returns { top, side, n, ratios, warnings } where top/side are n x n grids for hullShape.
function viewsToGrids(top, side, n = 32) {
  const warnings = [];
  const lenRatio = top.w / side.w;
  if (Math.abs(lenRatio - 1) > 0.05) {
    warnings.push(`Üst ve yan görünüşte boy (yatay) farklı çıktı (oran ${lenRatio.toFixed(2)}). İki görünüş aynı ölçekte ve boy yatayda olmalı; gerekirse bir görünüşü döndür.`);
  }
  return {
    top: sampleGrid(top, n, n, false),
    side: sampleGrid(side, n, n, true),
    n,
    // proportions read from the drawing (same scale assumed): width / length, height / length
    ratios: { wPerL: top.h / top.w, hPerL: side.h / ((top.w + side.w) / 2) },
    warnings
  };
}

// Compares the drawing proportions with the cargo list dimensions; returns warnings.
function checkDims(ratios, l, w, h, tol = 0.1) {
  const out = [];
  const ew = l * ratios.wPerL, eh = l * ratios.hPerL;
  if (Math.abs(ew - w) > tol * w) out.push(`Çizimin oranına göre genişlik ≈ ${ew.toFixed(2)} m olmalı, listede ${w} m.`);
  if (Math.abs(eh - h) > tol * h) out.push(`Çizimin oranına göre yükseklik ≈ ${eh.toFixed(2)} m olmalı, listede ${h} m.`);
  return out;
}

// RGBA (canvas ImageData.data) -> gray
function toGray(rgba, w, h) {
  const g = new Uint8ClampedArray(w * h);
  for (let k = 0, p = 0; k < w * h; k++, p += 4) {
    const a = rgba[p + 3] / 255; // transparent pixels count as white paper
    g[k] = (0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]) * a + 255 * (1 - a);
  }
  return g;
}

if (typeof module !== 'undefined') {
  module.exports = { morph, outsideOf, largestComponent, extractSilhouette, rotateSilhouette, sampleGrid, viewsToGrids, checkDims, toGray };
}

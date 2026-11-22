// Browser test of dist/index.html (optional, needs Playwright with Chromium).
//   npm run build && node tests/e2e.js
// PDF part: pdf.js is fetched from cdnjs by the page. Set PDFJS_DIR to a local copy of
// pdfjs-dist@3.11.174/build (pdf.min.js, pdf.worker.min.js) to serve it offline;
// without it the PDF step is skipped.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const page_url = 'file://' + path.join(root, 'dist/index.html');
const PDFJS_DIR = process.env.PDFJS_DIR;
const SHOTS = process.env.SHOTS; // optional folder for screenshots

// Made-up two-view drawing of a press frame: 3 m long, 1.5 m wide, 2.5 m high, with a
// 1 m deep cut-out at the top of the middle. Outlines 5 px, dimensions 1 px.
const DRAWING_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="800" viewBox="0 0 1000 800">
  <rect width="1000" height="800" fill="#fff"/>
  <g fill="none" stroke="#000" stroke-width="5">
    <rect x="100" y="100" width="300" height="150"/>
    <polygon points="100,650 400,650 400,400 300,400 300,500 200,500 200,400 100,400"/>
  </g>
  <g fill="none" stroke="#000" stroke-width="1">
    <line x1="100" y1="250" x2="100" y2="300"/><line x1="400" y1="250" x2="400" y2="300"/>
    <line x1="100" y1="290" x2="400" y2="290"/>
    <line x1="400" y1="650" x2="460" y2="650"/><line x1="400" y1="400" x2="460" y2="400"/>
    <line x1="450" y1="400" x2="450" y2="650"/>
    <line x1="80" y1="175" x2="420" y2="175" stroke-dasharray="20 6 4 6"/>
  </g>
  <g font-family="sans-serif" font-size="22">
    <text x="220" y="280">3000</text><text x="460" y="530">2500</text>
    <text x="100" y="80">ÜST</text><text x="100" y="380">YAN</text>
  </g>
</svg>`;
const VIEWS = { top: { x: 80, y: 90, w: 340, h: 230 }, side: { x: 80, y: 390, w: 400, h: 280 } }; // in SVG px

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 2600 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  if (PDFJS_DIR) {
    await page.route('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/*', route => {
      const f = path.join(PDFJS_DIR, path.basename(new URL(route.request().url()).pathname));
      route.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(f) });
    });
  }
  await page.goto(page_url);
  const out = async () => (await page.textContent('#out')).replace(/\s+/g, ' ');
  const shot = async name => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true }); };

  // 1. sample plan with cylinders
  let txt = await out();
  assert(/Yerleşen: \d+/.test(txt), txt.slice(0, 200));
  assert(await page.$('#out svg ellipse'), 'upright coil drawn as a circle in the top view');
  assert(/silindir, dik/.test(txt) && /silindir, boyuna/.test(txt));
  console.log('ok sample plan:', txt.match(/Toplam kalem: \d+ \| Yerleşen: \d+ \| Yerleşmeyen: \d+/)[0]);

  // 2. a cylinder without orientation is not planned, the user is asked
  const sample = await page.inputValue('#cargo');
  await page.fill('#cargo', sample.replace('silindir,dik', 'silindir,'));
  await page.click('#run');
  txt = await out();
  assert(/yatış yönünü seç/.test(txt) && /Plan oluşturulmadı/.test(txt), txt);
  console.log('ok cylinder without orientation is asked for');
  await page.fill('#cargo', sample);

  // 3. example drawing
  await page.click('#dwgSample');
  assert(/Makine E/.test(await page.inputValue('#cargo')));
  assert(/kaydedildi/.test(await page.textContent('#dwgInfo')));
  await page.click('#run');
  txt = await out();
  assert(/Makine E #1/.test(txt) && /çizim \(kutunun %\d+'i\)/.test(txt), txt.slice(0, 300));
  assert(await page.$('#out svg path'), 'drawn shape rendered as cell path');
  const pct = await page.evaluate(() => shapes['Makine E'].volFrac);
  assert(pct >= 0.75 && pct < 0.85, String(pct));
  console.log(`ok example drawing: Makine E hull ${(100 * pct).toFixed(1)}% of its box (exact 75%)`);
  await shot('e2e-sample-drawing');

  // helper: drag a rectangle given in drawing-image pixels
  const drag = async (r) => {
    const box = await page.$eval('#dwgCanvas', c => { const b = c.getBoundingClientRect(); return { x: b.left + scrollX, y: b.top + scrollY, w: b.width, W: c.width, H: c.height }; });
    const k = box.w / box.W;
    await page.mouse.move(box.x + r.x * k - scrollXY.x, box.y + r.y * k - scrollXY.y);
    await page.mouse.down();
    await page.mouse.move(box.x + (r.x + r.w / 2) * k - scrollXY.x, box.y + (r.y + r.h / 2) * k - scrollXY.y, { steps: 3 });
    await page.mouse.move(box.x + (r.x + r.w) * k - scrollXY.x, box.y + (r.y + r.h) * k - scrollXY.y, { steps: 3 });
    await page.mouse.up();
  };
  let scrollXY = { x: 0, y: 0 };
  const prepareDrag = async () => {
    await page.$eval('#dwgCanvas', c => c.scrollIntoView({ block: 'start' }));
    scrollXY = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
  };
  const addItem = async (row) => {
    await page.fill('#cargo', (await page.inputValue('#cargo')).replace(/\s*$/, '') + '\n' + row);
    await page.dispatchEvent('#cargo', 'input');
  };
  const expectPress = async (label) => {
    await page.selectOption('#dwgItem', 'Pres F');
    const info = await page.textContent('#dwgInfo');
    const vf = await page.evaluate(() => dwg.hull && dwg.hull.volFrac);
    // exact: (3*2.5 - 1*1) / (3*2.5) = 0.8667 of the box
    assert(vf >= 0.86 && vf < 0.95, `${label}: volFrac ${vf} | ${info}`);
    assert(!/oranına göre/.test(info), `${label}: proportions warning: ${info}`);
    await page.click('#dwgSave');
    await page.click('#run');
    const t = await out();
    assert(/Pres F #1/.test(t), t.slice(0, 300));
    console.log(`ok ${label}: Pres F hull ${(100 * vf).toFixed(1)}% of its box (exact 86.7%)`);
  };
  await addItem('Pres F,3,1.5,2.5,7,1,1,yes,,,cizim,');

  // 4. PDF upload, views selected with the mouse
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stowage-e2e-'));
  if (PDFJS_DIR) {
    const p2 = await ctx.newPage();
    await p2.setContent(`<html><body style="margin:0">${DRAWING_SVG}</body></html>`);
    const pdfFile = path.join(tmp, 'pres.pdf');
    await p2.pdf({ path: pdfFile, width: '1000px', height: '800px', printBackground: true, pageRanges: '1' });
    await p2.close();
    await page.setInputFiles('#dwgFile', pdfFile);
    await page.waitForFunction(() => /pres\.pdf/.test(dwg.label), null, { timeout: 30000 });
    const W = await page.$eval('#dwgCanvas', c => c.width);
    const k = W / 1000; // drawing px -> rendered px
    await page.fill('#dwgStroke', '4');
    await page.dispatchEvent('#dwgStroke', 'change');
    await prepareDrag();
    for (const v of ['top', 'side']) {
      const r = VIEWS[v];
      await page.click(v === 'top' ? '#selTop' : '#selSide');
      await prepareDrag();
      await drag({ x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k });
    }
    await expectPress('PDF upload');
    await shot('e2e-pdf');
  } else {
    console.log('skip PDF upload (set PDFJS_DIR to run it offline)');
  }

  // 5. PNG upload
  const p3 = await ctx.newPage();
  await p3.setViewportSize({ width: 1000, height: 800 });
  await p3.setContent(`<html><body style="margin:0">${DRAWING_SVG}</body></html>`);
  const pngFile = path.join(tmp, 'pres.png');
  await p3.screenshot({ path: pngFile });
  await p3.close();
  await page.setInputFiles('#dwgFile', pngFile);
  await page.waitForFunction(() => dwg.label === 'pres.png');
  await page.fill('#dwgStroke', '4');
  await page.dispatchEvent('#dwgStroke', 'change');
  for (const v of ['top', 'side']) {
    await page.click(v === 'top' ? '#selTop' : '#selSide');
    await prepareDrag();
    await drag(VIEWS[v]);
  }
  await expectPress('PNG upload');

  // 6. shapes survive a reload (browser storage)
  await page.reload();
  assert(await page.evaluate(() => !!shapes['Pres F'] && !!shapes['Makine E']));
  console.log('ok shapes kept after reload');

  assert.deepStrictEqual(errors, []);
  await browser.close();
  console.log('e2e passed');
}

main().catch(e => { console.error(e); process.exit(1); });

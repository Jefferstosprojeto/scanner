// Ferramentas extras: Excel, QR Code, carteira (frente/verso), livro, carimbo de data.
import { loadScript } from './util.js';
import { makeCanvas, blobToCanvas, toBlob, release, loadImage } from './imaging.js';
import { recognize, linesOf } from './ocr.js';

const XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
const JSQR_URL = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';

// ---------- Excel ----------

/** Separa uma linha do OCR em células usando os espaços grandes entre palavras. */
function lineToCells(line) {
  const words = line.words.filter((w) => w.text.trim());
  if (!words.length) return [];
  const widths = words.map((w) => (w.bbox.x1 - w.bbox.x0) / Math.max(1, w.text.length));
  const charW = widths.sort((a, b) => a - b)[widths.length >> 1] || 10;
  const cells = [];
  let cur = words[0].text;
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].bbox.x0 - words[i - 1].bbox.x1;
    if (gap > charW * 2.2) { cells.push(cur); cur = words[i].text; } else cur += ` ${words[i].text}`;
  }
  cells.push(cur);
  // números no formato brasileiro viram números de verdade
  return cells.map((c) => {
    const t = c.trim();
    if (/^-?R?\$?\s?\d{1,3}(\.\d{3})*(,\d+)?$|^-?\d+(,\d+)?$/.test(t)) {
      const n = Number(t.replace(/[R$\s.]/g, '').replace(',', '.'));
      if (Number.isFinite(n)) return n;
    }
    return t;
  });
}

export async function buildXlsx({ pages, onStatus }) {
  onStatus('Preparando Excel…', 0);
  await loadScript(XLSX_URL);
  const X = window.XLSX;
  const wb = X.utils.book_new();
  for (let i = 0; i < pages.length; i++) {
    const label = `Lendo tabela da página ${i + 1} de ${pages.length}…`;
    onStatus(label, i / pages.length);
    const data = await recognize(pages[i].base || pages[i].processed, (p) => onStatus(label, (i + p) / pages.length));
    const rows = linesOf(data).map(lineToCells).filter((r) => r.length);
    const ws = X.utils.aoa_to_sheet(rows.length ? rows : [['(nenhum texto reconhecido)']]);
    const cols = Math.max(1, ...rows.map((r) => r.length));
    ws['!cols'] = Array.from({ length: cols }, (_, c) => ({ wch: Math.min(50, Math.max(8, ...rows.map((r) => String(r[c] ?? '').length))) }));
    X.utils.book_append_sheet(wb, ws, `Página ${i + 1}`);
  }
  const out = X.write(wb, { bookType: 'xlsx', type: 'array' });
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

// ---------- QR Code ----------

export async function readQr(file) {
  await loadScript(JSQR_URL);
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    for (const side of [1000, 1600, 700, 2200]) {
      const s = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
      const c = makeCanvas(img.naturalWidth * s, img.naturalHeight * s);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const d = ctx.getImageData(0, 0, c.width, c.height);
      const r = window.jsQR(d.data, c.width, c.height, { inversionAttempts: 'attemptBoth' });
      release(c);
      if (r && r.data) return r.data;
    }
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------- Carteira / RG: frente e verso numa A4 ----------

export async function composeIdCard(frontBlob, backBlob) {
  // A4 a 200 dpi; cartão padrão 85,6 x 54 mm
  const W = 1654, H = 2339, mm = 200 / 25.4;
  const page = makeCanvas(W, H);
  const ctx = page.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  const cardW = Math.round(85.6 * mm * 1.25), cardH = Math.round(54 * mm * 1.25); // um pouco maior para ficar legível
  const imgs = [await blobToCanvas(frontBlob), await blobToCanvas(backBlob)];
  imgs.forEach((im, i) => {
    let src = im;
    if (im.height > im.width) { // cartão fotografado em pé: deita
      src = makeCanvas(im.height, im.width);
      const c2 = src.getContext('2d');
      c2.translate(src.width / 2, src.height / 2); c2.rotate(-Math.PI / 2); c2.drawImage(im, -im.width / 2, -im.height / 2);
    }
    const x = (W - cardW) / 2, y = 260 + i * (cardH + 220);
    ctx.drawImage(src, x, y, cardW, cardH);
    ctx.strokeStyle = '#d0d0d0'; ctx.lineWidth = 2; ctx.strokeRect(x, y, cardW, cardH);
    if (src !== im) release(src);
    release(im);
  });
  const blob = await toBlob(page, 'image/jpeg', 0.92);
  release(page);
  return blob;
}

// ---------- Livro: divide a página dupla em duas ----------

export async function splitBook(blob) {
  const c = await blobToCanvas(blob);
  const half = Math.floor(c.width / 2);
  const parts = [];
  for (const x of [0, half]) {
    const p = makeCanvas(x === 0 ? half : c.width - half, c.height);
    p.getContext('2d').drawImage(c, -x, 0);
    parts.push({ blob: await toBlob(p, 'image/jpeg', 0.92), w: p.width, h: p.height });
    release(p);
  }
  release(c);
  return parts;
}

// ---------- Carimbo de data/hora ----------

export function timestampText(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

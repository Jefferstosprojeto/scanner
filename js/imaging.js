// Processamento de imagem: carregar, recortar com correção de perspectiva, filtros e rotação.
// Tudo em JavaScript puro (Canvas), sem dependências.

export const MAX_INPUT_SIDE = 2600; // lado máximo da foto original guardada
export const MAX_OUTPUT_SIDE = 2400; // lado máximo da página recortada

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** Libera a memória de um canvas temporário (importante no iPhone). */
export function release(c) {
  if (c) { c.width = 0; c.height = 0; }
}

export function toBlob(canvas, type = 'image/jpeg', quality = 0.9) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Falha ao gerar imagem'))), type, quality));
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Imagem inválida'));
    img.src = src;
  });
}

/** Lê o arquivo da câmera/galeria, aplica a orientação EXIF e reduz para um tamanho seguro. */
export async function normalizeFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const s = Math.min(1, MAX_INPUT_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const c = makeCanvas(img.naturalWidth * s, img.naturalHeight * s);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const blob = await toBlob(c, 'image/jpeg', 0.92);
    const out = { blob, width: c.width, height: c.height };
    release(c);
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function blobToCanvas(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const c = makeCanvas(img.naturalWidth, img.naturalHeight);
    c.getContext('2d').drawImage(img, 0, 0);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function resizeCanvas(src, maxSide) {
  const s = maxSide / Math.max(src.width, src.height);
  if (s >= 1) return src;
  const c = makeCanvas(src.width * s, src.height * s);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

export function defaultCorners(w, h, m = 0.06) {
  return [[w * m, h * m], [w * (1 - m), h * m], [w * (1 - m), h * (1 - m)], [w * m, h * (1 - m)]];
}
export function fullCorners(w, h) {
  return [[0, 0], [w, 0], [w, h], [0, h]];
}

export function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

/** Coloca os 4 pontos na ordem: sup-esq, sup-dir, inf-dir, inf-esq. */
export function orderCorners(pts) {
  const bySum = [...pts].sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]));
  const byDiff = [...pts].sort((a, b) => (a[1] - a[0]) - (b[1] - b[0]));
  return [bySum[0], byDiff[0], bySum[3], byDiff[3]];
}

// ---------- Correção de perspectiva ----------

function solveLinear(A, b) {
  const n = b.length;
  for (let i = 0; i < n; i++) {
    let max = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[max][i])) max = r;
    [A[i], A[max]] = [A[max], A[i]];
    [b[i], b[max]] = [b[max], b[i]];
    const piv = A[i][i];
    if (Math.abs(piv) < 1e-12) throw new Error('Recorte inválido');
    for (let r = i + 1; r < n; r++) {
      const f = A[r][i] / piv;
      for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
      b[r] -= f * b[i];
    }
  }
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c];
    x[i] = s / A[i][i];
  }
  return x;
}

/** Homografia que leva os 4 pontos `from` para os 4 pontos `to`. */
export function homography(from, to) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = from[i], [x, y] = to[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
  }
  return solveLinear(A, b);
}

const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);

/** Recorta o quadrilátero `corners` do canvas e o "achata" num retângulo. */
export function warp(src, corners, maxSide = MAX_OUTPUT_SIDE) {
  const [tl, tr, br, bl] = corners;
  let outW = Math.max(dist(tl, tr), dist(bl, br));
  let outH = Math.max(dist(tl, bl), dist(tr, br));
  const s = Math.min(1, maxSide / Math.max(outW, outH));
  outW = Math.max(1, Math.round(outW * s));
  outH = Math.max(1, Math.round(outH * s));

  const [a, b, c, d, e, f, g, h] = homography(
    [[0, 0], [outW, 0], [outW, outH], [0, outH]], [tl, tr, br, bl]);

  const sw = src.width, sh = src.height;
  const sd = src.getContext('2d').getImageData(0, 0, sw, sh).data;
  const out = new ImageData(outW, outH);
  const od = out.data;
  const maxX = sw - 1, maxY = sh - 1;
  let o = 0;
  for (let v = 0; v < outH; v++) {
    const vv = v + 0.5;
    for (let u = 0; u < outW; u++) {
      const uu = u + 0.5;
      const den = g * uu + h * vv + 1;
      let x = (a * uu + b * vv + c) / den - 0.5;
      let y = (d * uu + e * vv + f) / den - 0.5;
      if (x < 0) x = 0; else if (x > maxX) x = maxX;
      if (y < 0) y = 0; else if (y > maxY) y = maxY;
      const x0 = x | 0, y0 = y | 0;
      const x1 = x0 < maxX ? x0 + 1 : x0, y1 = y0 < maxY ? y0 + 1 : y0;
      const fx = x - x0, fy = y - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
      for (let k = 0; k < 3; k++) {
        const top = sd[i00 + k] + (sd[i10 + k] - sd[i00 + k]) * fx;
        const bot = sd[i01 + k] + (sd[i11 + k] - sd[i01 + k]) * fx;
        od[o + k] = top + (bot - top) * fy;
      }
      od[o + 3] = 255;
      o += 4;
    }
  }
  const canvas = makeCanvas(outW, outH);
  canvas.getContext('2d').putImageData(out, 0, 0);
  return canvas;
}

// ---------- Filtros ----------

export const FILTERS = [
  { id: 'original', label: 'Original' },
  { id: 'enhance', label: 'Realçar' },
  { id: 'gray', label: 'Cinza' },
  { id: 'bw', label: 'P&B' },
];

/** Estima a cor do "papel" em cada região (remove sombras e iluminação desigual). */
function paperBackground(canvas) {
  const w = canvas.width, h = canvas.height;
  const sw = Math.max(12, Math.round(w / 24)), sh = Math.max(12, Math.round(h / 24));
  const small = makeCanvas(sw, sh);
  const sctx = small.getContext('2d');
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(canvas, 0, 0, sw, sh);
  const img = sctx.getImageData(0, 0, sw, sh);
  let d = img.data;

  // Dilatação (máximo) remove o texto, sobrando a cor do papel.
  const dilate = (data, r) => {
    const out = new Uint8ClampedArray(data.length);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        let m0 = 0, m1 = 0, m2 = 0;
        for (let dy = -r; dy <= r; dy++) {
          const yy = Math.min(sh - 1, Math.max(0, y + dy));
          for (let dx = -r; dx <= r; dx++) {
            const xx = Math.min(sw - 1, Math.max(0, x + dx));
            const i = (yy * sw + xx) * 4;
            if (data[i] > m0) m0 = data[i];
            if (data[i + 1] > m1) m1 = data[i + 1];
            if (data[i + 2] > m2) m2 = data[i + 2];
          }
        }
        const o = (y * sw + x) * 4;
        out[o] = m0; out[o + 1] = m1; out[o + 2] = m2; out[o + 3] = 255;
      }
    }
    return out;
  };
  // Suavização (média 3x3) para evitar degraus.
  const blur = (data) => {
    const out = new Uint8ClampedArray(data.length);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        let s0 = 0, s1 = 0, s2 = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= sh) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= sw) continue;
            const i = (yy * sw + xx) * 4;
            s0 += data[i]; s1 += data[i + 1]; s2 += data[i + 2]; n++;
          }
        }
        const o = (y * sw + x) * 4;
        out[o] = s0 / n; out[o + 1] = s1 / n; out[o + 2] = s2 / n; out[o + 3] = 255;
      }
    }
    return out;
  };
  d = blur(dilate(dilate(d, 2), 1));
  img.data.set(d);
  sctx.putImageData(img, 0, 0);

  const big = makeCanvas(w, h);
  const bctx = big.getContext('2d');
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(small, 0, 0, w, h);
  const bg = bctx.getImageData(0, 0, w, h).data;
  release(small); release(big);
  return bg;
}

const LUT_ENHANCE = new Uint8ClampedArray(256);
for (let i = 0; i < 256; i++) LUT_ENHANCE[i] = 255 * Math.pow(i / 255, 1.6);

/** Aplica um filtro e devolve um NOVO canvas (o original não é alterado). */
export function applyFilter(src, filter) {
  const w = src.width, h = src.height;
  const out = makeCanvas(w, h);
  const octx = out.getContext('2d');
  if (filter === 'original' || !filter) {
    octx.drawImage(src, 0, 0);
    return out;
  }
  const img = src.getContext('2d').getImageData(0, 0, w, h);
  const d = img.data;
  const bg = paperBackground(src);
  const n = d.length;

  for (let i = 0; i < n; i += 4) {
    // Normaliza pelo papel: fundo vira branco, sombras somem.
    const r = Math.min(255, (d[i] * 268) / (bg[i] || 1));
    const g = Math.min(255, (d[i + 1] * 268) / (bg[i + 1] || 1));
    const b = Math.min(255, (d[i + 2] * 268) / (bg[i + 2] || 1));
    if (filter === 'enhance') {
      d[i] = LUT_ENHANCE[r | 0]; d[i + 1] = LUT_ENHANCE[g | 0]; d[i + 2] = LUT_ENHANCE[b | 0];
    } else {
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const v = filter === 'bw' ? (lum < 185 ? 0 : 255) : LUT_ENHANCE[lum | 0];
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

export function rotateCanvas(src, deg) {
  const r = ((deg % 360) + 360) % 360;
  if (r === 0) return src;
  const swap = r === 90 || r === 270;
  const c = makeCanvas(swap ? src.height : src.width, swap ? src.width : src.height);
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((r * Math.PI) / 180);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

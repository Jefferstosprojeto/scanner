// Detecção automática das bordas do documento.
// 1º tenta com OpenCV.js (várias estratégias); se não carregar a tempo, usa um detector reserva em JS puro.
import { orderCorners, polygonArea } from './imaging.js';

const OPENCV_URL = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js';
const OPENCV_WAIT_MS = 12000; // quanto esperar o OpenCV antes de usar o detector reserva
let loading = null;

/** Carrega o OpenCV uma única vez. Resolve com { cv } (embrulhado para evitar o "thenable" do Emscripten). */
export function loadOpenCV() {
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Tempo esgotado ao carregar OpenCV')), 120000);
    const finish = (cv) => { clearTimeout(timer); resolve({ cv }); };

    const waitReady = () => {
      const cv = window.cv;
      if (!cv) { clearTimeout(timer); reject(new Error('OpenCV indisponível')); return; }
      if (cv.Mat) { finish(cv); return; }
      if (typeof cv.then === 'function') {
        cv.then((mod) => { window.cv = mod; finish(mod); });
        return;
      }
      cv.onRuntimeInitialized = () => finish(window.cv);
      const poll = setInterval(() => { if (window.cv && window.cv.Mat) { clearInterval(poll); finish(window.cv); } }, 200);
      setTimeout(() => clearInterval(poll), 120000);
    };

    const s = document.createElement('script');
    s.src = OPENCV_URL;
    s.async = true;
    s.onload = waitReady;
    s.onerror = () => { clearTimeout(timer); reject(new Error('Falha ao baixar OpenCV')); };
    document.head.appendChild(s);
  });
  loading.catch(() => { loading = null; }); // permite tentar de novo depois
  return loading;
}

export function preloadOpenCV() {
  loadOpenCV().catch(() => {});
}

/** Devolve os 4 cantos do documento (em pixels do canvas) ou null se não encontrar. */
export async function detectCorners(canvas) {
  let cv = null;
  try {
    ({ cv } = await Promise.race([
      loadOpenCV(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('OpenCV demorando')), OPENCV_WAIT_MS)),
    ]));
  } catch (e) {
    console.warn('[detecção] usando detector reserva:', e.message);
  }
  let quad = null;
  if (cv) {
    try { quad = detectWithOpenCV(cv, canvas); } catch (e) { console.warn('[detecção] OpenCV falhou', e); }
  }
  if (!quad) quad = detectWithJS(canvas);
  return quad ? finalize(quad, canvas.width, canvas.height) : null;
}

/** Ordena e recua os cantos ~0,7% em direção ao centro para não pegar a borda do fundo. */
function finalize(pts, w, h) {
  const cx = pts.reduce((a, p) => a + p[0], 0) / 4, cy = pts.reduce((a, p) => a + p[1], 0) / 4;
  return orderCorners(pts.map(([x, y]) => [
    Math.min(w, Math.max(0, x + (cx - x) * 0.014)),
    Math.min(h, Math.max(0, y + (cy - y) * 0.014)),
  ]));
}

function downscale(canvas, maxSide) {
  const s = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(canvas.width * s));
  c.height = Math.max(1, Math.round(canvas.height * s));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, c.width, c.height);
  return { c, ctx, s };
}

// ======================= OpenCV =======================

function readQuad(mat) {
  const pts = [];
  for (let k = 0; k < 4; k++) pts.push([mat.data32S[k * 2], mat.data32S[k * 2 + 1]]);
  return pts;
}

/** Procura o maior quadrilátero numa imagem binária. */
function findQuad(cv, bin, imgArea) {
  const contours = new cv.MatVector();
  const hier = new cv.Mat();
  try {
    cv.findContours(bin, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    let best = null, bestArea = 0;
    let hullBest = null, hullArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      try {
        const area = cv.contourArea(cnt);
        if (area < imgArea * 0.1 || area > imgArea * 0.97) continue;
        const peri = cv.arcLength(cnt, true);

        // 1) Contorno que já é um quadrilátero convexo.
        const ap = new cv.Mat();
        cv.approxPolyDP(cnt, ap, 0.02 * peri, true);
        if (ap.rows === 4 && cv.isContourConvex(ap)) {
          const a = cv.contourArea(ap);
          if (a > bestArea && a < imgArea * 0.97) { best = readQuad(ap); bestArea = a; }
        }
        ap.delete();

        // 2) Alternativa: casco convexo simplificado até 4 pontos (cantos arredondados/dobrados).
        if (area > hullArea) {
          const hull = new cv.Mat();
          cv.convexHull(cnt, hull, false, true);
          const hp = cv.arcLength(hull, true);
          for (const eps of [0.02, 0.03, 0.045, 0.06, 0.08]) {
            const hap = new cv.Mat();
            cv.approxPolyDP(hull, hap, eps * hp, true);
            const rows = hap.rows;
            if (rows === 4) {
              const a = cv.contourArea(hap);
              // só aceita se o contorno realmente preenche o quadrilátero (evita formas tortas)
              if (a < imgArea * 0.97 && area >= a * 0.8 && cv.isContourConvex(hap)) { hullBest = readQuad(hap); hullArea = area; }
              hap.delete();
              break;
            }
            hap.delete();
            if (rows < 4) break;
          }
          hull.delete();
        }
      } finally {
        cnt.delete();
      }
    }
    return best || hullBest;
  } finally {
    contours.delete();
    hier.delete();
  }
}

function medianOf(u8) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < u8.length; i++) hist[u8[i]]++;
  let acc = 0;
  const half = u8.length / 2;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= half) return v; }
  return 128;
}

function detectWithOpenCV(cv, canvas) {
  const { c: small, s } = downscale(canvas, 640);
  const sw = small.width, sh = small.height, area = sw * sh;
  const mats = [];
  const keep = (m) => { mats.push(m); return m; };
  try {
    const src = keep(cv.imread(small));
    const gray = keep(new cv.Mat());
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const blur = keep(new cv.Mat());
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);

    // Remove o texto (escuro sobre papel claro) para sobrar só a silhueta da folha.
    const k9 = keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9)));
    const clean = keep(new cv.Mat());
    cv.morphologyEx(blur, clean, cv.MORPH_CLOSE, k9);

    const k3 = keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));
    const k5 = keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5)));
    const edges = keep(new cv.Mat());
    const anchor = new cv.Point(-1, -1);
    const med = medianOf(clean.data);
    const tries = [
      [Math.max(5, 0.66 * med), Math.min(255, 1.33 * med)],
      [15, 45],          // baixo contraste (folha branca sobre mesa clara)
      [50, 150],
    ];

    // Passos 1–3: bordas com sensibilidades diferentes.
    for (const [lo, hi] of tries) {
      cv.Canny(clean, edges, lo, hi);
      cv.dilate(edges, edges, k3, anchor, 2);
      const q = findQuad(cv, edges, area);
      if (q) return q.map(([x, y]) => [x / s, y / s]);
    }

    // Passo 4: folha encostando na borda da foto — fecha o contorno com a moldura.
    cv.Canny(clean, edges, 15, 45);
    cv.dilate(edges, edges, k3, anchor, 2);
    cv.rectangle(edges, new cv.Point(0, 0), new cv.Point(sw - 1, sh - 1), new cv.Scalar(255), 3);
    let q = findQuad(cv, edges, area);
    if (q) return q.map(([x, y]) => [x / s, y / s]);

    // Passo 5: papel mais claro que o fundo (limiar de Otsu).
    const bin = keep(new cv.Mat());
    cv.threshold(clean, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    cv.morphologyEx(bin, bin, cv.MORPH_OPEN, k5);
    q = findQuad(cv, bin, area);
    if (q) return q.map(([x, y]) => [x / s, y / s]);
    return null;
  } finally {
    mats.forEach((m) => m.delete());
    small.width = 0; small.height = 0;
  }
}

// ======================= Reserva em JS puro =======================
// Acha a maior região clara (o papel) e pega seus 4 pontos extremos.

export function detectWithJS(canvas) {
  const { c, ctx, s } = downscale(canvas, 320);
  const w = c.width, h = c.height, n = w * h;
  const data = ctx.getImageData(0, 0, w, h).data;
  c.width = 0; c.height = 0;

  // Cinza + "fechamento" simples (máximo 5x5) para apagar o texto.
  const gray = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) gray[i] = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8;
  const maxF = (src, r) => {
    const tmp = new Uint8Array(n), out = new Uint8Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let m = 0;
      for (let d = -r; d <= r; d++) { const xx = Math.min(w - 1, Math.max(0, x + d)); const v = src[y * w + xx]; if (v > m) m = v; }
      tmp[y * w + x] = m;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let m = 0;
      for (let d = -r; d <= r; d++) { const yy = Math.min(h - 1, Math.max(0, y + d)); const v = tmp[yy * w + x]; if (v > m) m = v; }
      out[y * w + x] = m;
    }
    return out;
  };
  const g = maxF(gray, 2);

  // Limiar de Otsu.
  const hist = new Float64Array(256);
  for (let i = 0; i < n; i++) hist[g[i]]++;
  let sum = 0; for (let v = 0; v < 256; v++) sum += v * hist[v];
  let sumB = 0, wB = 0, best = 0, t = 128;
  for (let v = 0; v < 256; v++) {
    wB += hist[v]; if (!wB) continue;
    const wF = n - wB; if (!wF) break;
    sumB += v * hist[v];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; t = v; }
  }

  // Maior região conectada acima do limiar.
  const label = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  let bestId = -1, bestSize = 0;
  for (let start = 0, id = 0; start < n; start++) {
    if (g[start] <= t || label[start] !== -1) continue;
    let sp = 0, size = 0;
    stack[sp++] = start; label[start] = id;
    while (sp) {
      const p = stack[--sp]; size++;
      const x = p % w, y = (p / w) | 0;
      if (x > 0 && g[p - 1] > t && label[p - 1] === -1) { label[p - 1] = id; stack[sp++] = p - 1; }
      if (x < w - 1 && g[p + 1] > t && label[p + 1] === -1) { label[p + 1] = id; stack[sp++] = p + 1; }
      if (y > 0 && g[p - w] > t && label[p - w] === -1) { label[p - w] = id; stack[sp++] = p - w; }
      if (y < h - 1 && g[p + w] > t && label[p + w] === -1) { label[p + w] = id; stack[sp++] = p + w; }
    }
    if (size > bestSize) { bestSize = size; bestId = id; }
    id++;
  }
  if (bestId < 0 || bestSize < n * 0.1 || bestSize > n * 0.97) return null;

  // Pontos extremos: sup-esq (min x+y), sup-dir (max x-y), inf-dir (max x+y), inf-esq (max y-x).
  let tl, tr, br, bl, mTL = Infinity, mTR = -Infinity, mBR = -Infinity, mBL = -Infinity;
  for (let p = 0; p < n; p++) {
    if (label[p] !== bestId) continue;
    const x = p % w, y = (p / w) | 0;
    if (x + y < mTL) { mTL = x + y; tl = [x, y]; }
    if (x - y > mTR) { mTR = x - y; tr = [x, y]; }
    if (x + y > mBR) { mBR = x + y; br = [x, y]; }
    if (y - x > mBL) { mBL = y - x; bl = [x, y]; }
  }
  const quad = [tl, tr, br, bl];
  // Confere se o quadrilátero cobre bem a região (senão a forma não é uma folha).
  const qa = polygonArea(quad);
  if (qa < bestSize * 0.8 || bestSize < qa * 0.85) return null;
  // Se a região clara toma muito da moldura da foto, ela "vazou" para a mesa: melhor não chutar.
  let border = 0;
  for (let x = 0; x < w; x++) { if (label[x] === bestId) border++; if (label[(h - 1) * w + x] === bestId) border++; }
  for (let y = 1; y < h - 1; y++) { if (label[y * w] === bestId) border++; if (label[y * w + w - 1] === bestId) border++; }
  if (border > 2 * (w + h) * 0.3) return null;
  if ([0, w - 1, (h - 1) * w, n - 1].some((p) => label[p] === bestId)) return null; // pegou um canto da foto
  return quad.map(([x, y]) => [x / s, y / s]);
}

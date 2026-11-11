// Detecção automática das bordas do documento usando OpenCV.js (carregado sob demanda).
import { orderCorners } from './imaging.js';

const OPENCV_URL = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js';
let loading = null;

/** Carrega o OpenCV uma única vez. Resolve com { cv } (embrulhado para evitar o "thenable" do Emscripten). */
export function loadOpenCV() {
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Tempo esgotado ao carregar OpenCV')), 90000);
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
      setTimeout(() => clearInterval(poll), 90000);
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
        if (area < imgArea * 0.12) continue;
        const peri = cv.arcLength(cnt, true);

        // 1) Contorno que já é um quadrilátero convexo.
        const ap = new cv.Mat();
        cv.approxPolyDP(cnt, ap, 0.02 * peri, true);
        if (ap.rows === 4 && cv.isContourConvex(ap)) {
          const a = cv.contourArea(ap);
          if (a > bestArea) { best = readQuad(ap); bestArea = a; }
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
            if (rows === 4) { hullBest = readQuad(hap); hullArea = area; hap.delete(); break; }
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

/** Devolve os 4 cantos do documento (em pixels do canvas) ou null se não encontrar. */
export async function detectCorners(canvas) {
  const { cv } = await loadOpenCV();
  const w = canvas.width, h = canvas.height;
  const s = Math.min(1, 640 / Math.max(w, h));
  const sw = Math.round(w * s), sh = Math.round(h * s);
  const small = document.createElement('canvas');
  small.width = sw; small.height = sh;
  small.getContext('2d').drawImage(canvas, 0, 0, sw, sh);

  const mats = [];
  const keep = (m) => { mats.push(m); return m; };
  try {
    const src = keep(cv.imread(small));
    const gray = keep(new cv.Mat());
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const blur = keep(new cv.Mat());
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
    const kernel = keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5)));

    // Passo 1: bordas (Canny)
    const edges = keep(new cv.Mat());
    cv.Canny(blur, edges, 40, 120);
    cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kernel);
    let quad = findQuad(cv, edges, sw * sh);

    // Passo 2: papel claro sobre fundo escuro (limiar de Otsu)
    if (!quad) {
      const bin = keep(new cv.Mat());
      cv.threshold(blur, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      cv.morphologyEx(bin, bin, cv.MORPH_OPEN, kernel);
      quad = findQuad(cv, bin, sw * sh);
    }
    if (!quad) return null;

    // Recua os cantos ~0,7% em direção ao centro para não pegar a borda do fundo.
    const pts = quad.map(([x, y]) => [x / s, y / s]);
    const cx = pts.reduce((a, p) => a + p[0], 0) / 4, cy = pts.reduce((a, p) => a + p[1], 0) / 4;
    return orderCorners(pts.map(([x, y]) => [
      Math.min(w, Math.max(0, x + (cx - x) * 0.014)),
      Math.min(h, Math.max(0, y + (cy - y) * 0.014)),
    ]));
  } finally {
    mats.forEach((m) => m.delete());
    small.width = 0; small.height = 0;
  }
}

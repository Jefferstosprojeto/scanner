// Leitura de texto (OCR) com Tesseract.js em português — roda no próprio aparelho.
import { loadScript } from './util.js';

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
let worker = null;
let logger = null;

export async function getWorker() {
  await loadScript(TESSERACT_URL);
  if (!worker) worker = await window.Tesseract.createWorker('por', 1, { logger: (m) => logger && logger(m) });
  return worker;
}

/** Reconhece uma imagem. onProgress(0..1). Devolve o resultado completo do Tesseract. */
export async function recognize(image, onProgress) {
  const w = await getWorker();
  logger = (m) => { if (m.status === 'recognizing text' && onProgress) onProgress(m.progress); };
  try {
    const { data } = await w.recognize(image, {}, { text: true, blocks: true });
    return data;
  } finally {
    logger = null;
  }
}

/** Texto em parágrafos: junta as linhas quebradas e separa nos espaços em branco. */
export function toParagraphs(text) {
  return (text || '')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/-\n(?=\p{Ll})/gu, '').replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim())
    .filter(Boolean);
}

/** Todas as linhas com suas palavras e posições (para montar tabelas). */
export function linesOf(data) {
  const out = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
    out.push({ bbox: l.bbox, words: (l.words || []).map((w) => ({ text: w.text, bbox: w.bbox })) });
  }
  if (!out.length && data.lines) data.lines.forEach((l) => out.push({ bbox: l.bbox, words: l.words.map((w) => ({ text: w.text, bbox: w.bbox })) }));
  return out;
}

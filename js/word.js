// Conversão para Word (.docx): texto editável via OCR ou imagens das páginas.
import { loadScript } from './util.js';
import { blobToCanvas, resizeCanvas, toBlob, release } from './imaging.js';
import { getWorker, recognize, toParagraphs } from './ocr.js';

const DOCX_URL = 'https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.js';

export async function buildDocx({ pages, mode, title, onStatus }) {
  onStatus('Preparando Word…', 0);
  await loadScript(DOCX_URL);
  const D = window.docx;
  if (!D) throw new Error('Componente do Word não carregou');
  if (mode === 'ocr') { onStatus('Baixando leitor de texto (só na 1ª vez)…', 0.02); await getWorker(); }

  const children = [];
  let chars = 0;
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const base = i / pages.length;
    if (i > 0) children.push(new D.Paragraph({ children: [new D.PageBreak()] }));
    if (mode === 'ocr') {
      const label = `Lendo o texto da página ${i + 1} de ${pages.length}…`;
      onStatus(label, base);
      const data = await recognize(page.base || page.processed, (p) => onStatus(label, base + p / pages.length));
      const paras = toParagraphs(data.text);
      chars += paras.join('').length;
      if (!paras.length) children.push(new D.Paragraph({ children: [new D.TextRun({ text: `(Página ${i + 1}: nenhum texto reconhecido)`, italics: true, color: '888888' })] }));
      paras.forEach((t) => children.push(new D.Paragraph({ children: [new D.TextRun(t)], spacing: { after: 160 } })));
    } else {
      onStatus(`Adicionando página ${i + 1} de ${pages.length}…`, base);
      const full = await blobToCanvas(page.processed);
      const c = resizeCanvas(full, 1700);
      const bytes = new Uint8Array(await (await toBlob(c, 'image/jpeg', 0.82)).arrayBuffer());
      let w = 620, h = Math.round((620 * c.height) / c.width);
      if (h > 900) { w = Math.round((w * 900) / h); h = 900; }
      children.push(new D.Paragraph({ alignment: D.AlignmentType.CENTER, children: [new D.ImageRun({ data: bytes, transformation: { width: w, height: h } })] }));
      if (c !== full) release(c);
      release(full);
    }
  }
  onStatus('Montando o arquivo…', 1);
  const doc = new D.Document({
    creator: 'Scanner',
    title,
    styles: { default: { document: { run: { font: 'Calibri', size: 24 } } } },
    sections: [{ properties: { page: { margin: { top: 1000, bottom: 1000, left: 1000, right: 1000 } } }, children }],
  });
  return { blob: await D.Packer.toBlob(doc), chars };
}

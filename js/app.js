import {
  normalizeFile, blobToCanvas, warp, applyFilter, rotateCanvas, resizeCanvas, toBlob, release,
  defaultCorners, fullCorners, polygonArea, FILTERS, MAX_OUTPUT_SIDE,
} from './imaging.js';
import { detectCorners, preloadOpenCV } from './detect.js';
import * as db from './storage.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const PAPER = { a4: [210, 297], letter: [215.9, 279.4] };
const QUALITY = {
  high: { max: 2200, q: 0.85 },
  medium: { max: 1600, q: 0.72 },
  low: { max: 1100, q: 0.6 },
};

const state = {
  pages: [],          // { id, original, w, h, corners, filter, rotation, processed }
  name: '',
  edit: null,         // página em edição
  thumbs: new Map(),  // id -> objectURL da miniatura
  sheetPageId: null,
  lastPdf: null,      // { blob, name }
  opts: { paper: 'a4', quality: 'medium' },
};

// ---------------- utilidades ----------------
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
const safe = (p) => Promise.resolve(p).catch((e) => console.warn('[armazenamento]', e));

function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignora */ }
}

function defaultName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `Scan ${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()} ${p(d.getHours())}h${p(d.getMinutes())}`;
}
function fileName() {
  const base = (state.name || defaultName()).replace(/[\\/:*?"<>|]+/g, '-').trim() || 'documento';
  return `${base}.pdf`;
}
function fmtSize(bytes) {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function show(id) {
  $$('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
}
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}
function busy(text) {
  if (text == null) { $('#busy').classList.remove('show'); return; }
  $('#busy-text').textContent = text;
  $('#busy').classList.add('show');
}

let confirmResolve = null;
function openSheet(sel) {
  $('#sheet-backdrop').classList.add('show');
  $(sel).classList.add('show');
}
function closeSheets() {
  $('#sheet-backdrop').classList.remove('show');
  $$('.sheet').forEach((s) => s.classList.remove('show'));
  if (confirmResolve) { const r = confirmResolve; confirmResolve = null; r(false); }
}
function askConfirm(title, text, okLabel) {
  return new Promise((resolve) => {
    $('#confirm-title').textContent = title;
    $('#confirm-text').textContent = text;
    $('#confirm-ok').textContent = okLabel;
    confirmResolve = resolve;
    openSheet('#sheet-confirm');
  });
}

// ---------------- persistência ----------------
const savePage = (p) => safe(db.putPage(p));
const saveOrder = () => safe(db.setMeta('order', state.pages.map((p) => p.id)));

async function loadSaved() {
  try {
    const [name, order, pages] = await Promise.all([db.getMeta('name'), db.getMeta('order'), db.getAllPages()]);
    const byId = new Map(pages.map((p) => [p.id, p]));
    const ids = Array.isArray(order) ? order : [];
    state.pages = ids.map((id) => byId.get(id)).filter(Boolean);
    pages.forEach((p) => { if (!ids.includes(p.id)) state.pages.push(p); });
    state.name = name || defaultName();
  } catch (e) {
    console.warn('Não foi possível ler os dados salvos', e);
    state.name = defaultName();
  }
}

// ---------------- tela inicial ----------------
function renderPages() {
  const grid = $('#pages');
  grid.textContent = '';
  for (const [id, url] of state.thumbs) {
    if (!state.pages.some((p) => p.id === id)) { URL.revokeObjectURL(url); state.thumbs.delete(id); }
  }
  state.pages.forEach((p, i) => {
    let url = state.thumbs.get(p.id);
    if (!url) { url = URL.createObjectURL(p.processed); state.thumbs.set(p.id, url); }
    const card = document.createElement('button');
    card.className = 'page-card';
    card.setAttribute('aria-label', `Página ${i + 1}`);
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = i + 1;
    card.append(img, badge);
    card.addEventListener('click', () => openPageSheet(p.id));
    grid.appendChild(card);
  });
  const n = state.pages.length;
  $('#empty').hidden = n > 0;
  $('#btn-export').disabled = n === 0;
  $('#page-count').textContent = n ? `${n} página${n > 1 ? 's' : ''} · toque numa página para editar` : '';
  state.lastPdf = null;
}

function dropThumb(id) {
  const url = state.thumbs.get(id);
  if (url) { URL.revokeObjectURL(url); state.thumbs.delete(id); }
}

async function handleFiles(input) {
  const files = [...input.files];
  input.value = '';
  if (!files.length) return;

  if (files.length === 1) {
    busy('Abrindo imagem…');
    await nextFrame();
    try {
      const n = await normalizeFile(files[0]);
      busy();
      await openEditor({
        id: uid(), isNew: true, original: n.blob, w: n.width, h: n.height,
        corners: null, filter: lsGet('lastFilter', 'enhance'), rotation: 0,
      });
    } catch (e) {
      console.error(e);
      busy();
      toast('Não foi possível abrir a imagem');
    }
    return;
  }

  // Várias imagens: recorte automático em lote; depois é só tocar para ajustar.
  let failed = 0;
  for (let i = 0; i < files.length; i++) {
    busy(`Processando ${i + 1} de ${files.length}…`);
    await nextFrame();
    let canvas;
    try {
      const n = await normalizeFile(files[i]);
      canvas = await blobToCanvas(n.blob);
      const corners = (await withTimeout(detectCorners(canvas), i === 0 ? 30000 : 10000).catch(() => null))
        || fullCorners(n.width, n.height);
      const filter = lsGet('lastFilter', 'enhance');
      const processed = await renderFinal(canvas, corners, filter, 0);
      const page = { id: uid(), original: n.blob, w: n.width, h: n.height, corners, filter, rotation: 0, processed };
      state.pages.push(page);
      await savePage(page);
    } catch (e) {
      console.error(e);
      failed++;
    } finally {
      release(canvas);
    }
  }
  await saveOrder();
  busy();
  renderPages();
  toast(failed ? `${files.length - failed} adicionadas, ${failed} com erro` : `${files.length} páginas adicionadas`);
}

async function renderFinal(canvas, corners, filter, rotation) {
  const warped = warp(canvas, corners, MAX_OUTPUT_SIDE);
  const filtered = applyFilter(warped, filter);
  const rotated = rotateCanvas(filtered, rotation);
  const blob = await toBlob(rotated, 'image/jpeg', 0.9);
  release(warped); release(filtered); release(rotated);
  return blob;
}

// ---------------- folha de opções da página ----------------
function openPageSheet(id) {
  state.sheetPageId = id;
  const idx = state.pages.findIndex((p) => p.id === id);
  $('#page-sheet-title').textContent = `Página ${idx + 1} de ${state.pages.length}`;
  $('#sheet-page [data-act="left"]').disabled = idx === 0;
  $('#sheet-page [data-act="right"]').disabled = idx === state.pages.length - 1;
  openSheet('#sheet-page');
}

async function pageAction(act) {
  const id = state.sheetPageId;
  const idx = state.pages.findIndex((p) => p.id === id);
  if (idx < 0) return;
  closeSheets();
  if (act === 'edit') {
    const p = state.pages[idx];
    await openEditor({ ...p, corners: p.corners.map((c) => [...c]), isNew: false, detected: true });
  } else if (act === 'left' || act === 'right') {
    const j = act === 'left' ? idx - 1 : idx + 1;
    if (j < 0 || j >= state.pages.length) return;
    [state.pages[idx], state.pages[j]] = [state.pages[j], state.pages[idx]];
    renderPages();
    saveOrder();
  } else if (act === 'delete') {
    const ok = await askConfirm('Excluir página?', `A página ${idx + 1} será removida deste documento.`, 'Excluir');
    if (!ok) return;
    state.pages.splice(idx, 1);
    dropThumb(id);
    renderPages();
    safe(db.deletePage(id));
    saveOrder();
  }
}

async function newDocument() {
  if (state.pages.length) {
    const ok = await askConfirm('Começar novo documento?',
      'As páginas atuais serão apagadas. Gere e compartilhe o PDF antes, se precisar.', 'Apagar e começar');
    if (!ok) return;
  }
  state.pages = [];
  state.name = defaultName();
  $('#doc-name').value = state.name;
  renderPages();
  safe(db.clearPages());
  saveOrder();
  safe(db.setMeta('name', state.name));
}

// ---------------- editor de recorte ----------------
const crop = {
  stage: $('#crop-stage'), wrap: $('#crop-wrap'), img: $('#crop-img'), svg: $('#crop-svg'),
  loupe: $('#loupe'), scale: 1, drag: -1, offset: [0, 0], touched: false,
};

async function openEditor(edit) {
  closeEditorResources();
  state.edit = edit;
  edit.canvas = await blobToCanvas(edit.original);
  edit.url = URL.createObjectURL(edit.original);
  crop.img.src = edit.url;
  try { await crop.img.decode(); } catch { /* segue mesmo assim */ }
  if (!edit.corners) edit.corners = defaultCorners(edit.w, edit.h);
  crop.touched = false;
  setCropStatus('');
  show('screen-crop');
  layoutCrop();
  if (edit.isNew && !edit.detected) runDetect(false);
}

function closeEditorResources() {
  const e = state.edit;
  if (!e) return;
  if (e.url) URL.revokeObjectURL(e.url);
  release(e.canvas); release(e.warped); release(e.preview);
  state.edit = null;
}

function setCropStatus(text) {
  const el = $('#crop-status');
  el.textContent = text;
  el.hidden = !text;
}

async function runDetect(manual) {
  const edit = state.edit;
  if (!edit) return;
  $('#crop-auto').disabled = true;
  setCropStatus('Detectando bordas…');
  try {
    const corners = await withTimeout(detectCorners(edit.canvas), 45000);
    if (state.edit !== edit) return;
    edit.detected = true;
    if (!corners) {
      setCropStatus('Bordas não encontradas — ajuste os cantos');
      setTimeout(() => state.edit === edit && setCropStatus(''), 3000);
    } else if (manual || !crop.touched) {
      edit.corners = corners;
      drawCrop();
      setCropStatus('');
    } else {
      setCropStatus('');
    }
  } catch (e) {
    console.warn(e);
    if (state.edit === edit) {
      setCropStatus(manual ? 'Detecção indisponível (sem internet?)' : 'Ajuste os cantos manualmente');
      setTimeout(() => state.edit === edit && setCropStatus(''), 3500);
    }
  } finally {
    $('#crop-auto').disabled = false;
  }
}

function layoutCrop() {
  const e = state.edit;
  if (!e || !$('#screen-crop').classList.contains('active')) return;
  const pad = 28;
  const sw = crop.stage.clientWidth - pad * 2;
  const sh = crop.stage.clientHeight - pad * 2;
  crop.scale = Math.max(0.01, Math.min(sw / e.w, sh / e.h));
  crop.wrap.style.width = `${e.w * crop.scale}px`;
  crop.wrap.style.height = `${e.h * crop.scale}px`;
  crop.svg.setAttribute('viewBox', `0 0 ${e.w} ${e.h}`);
  drawCrop();
}

function drawCrop() {
  const e = state.edit;
  if (!e) return;
  const k = 1 / crop.scale; // converte pixels de tela em pixels da imagem
  const c = e.corners;
  const quad = c.map((p) => p.join(',')).join(' ');
  const shade = `M0 0H${e.w}V${e.h}H0Z M${c[0]} L${c[1]} L${c[2]} L${c[3]} Z`;
  const active = crop.drag;
  const corners = c.map((p, i) => `
    <circle cx="${p[0]}" cy="${p[1]}" r="${24 * k}" fill="rgba(47,191,148,${active === i ? '.35' : '.2'})" stroke="none"/>
    <circle cx="${p[0]}" cy="${p[1]}" r="${11 * k}" fill="#fff" stroke="#2fbf94" stroke-width="${3 * k}"/>`).join('');
  const mids = midpoints(c).map((p, i) => `
    <circle cx="${p[0]}" cy="${p[1]}" r="${8 * k}" fill="${active === 4 + i ? '#2fbf94' : '#fff'}" stroke="#2fbf94" stroke-width="${2.5 * k}"/>`).join('');
  crop.svg.innerHTML = `
    <path d="${shade}" fill="rgba(0,0,0,.5)" fill-rule="evenodd" stroke="none"/>
    <polygon points="${quad}" fill="none" stroke="#2fbf94" stroke-width="${2.5 * k}"/>
    ${mids}${corners}`;
}

/** Pontos no meio de cada lado (arrastar move o lado inteiro). */
function midpoints(c) {
  return c.map((p, i) => {
    const q = c[(i + 1) % 4];
    return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  });
}

function toImagePoint(ev) {
  const r = crop.wrap.getBoundingClientRect();
  return [(ev.clientX - r.left) / crop.scale, (ev.clientY - r.top) / crop.scale];
}

function updateLoupe(x, y) {
  const e = state.edit;
  const L = crop.loupe;
  const dpr = window.devicePixelRatio || 1;
  const size = 124;
  if (L.width !== size * dpr) { L.width = size * dpr; L.height = size * dpr; }
  const ctx = L.getContext('2d');
  const zoom = 2.2 * crop.scale * dpr;      // pixels da lupa por pixel da imagem
  const srcSize = (size * dpr) / zoom;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, L.width, L.height);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(e.canvas, x - srcSize / 2, y - srcSize / 2, srcSize, srcSize, 0, 0, L.width, L.height);
  const m = L.width / 2;
  ctx.strokeStyle = '#2fbf94';
  ctx.lineWidth = 2 * dpr;
  ctx.beginPath();
  ctx.moveTo(m - 12 * dpr, m); ctx.lineTo(m + 12 * dpr, m);
  ctx.moveTo(m, m - 12 * dpr); ctx.lineTo(m, m + 12 * dpr);
  ctx.stroke();
  const screenX = x * crop.scale + crop.wrap.offsetLeft;
  L.classList.toggle('right', screenX < crop.stage.clientWidth / 2);
  L.classList.add('show');
}

function bindCropEvents() {
  // O toque é tratado na área inteira (div HTML), não no SVG: o Safari do iPhone ignora
  // `touch-action` em SVG e cancelava o arraste para rolar a página.
  const area = crop.stage;
  const block = (ev) => { if (ev.cancelable) ev.preventDefault(); };
  area.addEventListener('touchstart', block, { passive: false });
  area.addEventListener('touchmove', block, { passive: false });
  area.addEventListener('gesturestart', block); // bloqueia o zoom de pinça do Safari

  area.addEventListener('pointerdown', (ev) => {
    const e = state.edit;
    if (!e || crop.drag >= 0) return;
    const p = toImagePoint(ev);
    const targets = [...e.corners, ...midpoints(e.corners)];
    let best = -1, bd = Infinity;
    targets.forEach((t, i) => {
      // cantos têm prioridade sobre os meios dos lados
      const d = Math.hypot(t[0] - p[0], t[1] - p[1]) * crop.scale + (i >= 4 ? 12 : 0);
      if (d < bd) { bd = d; best = i; }
    });
    if (bd > 70) return; // toque longe de qualquer alça
    ev.preventDefault();
    crop.drag = best;
    crop.pointerId = ev.pointerId;
    crop.start = p;
    crop.startCorners = e.corners.map((c) => [...c]);
    crop.touched = true;
    try { area.setPointerCapture(ev.pointerId); } catch { /* ok */ }
    drawCrop();
    updateLoupe(...targets[best]);
  });

  area.addEventListener('pointermove', (ev) => {
    const e = state.edit;
    if (crop.drag < 0 || !e || ev.pointerId !== crop.pointerId) return;
    ev.preventDefault();
    const p = toImagePoint(ev);
    const dx = p[0] - crop.start[0], dy = p[1] - crop.start[1];
    const clampX = (x) => Math.min(e.w, Math.max(0, x));
    const clampY = (y) => Math.min(e.h, Math.max(0, y));
    let focus;
    if (crop.drag < 4) {
      const s = crop.startCorners[crop.drag];
      e.corners[crop.drag] = [clampX(s[0] + dx), clampY(s[1] + dy)];
      focus = e.corners[crop.drag];
    } else {
      const i = crop.drag - 4, j = (i + 1) % 4;
      for (const k of [i, j]) {
        const s = crop.startCorners[k];
        e.corners[k] = [clampX(s[0] + dx), clampY(s[1] + dy)];
      }
      focus = midpoints(e.corners)[i];
    }
    drawCrop();
    updateLoupe(...focus);
  });

  const end = (ev) => {
    if (ev.pointerId !== crop.pointerId) return;
    crop.drag = -1;
    crop.pointerId = null;
    crop.loupe.classList.remove('show');
    drawCrop();
  };
  area.addEventListener('pointerup', end);
  area.addEventListener('pointercancel', end);
  window.addEventListener('resize', layoutCrop);
}

function isValidQuad(c, w, h) {
  if (polygonArea(c) < w * h * 0.01) return false;
  // convexo: todos os produtos vetoriais com o mesmo sinal
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [a, b, d] = [c[i], c[(i + 1) % 4], c[(i + 2) % 4]];
    const cross = (b[0] - a[0]) * (d[1] - b[1]) - (b[1] - a[1]) * (d[0] - b[0]);
    if (cross === 0) continue;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}

async function cropNext() {
  const e = state.edit;
  if (!e) return;
  if (!isValidQuad(e.corners, e.w, e.h)) {
    toast('Os cantos estão cruzados ou muito juntos');
    return;
  }
  busy('Recortando…');
  await nextFrame();
  try {
    release(e.warped); release(e.preview);
    e.warped = warp(e.canvas, e.corners, MAX_OUTPUT_SIDE);
    e.preview = resizeCanvas(e.warped, 1400);
    if (e.preview === e.warped) e.preview = null;
  } catch (err) {
    console.error(err);
    busy();
    toast('Não foi possível recortar');
    return;
  }
  busy();
  show('screen-filter');
  renderFilter();
}

// ---------------- filtro ----------------
function renderFilterChips() {
  const box = $('#filter-chips');
  box.textContent = '';
  FILTERS.forEach((f) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.filter = f.id;
    b.textContent = f.label;
    b.addEventListener('click', () => {
      if (!state.edit) return;
      state.edit.filter = f.id;
      renderFilter();
    });
    box.appendChild(b);
  });
}

async function renderFilter() {
  const e = state.edit;
  if (!e) return;
  $$('#filter-chips .chip').forEach((c) => c.classList.toggle('active', c.dataset.filter === e.filter));
  await nextFrame();
  const base = e.preview || e.warped;
  const filtered = applyFilter(base, e.filter);
  const out = rotateCanvas(filtered, e.rotation);
  const view = $('#filter-canvas');
  view.width = out.width;
  view.height = out.height;
  view.getContext('2d').drawImage(out, 0, 0);
  if (out !== filtered) release(out);
  release(filtered);
}

async function filterSave() {
  const e = state.edit;
  if (!e) return;
  busy('Salvando página…');
  await nextFrame();
  try {
    const filtered = applyFilter(e.warped, e.filter);
    const rotated = rotateCanvas(filtered, e.rotation);
    const processed = await toBlob(rotated, 'image/jpeg', 0.9);
    if (rotated !== filtered) release(rotated);
    release(filtered);

    const page = {
      id: e.id, original: e.original, w: e.w, h: e.h,
      corners: e.corners, filter: e.filter, rotation: e.rotation, processed,
    };
    const idx = state.pages.findIndex((p) => p.id === e.id);
    if (idx >= 0) state.pages[idx] = page; else state.pages.push(page);
    dropThumb(page.id);
    lsSet('lastFilter', e.filter);
    closeEditorResources();
    renderPages();
    show('screen-home');
    busy();
    await savePage(page);
    await saveOrder();
    toast(idx >= 0 ? 'Página atualizada' : `Página ${state.pages.length} adicionada`);
  } catch (err) {
    console.error(err);
    busy();
    toast('Erro ao salvar a página');
  }
}

// ---------------- PDF ----------------
function syncSegments() {
  $$('#sheet-export .seg').forEach((seg) => {
    const key = seg.dataset.opt;
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.val === state.opts[key]));
  });
}

function openExport() {
  if (!state.pages.length) return;
  $('#export-result').hidden = true;
  $('#btn-build').hidden = false;
  syncSegments();
  openSheet('#sheet-export');
}

async function buildPdf() {
  const jsPDF = window.jspdf && window.jspdf.jsPDF;
  if (!jsPDF) throw new Error('Biblioteca de PDF não carregou (verifique a internet e reabra o app)');
  const preset = QUALITY[state.opts.quality];
  const total = state.pages.length;
  let pdf = null;
  for (let i = 0; i < total; i++) {
    busy(`Gerando PDF… ${i + 1}/${total}`);
    await nextFrame();
    const full = await blobToCanvas(state.pages[i].processed);
    const c = resizeCanvas(full, preset.max);
    const jpg = await toBlob(c, 'image/jpeg', preset.q);
    const bytes = new Uint8Array(await jpg.arrayBuffer());
    const land = c.width > c.height;
    let pw, ph;
    if (state.opts.paper === 'fit') {
      if (land) { ph = 210; pw = (210 * c.width) / c.height; } else { pw = 210; ph = (210 * c.height) / c.width; }
    } else {
      const [a, b] = PAPER[state.opts.paper];
      [pw, ph] = land ? [b, a] : [a, b];
    }
    const orient = land ? 'l' : 'p';
    if (!pdf) pdf = new jsPDF({ unit: 'mm', format: [pw, ph], orientation: orient, compress: true });
    else pdf.addPage([pw, ph], orient);
    const s = Math.min(pw / c.width, ph / c.height);
    const iw = c.width * s, ih = c.height * s;
    pdf.addImage(bytes, 'JPEG', (pw - iw) / 2, (ph - ih) / 2, iw, ih);
    if (c !== full) release(c);
    release(full);
  }
  pdf.setProperties({ title: state.name, creator: 'Scanner' });
  return pdf.output('blob');
}

async function onBuild() {
  try {
    const blob = await buildPdf();
    state.lastPdf = { blob, name: fileName() };
    busy();
    const n = state.pages.length;
    $('#export-info').innerHTML = '';
    const b = document.createElement('b');
    b.textContent = state.lastPdf.name;
    $('#export-info').append(b, document.createElement('br'),
      `${n} página${n > 1 ? 's' : ''} · ${fmtSize(blob.size)}`);
    $('#btn-build').hidden = true;
    $('#export-result').hidden = false;
  } catch (e) {
    console.error(e);
    busy();
    toast(e.message || 'Erro ao gerar o PDF');
  }
}

async function onShare() {
  const pdf = state.lastPdf;
  if (!pdf) return;
  const file = new File([pdf.blob], pdf.name, { type: 'application/pdf' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
    } catch (e) {
      if (e.name !== 'AbortError') { console.error(e); toast('Não foi possível compartilhar'); }
    }
  } else {
    toast('Compartilhar não é suportado aqui — use Baixar');
  }
}

function onDownload() {
  const pdf = state.lastPdf;
  if (!pdf) return;
  const url = URL.createObjectURL(pdf.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = pdf.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ---------------- ligação da interface ----------------
function bindUI() {
  $('#in-camera').addEventListener('change', (e) => handleFiles(e.target));
  $('#in-gallery').addEventListener('change', (e) => handleFiles(e.target));
  $('#btn-export').addEventListener('click', openExport);
  $('#btn-new').addEventListener('click', newDocument);

  const nameInput = $('#doc-name');
  nameInput.addEventListener('change', () => {
    state.name = nameInput.value.trim() || defaultName();
    nameInput.value = state.name;
    safe(db.setMeta('name', state.name));
  });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameInput.blur(); });

  $('#sheet-backdrop').addEventListener('click', closeSheets);
  $$('#sheet-page [data-act]').forEach((b) => b.addEventListener('click', () => pageAction(b.dataset.act)));
  $('#confirm-ok').addEventListener('click', () => {
    const r = confirmResolve; confirmResolve = null; closeSheets(); if (r) r(true);
  });
  $('#confirm-cancel').addEventListener('click', closeSheets);

  $('#crop-cancel').addEventListener('click', () => { closeEditorResources(); show('screen-home'); });
  $('#crop-next').addEventListener('click', cropNext);
  $('#crop-auto').addEventListener('click', () => { crop.touched = false; runDetect(true); });
  $('#crop-full').addEventListener('click', () => {
    const e = state.edit;
    if (!e) return;
    e.corners = fullCorners(e.w, e.h);
    crop.touched = true;
    drawCrop();
  });
  bindCropEvents();

  renderFilterChips();
  $('#filter-back').addEventListener('click', () => { show('screen-crop'); layoutCrop(); });
  $('#filter-save').addEventListener('click', filterSave);
  $('#rot-left').addEventListener('click', () => { if (state.edit) { state.edit.rotation -= 90; renderFilter(); } });
  $('#rot-right').addEventListener('click', () => { if (state.edit) { state.edit.rotation += 90; renderFilter(); } });

  $$('#sheet-export .seg button').forEach((b) => b.addEventListener('click', () => {
    const key = b.parentElement.dataset.opt;
    state.opts[key] = b.dataset.val;
    lsSet('pdfOpts', state.opts);
    syncSegments();
    $('#export-result').hidden = true;
    $('#btn-build').hidden = false;
  }));
  $('#btn-build').addEventListener('click', onBuild);
  $('#btn-share').addEventListener('click', onShare);
  $('#btn-download').addEventListener('click', onDownload);
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  if (location.protocol !== 'https:' && !local) return;
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
}

async function init() {
  state.opts = { ...state.opts, ...lsGet('pdfOpts', {}) };
  bindUI();
  await loadSaved();
  $('#doc-name').value = state.name;
  renderPages();
  registerSW();
  setTimeout(preloadOpenCV, 1200); // baixa o detector de bordas em segundo plano
}

// Exposto só para testes/diagnóstico no console.
window.__scanner = { state, handleFiles, openEditor, buildPdf };

init();

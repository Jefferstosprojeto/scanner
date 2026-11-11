import {
  normalizeFile, blobToCanvas, warp, applyFilter, rotateCanvas, resizeCanvas, toBlob, release,
  defaultCorners, fullCorners, polygonArea, FILTERS, MAX_OUTPUT_SIDE, composeOverlays, rotateOverlays,
} from './imaging.js';
import { detectCorners, preloadOpenCV } from './detect.js';
import { SignaturePad } from './sign.js';
import { buildDocx } from './word.js';
import { recognize, toParagraphs } from './ocr.js';
import { buildXlsx, readQr, composeIdCard, splitBook, timestampText } from './tools.js';
import { shareFiles, downloadFile, fmtSize } from './util.js';
import * as db from './storage.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const PAPER = { a4: [210, 297], letter: [215.9, 279.4] };
const QUALITY = { high: { max: 2200, q: 0.85 }, medium: { max: 1600, q: 0.72 }, low: { max: 1100, q: 0.6 } };

const state = {
  pages: [],          // { id, original, w, h, corners, filter, rotation, base, processed, overlays }
  name: '',
  edit: null,
  thumbs: new Map(),
  sheetPageId: null,
  pickResolve: null,
  mega: false,
  forceFilter: null,
  placing: null,
  signTarget: null,
  opts: { format: 'pdf', paper: 'a4', quality: 'medium', wordMode: 'ocr' },
};

// ================= utilidades =================
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
const safe = (p) => Promise.resolve(p).catch((e) => console.warn('[armazenamento]', e));
function lsGet(k, f) { try { const v = localStorage.getItem(k); return v == null ? f : JSON.parse(v); } catch { return f; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } }

function defaultName() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `Scan ${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()} ${p(d.getHours())}h${p(d.getMinutes())}`;
}
const baseName = () => (state.name || defaultName()).replace(/[\\/:*?"<>|]+/g, '-').trim() || 'documento';
const findPage = (id) => state.pages.find((p) => p.id === id);

function show(id) { $$('.screen').forEach((s) => s.classList.toggle('active', s.id === id)); }
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}
function busy(text, fraction) {
  if (text == null) { $('#busy').classList.remove('show'); return; }
  $('#busy-text').textContent = text;
  $('#busy-progress').hidden = fraction == null;
  if (fraction != null) $('#busy-bar').style.transform = `scaleX(${Math.max(0, Math.min(1, fraction))})`;
  $('#busy').classList.add('show');
}

let confirmResolve = null;
function openSheet(sel) { $('#sheet-backdrop').classList.add('show'); $(sel).classList.add('show'); }
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

/** Mostra o resultado de uma exportação com botões Compartilhar / Baixar. */
function showResult(sel, files, info) {
  const box = $(sel);
  box.textContent = '';
  const p = document.createElement('p');
  p.className = 'export-info';
  const b = document.createElement('b');
  b.textContent = files.length === 1 ? files[0].name : `${files.length} arquivos`;
  p.append(b, document.createElement('br'), info);
  const row = document.createElement('div');
  row.className = 'row2';
  const share = document.createElement('button');
  share.className = 'btn share';
  share.textContent = 'Compartilhar';
  share.onclick = async () => {
    try { if (!(await shareFiles(files))) toast('Compartilhar não é suportado aqui — use Baixar'); } catch (e) { console.error(e); toast('Não foi possível compartilhar'); }
  };
  const dl = document.createElement('button');
  dl.className = 'btn';
  dl.textContent = 'Baixar';
  dl.onclick = () => files.forEach(downloadFile);
  row.append(share, dl);
  box.append(p, row);
  box.hidden = false;
}

// ================= persistência =================
const savePage = (p) => safe(db.putPage(p));
const saveOrder = () => safe(db.setMeta('order', state.pages.map((p) => p.id)));

async function loadSaved() {
  try {
    const [name, order, pages] = await Promise.all([db.getMeta('name'), db.getMeta('order'), db.getAllPages()]);
    const byId = new Map(pages.map((p) => [p.id, p]));
    const ids = Array.isArray(order) ? order : [];
    state.pages = ids.map((id) => byId.get(id)).filter(Boolean);
    pages.forEach((p) => { if (!ids.includes(p.id)) state.pages.push(p); });
    state.pages.forEach((p) => { if (!p.base) p.base = p.processed; if (!p.overlays) p.overlays = []; });
    state.name = name || defaultName();
  } catch (e) {
    console.warn('Não foi possível ler os dados salvos', e);
    state.name = defaultName();
  }
}

async function recompose(page) {
  page.processed = await composeOverlays(page.base, page.overlays);
  dropThumb(page.id);
  await savePage(page);
}

// ================= tela inicial =================
function renderPages() {
  const grid = $('#pages');
  grid.textContent = '';
  for (const [id, url] of state.thumbs) {
    if (!findPage(id)) { URL.revokeObjectURL(url); state.thumbs.delete(id); }
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
    if (p.overlays.some((o) => o.type === 'sign')) {
      const f = document.createElement('span');
      f.className = 'sig-flag';
      f.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 17c3-1 4-9 7-9 2 0 1 6 3 6 1.5 0 2-2 3-2s1 3 3 3"/></svg>';
      card.append(f);
    }
    card.addEventListener('click', () => onCardClick(p.id));
    grid.appendChild(card);
  });
  const n = state.pages.length;
  $('#empty').hidden = n > 0;
  $('#page-count').textContent = n ? `${n} página${n > 1 ? 's' : ''} · toque numa página para ver opções` : '';
  ['#act-edit', '#act-sign', '#act-word', '#act-share'].forEach((s) => { $(s).disabled = n === 0; });
}

function dropThumb(id) {
  const url = state.thumbs.get(id);
  if (url) { URL.revokeObjectURL(url); state.thumbs.delete(id); }
}

function onCardClick(id) {
  if (state.pickResolve) { const r = state.pickResolve; endPick(); r(id); return; }
  openPageSheet(id);
}

/** Pede para o usuário tocar numa página. Com uma página só, escolhe direto (exceto force). */
function pickPage(text, color, force = false) {
  if (!state.pages.length) { toast('Escaneie uma página primeiro'); return Promise.resolve(null); }
  if (state.pages.length === 1 && !force) return Promise.resolve(state.pages[0].id);
  return new Promise((resolve) => {
    state.pickResolve = resolve;
    $('#pick-text').textContent = text;
    $('#pick-banner').style.setProperty('--pick', color);
    $('#pages').style.setProperty('--pick', color);
    $('#pick-banner').hidden = false;
    $('#pages').classList.add('picking');
  });
}
function endPick() {
  state.pickResolve = null;
  $('#pick-banner').hidden = true;
  $('#pages').classList.remove('picking');
}

// ================= adicionar páginas =================
async function handleFiles(input) {
  const files = [...input.files];
  input.value = '';
  closeSheets();
  if (!files.length) return;

  if (files.length === 1) {
    busy('Abrindo imagem…');
    await nextFrame();
    try {
      const n = await normalizeFile(files[0]);
      busy();
      await openEditor({
        id: uid(), isNew: true, original: n.blob, w: n.width, h: n.height, corners: null,
        filter: state.forceFilter || lsGet('lastFilter', 'enhance'), rotation: 0, overlays: [],
      });
    } catch (e) {
      console.error(e);
      busy();
      toast('Não foi possível abrir a imagem');
    }
    return;
  }

  let failed = 0;
  for (let i = 0; i < files.length; i++) {
    busy(`Processando ${i + 1} de ${files.length}…`, i / files.length);
    await nextFrame();
    let canvas;
    try {
      const n = await normalizeFile(files[i]);
      canvas = await blobToCanvas(n.blob);
      const corners = (await withTimeout(detectCorners(canvas), i === 0 ? 30000 : 10000).catch(() => null)) || fullCorners(n.width, n.height);
      const filter = state.forceFilter || lsGet('lastFilter', 'enhance');
      const base = await renderBase(canvas, corners, filter, 0);
      const page = { id: uid(), original: n.blob, w: n.width, h: n.height, corners, filter, rotation: 0, base, processed: base, overlays: [] };
      state.pages.push(page);
      await savePage(page);
    } catch (e) {
      console.error(e);
      failed++;
    } finally {
      release(canvas);
    }
  }
  state.forceFilter = null;
  await saveOrder();
  busy();
  renderPages();
  toast(failed ? `${files.length - failed} adicionadas, ${failed} com erro` : `${files.length} páginas adicionadas`);
}

async function renderBase(canvas, corners, filter, rotation) {
  const warped = warp(canvas, corners, MAX_OUTPUT_SIDE);
  const filtered = applyFilter(warped, filter);
  const rotated = rotateCanvas(filtered, rotation);
  const blob = await toBlob(rotated, 'image/jpeg', 0.9);
  release(warped); release(filtered); release(rotated);
  return blob;
}

// ================= opções da página =================
function openPageSheet(id) {
  state.sheetPageId = id;
  const idx = state.pages.findIndex((p) => p.id === id);
  const p = state.pages[idx];
  $('#page-sheet-title').textContent = `Página ${idx + 1} de ${state.pages.length}`;
  $('#sheet-page [data-act="left"]').disabled = idx === 0;
  $('#sheet-page [data-act="right"]').disabled = idx === state.pages.length - 1;
  $('#sheet-page [data-act="unsign"]').hidden = !p.overlays.length;
  openSheet('#sheet-page');
}

async function pageAction(act) {
  const id = state.sheetPageId;
  const idx = state.pages.findIndex((p) => p.id === id);
  if (idx < 0) return;
  const p = state.pages[idx];
  closeSheets();
  if (act === 'edit') return editPage(id);
  if (act === 'sign') return openSignChooser(id);
  if (act === 'unsign') {
    p.overlays = [];
    await recompose(p);
    renderPages();
    return toast('Assinaturas e carimbos removidos');
  }
  if (act === 'rotate') {
    busy('Girando…');
    await nextFrame();
    const c = await blobToCanvas(p.base);
    const r = rotateCanvas(c, 90);
    p.base = await toBlob(r, 'image/jpeg', 0.9);
    p.overlays = rotateOverlays(p.overlays, c.width, c.height, 90);
    p.rotation = (p.rotation + 90) % 360;
    release(c); release(r);
    await recompose(p);
    busy();
    return renderPages();
  }
  if (act === 'left' || act === 'right') {
    const j = act === 'left' ? idx - 1 : idx + 1;
    if (j < 0 || j >= state.pages.length) return;
    [state.pages[idx], state.pages[j]] = [state.pages[j], state.pages[idx]];
    renderPages();
    return saveOrder();
  }
  if (act === 'delete') {
    const ok = await askConfirm('Excluir página?', `A página ${idx + 1} será removida deste documento.`, 'Excluir');
    if (!ok) return;
    state.pages.splice(idx, 1);
    dropThumb(id);
    renderPages();
    safe(db.deletePage(id));
    saveOrder();
  }
}

async function editPage(id) {
  const p = findPage(id);
  if (!p) return;
  await openEditor({ ...p, corners: p.corners.map((c) => [...c]), isNew: false, detected: true });
}

async function newDocument() {
  if (state.pages.length) {
    const ok = await askConfirm('Começar novo documento?', 'As páginas atuais serão apagadas. Compartilhe o arquivo antes, se precisar.', 'Apagar e começar');
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

// ================= editor de recorte =================
const crop = { stage: $('#crop-stage'), wrap: $('#crop-wrap'), img: $('#crop-img'), svg: $('#crop-svg'), loupe: $('#loupe'), scale: 1, drag: -1, touched: false };

async function openEditor(edit) {
  closeEditorResources();
  state.edit = edit;
  edit.canvas = await blobToCanvas(edit.original);
  edit.url = URL.createObjectURL(edit.original);
  crop.img.src = edit.url;
  try { await crop.img.decode(); } catch { /* segue */ }
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

function setCropStatus(text) { const el = $('#crop-status'); el.textContent = text; el.hidden = !text; }

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
    } else setCropStatus('');
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
  crop.scale = Math.max(0.01, Math.min((crop.stage.clientWidth - pad * 2) / e.w, (crop.stage.clientHeight - pad * 2) / e.h));
  crop.wrap.style.width = `${e.w * crop.scale}px`;
  crop.wrap.style.height = `${e.h * crop.scale}px`;
  crop.svg.setAttribute('viewBox', `0 0 ${e.w} ${e.h}`);
  drawCrop();
}

const midpoints = (c) => c.map((p, i) => { const q = c[(i + 1) % 4]; return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]; });

function drawCrop() {
  const e = state.edit;
  if (!e) return;
  const k = 1 / crop.scale, c = e.corners, active = crop.drag, A = '#a78bfa';
  const shade = `M0 0H${e.w}V${e.h}H0Z M${c[0]} L${c[1]} L${c[2]} L${c[3]} Z`;
  const corners = c.map((p, i) => `
    <circle cx="${p[0]}" cy="${p[1]}" r="${24 * k}" fill="rgba(167,139,250,${active === i ? '.4' : '.22'})"/>
    <circle cx="${p[0]}" cy="${p[1]}" r="${11 * k}" fill="#fff" stroke="${A}" stroke-width="${3 * k}"/>`).join('');
  const mids = midpoints(c).map((p, i) => `
    <circle cx="${p[0]}" cy="${p[1]}" r="${8 * k}" fill="${active === 4 + i ? A : '#fff'}" stroke="${A}" stroke-width="${2.5 * k}"/>`).join('');
  crop.svg.innerHTML = `<path d="${shade}" fill="rgba(0,0,0,.5)" fill-rule="evenodd"/>
    <polygon points="${c.map((p) => p.join(',')).join(' ')}" fill="none" stroke="${A}" stroke-width="${2.5 * k}"/>${mids}${corners}`;
}

function toImagePoint(ev, wrap, scale) {
  const r = wrap.getBoundingClientRect();
  return [(ev.clientX - r.left) / scale, (ev.clientY - r.top) / scale];
}

function updateLoupe(x, y) {
  const e = state.edit, L = crop.loupe, dpr = window.devicePixelRatio || 1, size = 124;
  if (L.width !== size * dpr) { L.width = size * dpr; L.height = size * dpr; }
  const ctx = L.getContext('2d');
  const src = (size * dpr) / (2.2 * crop.scale * dpr);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, L.width, L.height);
  ctx.drawImage(e.canvas, x - src / 2, y - src / 2, src, src, 0, 0, L.width, L.height);
  const m = L.width / 2;
  ctx.strokeStyle = '#a78bfa';
  ctx.lineWidth = 2 * dpr;
  ctx.beginPath();
  ctx.moveTo(m - 12 * dpr, m); ctx.lineTo(m + 12 * dpr, m);
  ctx.moveTo(m, m - 12 * dpr); ctx.lineTo(m, m + 12 * dpr);
  ctx.stroke();
  L.classList.toggle('right', x * crop.scale + crop.wrap.offsetLeft < crop.stage.clientWidth / 2);
  L.classList.add('show');
}

/** Bloqueia os gestos do Safari (rolar, zoom) numa área de toque. */
function blockGestures(el) {
  const block = (ev) => { if (ev.cancelable) ev.preventDefault(); };
  el.addEventListener('touchstart', block, { passive: false });
  el.addEventListener('touchmove', block, { passive: false });
  el.addEventListener('gesturestart', block);
}

function bindCropEvents() {
  const area = crop.stage;
  blockGestures(area);
  area.addEventListener('pointerdown', (ev) => {
    const e = state.edit;
    if (!e || crop.drag >= 0) return;
    const p = toImagePoint(ev, crop.wrap, crop.scale);
    const targets = [...e.corners, ...midpoints(e.corners)];
    let best = -1, bd = Infinity;
    targets.forEach((t, i) => {
      const d = Math.hypot(t[0] - p[0], t[1] - p[1]) * crop.scale + (i >= 4 ? 12 : 0);
      if (d < bd) { bd = d; best = i; }
    });
    if (bd > 70) return;
    ev.preventDefault();
    Object.assign(crop, { drag: best, pointerId: ev.pointerId, start: p, startCorners: e.corners.map((c) => [...c]), touched: true });
    try { area.setPointerCapture(ev.pointerId); } catch { /* ok */ }
    drawCrop();
    updateLoupe(...targets[best]);
  });
  area.addEventListener('pointermove', (ev) => {
    const e = state.edit;
    if (crop.drag < 0 || !e || ev.pointerId !== crop.pointerId) return;
    ev.preventDefault();
    const p = toImagePoint(ev, crop.wrap, crop.scale);
    const dx = p[0] - crop.start[0], dy = p[1] - crop.start[1];
    const cl = (s) => [Math.min(e.w, Math.max(0, s[0] + dx)), Math.min(e.h, Math.max(0, s[1] + dy))];
    let focus;
    if (crop.drag < 4) {
      e.corners[crop.drag] = cl(crop.startCorners[crop.drag]);
      focus = e.corners[crop.drag];
    } else {
      const i = crop.drag - 4, j = (i + 1) % 4;
      e.corners[i] = cl(crop.startCorners[i]);
      e.corners[j] = cl(crop.startCorners[j]);
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
}

function isValidQuad(c, w, h) {
  if (polygonArea(c) < w * h * 0.01) return false;
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
  if (!isValidQuad(e.corners, e.w, e.h)) return toast('Os cantos estão cruzados ou muito juntos');
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
    return toast('Não foi possível recortar');
  }
  busy();
  show('screen-filter');
  renderFilter();
}

// ================= filtro =================
function renderFilterChips() {
  const box = $('#filter-chips');
  box.textContent = '';
  FILTERS.forEach((f) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.filter = f.id;
    b.textContent = f.label;
    b.addEventListener('click', () => { if (state.edit) { state.edit.filter = f.id; renderFilter(); } });
    box.appendChild(b);
  });
}

async function renderFilter() {
  const e = state.edit;
  if (!e) return;
  $$('#filter-chips .chip').forEach((c) => c.classList.toggle('active', c.dataset.filter === e.filter));
  $(`#filter-chips .chip[data-filter="${e.filter}"]`)?.scrollIntoView({ inline: 'center', block: 'nearest' });
  await nextFrame();
  const filtered = applyFilter(e.preview || e.warped, e.filter);
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
    const base = await toBlob(rotated, 'image/jpeg', 0.9);
    if (rotated !== filtered) release(rotated);
    release(filtered);
    const overlays = e.overlays || [];
    const page = {
      id: e.id, original: e.original, w: e.w, h: e.h, corners: e.corners, filter: e.filter,
      rotation: e.rotation, base, processed: await composeOverlays(base, overlays), overlays,
    };
    const idx = state.pages.findIndex((p) => p.id === e.id);
    if (idx >= 0) state.pages[idx] = page; else state.pages.push(page);
    dropThumb(page.id);
    if (!state.forceFilter) lsSet('lastFilter', e.filter);
    closeEditorResources();
    renderPages();
    show('screen-home');
    busy();
    await savePage(page);
    await saveOrder();
    if (state.mega && idx < 0) {
      $('#next-title').textContent = `Página ${state.pages.length} salva`;
      openSheet('#sheet-next');
    } else {
      state.forceFilter = null;
      toast(idx >= 0 ? 'Página atualizada' : `Página ${state.pages.length} adicionada`);
    }
  } catch (err) {
    console.error(err);
    busy();
    toast('Erro ao salvar a página');
  }
}

// ================= assinatura =================
let pad = null;

function signatures() { return lsGet('signatures', []); }

function openSignChooser(pageId) {
  state.signTarget = pageId;
  const list = $('#sign-list');
  list.textContent = '';
  const sigs = signatures();
  if (!sigs.length) {
    const p = document.createElement('p');
    p.className = 'sign-empty';
    p.textContent = 'Nenhuma assinatura salva ainda.';
    list.append(p);
  }
  sigs.forEach((s, i) => {
    const item = document.createElement('button');
    item.className = 'sign-item';
    item.setAttribute('aria-label', `Usar assinatura ${i + 1}`);
    const img = document.createElement('img');
    img.src = s.src;
    img.alt = '';
    const del = document.createElement('span');
    del.className = 'sign-del';
    del.setAttribute('role', 'button');
    del.setAttribute('aria-label', 'Apagar assinatura');
    del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>';
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const all = signatures();
      all.splice(i, 1);
      lsSet('signatures', all);
      openSignChooser(pageId);
    });
    item.append(img, del);
    item.addEventListener('click', () => { closeSheets(); openPlace(pageId, s); });
    list.append(item);
  });
  openSheet('#sheet-sign');
}

async function openPad() {
  closeSheets();
  show('screen-pad');
  await nextFrame();
  pad.resize();
}

function savePad() {
  const s = pad.export();
  if (!s) return toast('Desenhe sua assinatura primeiro');
  const all = [s, ...signatures()].slice(0, 5);
  if (!lsSet('signatures', all)) toast('Assinatura usada, mas não foi possível guardá-la');
  openPlace(state.signTarget, s);
}

const place = { stage: $('#place-stage'), wrap: $('#place-wrap'), page: $('#place-page'), sign: $('#place-sign'), signImg: $('#place-sign-img') };

async function openPlace(pageId, sig) {
  const page = findPage(pageId);
  if (!page) return show('screen-home');
  if (place.url) URL.revokeObjectURL(place.url);
  place.url = URL.createObjectURL(page.processed);
  place.page.src = place.url;
  place.signImg.src = sig.src;
  try { await place.page.decode(); } catch { /* ok */ }
  const pw = place.page.naturalWidth, ph = place.page.naturalHeight;
  state.placing = { page, sig, pw, ph, w: 0.32, x: 0.6, y: 0.8 };
  $('#place-size').value = 32;
  show('screen-place');
  clampPlace();
  layoutPlace();
}

function clampPlace() {
  const P = state.placing;
  const hFrac = (P.w * P.pw * P.sig.ar) / P.ph;
  P.x = Math.min(1 - P.w, Math.max(0, P.x));
  P.y = Math.min(1 - hFrac, Math.max(0, P.y));
}

function layoutPlace() {
  const P = state.placing;
  if (!P || !$('#screen-place').classList.contains('active')) return;
  const pad2 = 24;
  const s = Math.min((place.stage.clientWidth - pad2 * 2) / P.pw, (place.stage.clientHeight - pad2 * 2) / P.ph);
  P.scale = s;
  place.wrap.style.width = `${P.pw * s}px`;
  place.wrap.style.height = `${P.ph * s}px`;
  place.sign.style.width = `${P.w * P.pw * s + 12}px`;
  place.sign.style.transform = `translate(${P.x * P.pw * s - 6}px, ${P.y * P.ph * s - 6}px)`;
}

function bindPlaceEvents() {
  blockGestures(place.stage);
  place.stage.addEventListener('pointerdown', (ev) => {
    const P = state.placing;
    if (!P) return;
    ev.preventDefault();
    P.drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, ox: P.x, oy: P.y };
    try { place.stage.setPointerCapture(ev.pointerId); } catch { /* ok */ }
  });
  place.stage.addEventListener('pointermove', (ev) => {
    const P = state.placing;
    if (!P || !P.drag || P.drag.id !== ev.pointerId) return;
    P.x = P.drag.ox + (ev.clientX - P.drag.x) / (P.pw * P.scale);
    P.y = P.drag.oy + (ev.clientY - P.drag.y) / (P.ph * P.scale);
    clampPlace();
    layoutPlace();
  });
  const end = () => { if (state.placing) state.placing.drag = null; };
  place.stage.addEventListener('pointerup', end);
  place.stage.addEventListener('pointercancel', end);
  $('#place-size').addEventListener('input', (ev) => {
    const P = state.placing;
    if (!P) return;
    const cx = P.x + P.w / 2;
    P.w = Number(ev.target.value) / 100;
    P.x = cx - P.w / 2;
    clampPlace();
    layoutPlace();
  });
}

async function applyPlace() {
  const P = state.placing;
  if (!P) return;
  busy('Assinando…');
  await nextFrame();
  try {
    P.page.overlays.push({ type: 'sign', src: P.sig.src, ar: P.sig.ar, x: P.x, y: P.y, w: P.w });
    await recompose(P.page);
    state.placing = null;
    renderPages();
    show('screen-home');
    toast('Página assinada');
  } catch (e) {
    console.error(e);
    toast('Erro ao assinar');
  } finally {
    busy();
  }
}

// ================= compartilhar (PDF / JPG) =================
function syncSegments() {
  $$('.seg[data-opt]').forEach((seg) => {
    const key = seg.dataset.opt;
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.val === state.opts[key]));
  });
  $('#field-paper').hidden = state.opts.format !== 'pdf';
  $('#word-hint').textContent = state.opts.wordMode === 'ocr'
    ? 'Reconhece o texto (português) para você editar no Word. Na 1ª vez baixa ~6 MB.'
    : 'Cada página vira uma imagem dentro do Word, igual ao original.';
}

function openExport() {
  if (!state.pages.length) return toast('Escaneie uma página primeiro');
  $('#export-result').hidden = true;
  syncSegments();
  openSheet('#sheet-export');
}

async function buildPdf() {
  const jsPDF = window.jspdf && window.jspdf.jsPDF;
  if (!jsPDF) throw new Error('Componente de PDF não carregou (verifique a internet e reabra o app)');
  const preset = QUALITY[state.opts.quality];
  const total = state.pages.length;
  let pdf = null;
  for (let i = 0; i < total; i++) {
    busy(`Gerando PDF… ${i + 1}/${total}`, i / total);
    await nextFrame();
    const full = await blobToCanvas(state.pages[i].processed);
    const c = resizeCanvas(full, preset.max);
    const bytes = new Uint8Array(await (await toBlob(c, 'image/jpeg', preset.q)).arrayBuffer());
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
    pdf.addImage(bytes, 'JPEG', (pw - c.width * s) / 2, (ph - c.height * s) / 2, c.width * s, c.height * s);
    if (c !== full) release(c);
    release(full);
  }
  pdf.setProperties({ title: state.name, creator: 'Scanner' });
  return new File([pdf.output('blob')], `${baseName()}.pdf`, { type: 'application/pdf' });
}

async function buildJpgs() {
  const preset = QUALITY[state.opts.quality];
  const files = [];
  for (let i = 0; i < state.pages.length; i++) {
    busy(`Preparando imagens… ${i + 1}/${state.pages.length}`, i / state.pages.length);
    await nextFrame();
    const full = await blobToCanvas(state.pages[i].processed);
    const c = resizeCanvas(full, preset.max);
    const blob = await toBlob(c, 'image/jpeg', preset.q);
    files.push(new File([blob], `${baseName()} - pág ${i + 1}.jpg`, { type: 'image/jpeg' }));
    if (c !== full) release(c);
    release(full);
  }
  return files;
}

async function onBuildExport() {
  try {
    const files = state.opts.format === 'pdf' ? [await buildPdf()] : await buildJpgs();
    const n = state.pages.length;
    const size = files.reduce((a, f) => a + f.size, 0);
    showResult('#export-result', files, `${n} página${n > 1 ? 's' : ''} · ${fmtSize(size)}`);
  } catch (e) {
    console.error(e);
    toast(e.message || 'Erro ao gerar o arquivo');
  } finally {
    busy();
  }
}

// ================= Word / Excel / texto / QR =================
function openWord() {
  if (!state.pages.length) return toast('Escaneie uma página primeiro');
  $('#word-result').hidden = true;
  syncSegments();
  openSheet('#sheet-word');
}

async function onBuildWord() {
  try {
    const { blob, chars } = await buildDocx({ pages: state.pages, mode: state.opts.wordMode, title: state.name, onStatus: busy });
    const file = new File([blob], `${baseName()}.docx`, { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    const info = state.opts.wordMode === 'ocr' ? `${chars.toLocaleString('pt-BR')} caracteres reconhecidos · ${fmtSize(file.size)}` : fmtSize(file.size);
    showResult('#word-result', [file], info);
  } catch (e) {
    console.error(e);
    toast(e.message || 'Erro ao gerar o Word');
  } finally {
    busy();
  }
}

function openExcel() {
  if (!state.pages.length) return toast('Escaneie uma tabela primeiro');
  $('#excel-result').hidden = true;
  openSheet('#sheet-excel');
}

async function onBuildExcel() {
  try {
    const blob = await buildXlsx({ pages: state.pages, onStatus: busy });
    const file = new File([blob], `${baseName()}.xlsx`, { type: blob.type });
    showResult('#excel-result', [file], `${state.pages.length} aba(s) · ${fmtSize(file.size)}`);
  } catch (e) {
    console.error(e);
    toast(e.message || 'Erro ao gerar o Excel');
  } finally {
    busy();
  }
}

async function extractText(translate) {
  const id = await pickPage(translate ? 'Toque na página para traduzir' : 'Toque na página para extrair o texto', translate ? '#0d9488' : '#0891b2');
  if (!id) return;
  const page = findPage(id);
  try {
    busy('Baixando leitor de texto (só na 1ª vez)…', 0);
    const data = await recognize(page.base, (p) => busy('Lendo o texto…', p));
    const text = toParagraphs(data.text).join('\n\n');
    busy();
    if (!text) return toast('Nenhum texto encontrado nesta página');
    $('#text-title').textContent = translate ? 'Traduzir texto' : 'Texto extraído';
    $('#text-out').value = text;
    $('#translate-row').hidden = !translate;
    $('#text-translate').hidden = !translate;
    openSheet('#sheet-text');
  } catch (e) {
    console.error(e);
    busy();
    toast(e.message || 'Erro ao ler o texto');
  }
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copiado'); } catch {
    const ta = $('#text-out');
    ta.select();
    toast(document.execCommand('copy') ? 'Copiado' : 'Selecione e copie manualmente');
  }
}

async function onQr(input) {
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  busy('Lendo QR Code…');
  try {
    const text = await readQr(file);
    busy();
    if (!text) return toast('Nenhum QR Code encontrado — aproxime e tente de novo');
    $('#qr-out').textContent = text;
    $('#qr-open').hidden = !/^https?:\/\//i.test(text);
    openSheet('#sheet-qr');
  } catch (e) {
    console.error(e);
    busy();
    toast(e.message || 'Erro ao ler o QR Code');
  }
}

async function addStamp() {
  const id = await pickPage('Toque na página para carimbar data e hora', '#ea580c');
  if (!id) return;
  const page = findPage(id);
  busy('Carimbando…');
  page.overlays = page.overlays.filter((o) => o.type !== 'stamp');
  page.overlays.push({ type: 'stamp', text: timestampText() });
  await recompose(page);
  busy();
  renderPages();
  toast('Data e hora adicionadas');
}

async function makeIdCard() {
  if (state.pages.length < 2) return toast('Escaneie a frente e o verso do documento primeiro');
  const front = await pickPage('Toque na FRENTE do documento', '#9333ea', true);
  if (!front) return;
  const back = await pickPage('Agora toque no VERSO', '#9333ea', true);
  if (!back) return;
  busy('Montando frente e verso…');
  try {
    const blob = await composeIdCard(findPage(front).base, findPage(back).base);
    const c = await blobToCanvas(blob);
    const page = { id: uid(), original: blob, w: c.width, h: c.height, corners: fullCorners(c.width, c.height), filter: 'original', rotation: 0, base: blob, processed: blob, overlays: [] };
    release(c);
    state.pages.push(page);
    await savePage(page);
    await saveOrder();
    renderPages();
    toast('Frente e verso numa folha A4 — adicionada no final');
  } catch (e) {
    console.error(e);
    toast('Erro ao montar o documento');
  } finally {
    busy();
  }
}

async function splitBookPage() {
  const id = await pickPage('Toque na página dupla do livro', '#b45309');
  if (!id) return;
  const idx = state.pages.findIndex((p) => p.id === id);
  busy('Separando páginas…');
  try {
    const parts = await splitBook(state.pages[idx].base);
    const pages = parts.map((pt) => ({ id: uid(), original: pt.blob, w: pt.w, h: pt.h, corners: fullCorners(pt.w, pt.h), filter: 'original', rotation: 0, base: pt.blob, processed: pt.blob, overlays: [] }));
    const old = state.pages[idx];
    state.pages.splice(idx, 1, ...pages);
    dropThumb(old.id);
    safe(db.deletePage(old.id));
    for (const p of pages) await savePage(p);
    await saveOrder();
    renderPages();
    toast('Página dupla separada em duas');
  } catch (e) {
    console.error(e);
    toast('Erro ao separar');
  } finally {
    busy();
  }
}

// ================= ligação da interface =================
function onToolInput(input) {
  const tool = input.dataset.tool;
  if (tool === 'qr') return onQr(input);
  state.mega = tool === 'mega';
  state.forceFilter = { whiteboard: 'whiteboard', slide: 'slide', photo: 'photo' }[tool] || null;
  return handleFiles(input);
}

async function onToolButton(tool) {
  if (tool === 'sign') { const id = await pickPage('Toque na página que deseja assinar', '#db2777'); if (id) openSignChooser(id); return; }
  if (tool === 'word') return openWord();
  if (tool === 'excel') return openExcel();
  if (tool === 'text') return extractText(false);
  if (tool === 'translate') return extractText(true);
  if (tool === 'stamp') return addStamp();
  if (tool === 'idcard') return makeIdCard();
  if (tool === 'book') return splitBookPage();
}

function bindUI() {
  $$('.in-camera, .in-gallery').forEach((el) => el.addEventListener('change', () => { state.mega = false; state.forceFilter = null; handleFiles(el); }));
  $$('.in-tool').forEach((el) => el.addEventListener('change', () => onToolInput(el)));
  $$('.tool-tile[data-tool]').forEach((el) => { if (el.tagName === 'BUTTON') el.addEventListener('click', () => onToolButton(el.dataset.tool)); });
  $$('.tool-tile[data-soon]').forEach((el) => el.addEventListener('click', () => toast(`${el.dataset.soon}: chegando em uma próxima versão`)));

  $('#act-add').addEventListener('click', () => openSheet('#sheet-add'));
  $('#act-edit').addEventListener('click', async () => { const id = await pickPage('Toque na página que deseja editar', '#0891b2'); if (id) editPage(id); });
  $('#act-sign').addEventListener('click', () => onToolButton('sign'));
  $('#act-word').addEventListener('click', openWord);
  $('#act-share').addEventListener('click', openExport);
  $('#btn-new').addEventListener('click', newDocument);
  $('#pick-cancel').addEventListener('click', () => { const r = state.pickResolve; endPick(); if (r) r(null); });

  const nameInput = $('#doc-name');
  nameInput.addEventListener('change', () => {
    state.name = nameInput.value.trim() || defaultName();
    nameInput.value = state.name;
    safe(db.setMeta('name', state.name));
  });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameInput.blur(); });

  $('#sheet-backdrop').addEventListener('click', () => { if (state.mega) state.mega = false; closeSheets(); });
  $$('#sheet-page [data-act]').forEach((b) => b.addEventListener('click', () => pageAction(b.dataset.act)));
  $('#confirm-ok').addEventListener('click', () => { const r = confirmResolve; confirmResolve = null; closeSheets(); if (r) r(true); });
  $('#confirm-cancel').addEventListener('click', closeSheets);

  // recorte e filtro
  $('#crop-cancel').addEventListener('click', () => { closeEditorResources(); state.mega = false; show('screen-home'); });
  $('#crop-next').addEventListener('click', cropNext);
  $('#crop-auto').addEventListener('click', () => { crop.touched = false; runDetect(true); });
  $('#crop-full').addEventListener('click', () => { const e = state.edit; if (!e) return; e.corners = fullCorners(e.w, e.h); crop.touched = true; drawCrop(); });
  bindCropEvents();
  renderFilterChips();
  $('#filter-back').addEventListener('click', () => { show('screen-crop'); layoutCrop(); });
  $('#filter-save').addEventListener('click', filterSave);
  $('#rot-left').addEventListener('click', () => { if (state.edit) { state.edit.rotation -= 90; renderFilter(); } });
  $('#rot-right').addEventListener('click', () => { if (state.edit) { state.edit.rotation += 90; renderFilter(); } });

  // Mega Scan
  $('#next-camera').addEventListener('change', (ev) => handleFiles(ev.target));
  $('#next-stop').addEventListener('click', () => { state.mega = false; state.forceFilter = null; closeSheets(); toast(`${state.pages.length} páginas no documento`); });

  // assinatura
  pad = new SignaturePad($('#pad-canvas'));
  $('#sign-new').addEventListener('click', openPad);
  $('#pad-cancel').addEventListener('click', () => show('screen-home'));
  $('#pad-save').addEventListener('click', savePad);
  $('#pad-clear').addEventListener('click', () => pad.clear());
  $$('#pad-colors .swatch').forEach((s) => s.addEventListener('click', () => {
    pad.color = s.dataset.color;
    $$('#pad-colors .swatch').forEach((x) => x.classList.toggle('active', x === s));
  }));
  bindPlaceEvents();
  $('#place-cancel').addEventListener('click', () => { state.placing = null; show('screen-home'); });
  $('#place-apply').addEventListener('click', applyPlace);

  // opções de exportação
  $$('.seg[data-opt] button').forEach((b) => b.addEventListener('click', () => {
    state.opts[b.parentElement.dataset.opt] = b.dataset.val;
    lsSet('opts', state.opts);
    syncSegments();
    $('#export-result').hidden = true;
    $('#word-result').hidden = true;
  }));
  $('#btn-build').addEventListener('click', onBuildExport);
  $('#btn-word').addEventListener('click', onBuildWord);
  $('#btn-excel').addEventListener('click', onBuildExcel);

  // texto / tradução / QR
  $$('#tr-lang button').forEach((b) => b.addEventListener('click', () => $$('#tr-lang button').forEach((x) => x.classList.toggle('active', x === b))));
  $('#text-copy').addEventListener('click', () => copyText($('#text-out').value));
  $('#text-share').addEventListener('click', async () => {
    const text = $('#text-out').value;
    const file = new File([text], `${baseName()}.txt`, { type: 'text/plain' });
    try { if (!(await shareFiles([file]))) downloadFile(file); } catch (e) { console.error(e); }
  });
  $('#text-translate').addEventListener('click', () => {
    const lang = $('#tr-lang button.active')?.dataset.val || 'en';
    const text = $('#text-out').value.slice(0, 4500);
    window.open(`https://translate.google.com/?sl=pt&tl=${lang}&op=translate&text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  });
  $('#qr-copy').addEventListener('click', () => copyText($('#qr-out').textContent));
  $('#qr-open').addEventListener('click', () => window.open($('#qr-out').textContent, '_blank', 'noopener'));

  window.addEventListener('resize', () => { layoutCrop(); layoutPlace(); });
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  if (location.protocol !== 'https:' && !local) return;
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
}

async function init() {
  state.opts = { ...state.opts, ...lsGet('opts', lsGet('pdfOpts', {})) };
  bindUI();
  await loadSaved();
  $('#doc-name').value = state.name;
  renderPages();
  registerSW();
  setTimeout(preloadOpenCV, 1200);
}

window.__scanner = { state, handleFiles, openEditor, buildPdf, openPlace, onToolButton };
init();

// Quadro para desenhar a assinatura com o dedo.

export class SignaturePad {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.color = '#16133a';
    this.dirty = false;
    this.last = null;
    this.mid = null;
    const block = (e) => { if (e.cancelable) e.preventDefault(); };
    canvas.addEventListener('touchstart', block, { passive: false });
    canvas.addEventListener('touchmove', block, { passive: false });
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', () => { this.last = null; });
    canvas.addEventListener('pointercancel', () => { this.last = null; });
  }

  resize() {
    const r = this.c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.c.width = Math.max(1, Math.round(r.width * dpr));
    this.c.height = Math.max(1, Math.round(r.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    this.clear();
  }

  clear() {
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.c.width, this.c.height);
    this.ctx.restore();
    this.dirty = false;
  }

  pos(e) {
    const r = this.c.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  down(e) {
    e.preventDefault();
    try { this.c.setPointerCapture(e.pointerId); } catch { /* ok */ }
    const p = this.pos(e);
    this.last = p; this.mid = p; this.t = performance.now();
    this.ctx.fillStyle = this.color;
    this.ctx.beginPath(); this.ctx.arc(p[0], p[1], 1.6, 0, Math.PI * 2); this.ctx.fill();
    this.dirty = true;
  }

  move(e) {
    if (!this.last) return;
    e.preventDefault();
    const p = this.pos(e);
    const now = performance.now();
    const speed = Math.hypot(p[0] - this.last[0], p[1] - this.last[1]) / Math.max(1, now - this.t);
    const width = Math.max(1.6, Math.min(4.2, 4.2 - speed * 1.6)); // traço mais fino quando rápido
    const mid = [(this.last[0] + p[0]) / 2, (this.last[1] + p[1]) / 2];
    const ctx = this.ctx;
    ctx.strokeStyle = this.color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(this.mid[0], this.mid[1]);
    ctx.quadraticCurveTo(this.last[0], this.last[1], mid[0], mid[1]);
    ctx.stroke();
    this.mid = mid; this.last = p; this.t = now;
  }

  /** PNG transparente recortado no tamanho do traço. */
  export() {
    const { width: w, height: h } = this.c;
    const d = this.ctx.getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) return null;
    const pad = 10;
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
    x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
    const out = document.createElement('canvas');
    out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
    out.getContext('2d').drawImage(this.c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    const src = out.toDataURL('image/png');
    const ar = out.height / out.width;
    out.width = 0; out.height = 0;
    return { src, ar };
  }
}

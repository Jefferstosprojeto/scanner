// Utilidades compartilhadas: carregar bibliotecas, compartilhar e baixar arquivos.

const scripts = new Map();

/** Carrega um <script> externo uma única vez. */
export function loadScript(url) {
  if (scripts.has(url)) return scripts.get(url);
  const p = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Falha ao baixar um componente (verifique a internet)'));
    document.head.appendChild(s);
  });
  p.catch(() => scripts.delete(url));
  scripts.set(url, p);
  return p;
}

/** Abre o menu de compartilhar do aparelho. Devolve false se não for suportado. */
export async function shareFiles(files) {
  if (!(navigator.canShare && navigator.canShare({ files }))) return false;
  try {
    await navigator.share({ files });
  } catch (e) {
    if (e.name !== 'AbortError') throw e;
  }
  return true;
}

export function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function fmtSize(bytes) {
  return bytes > 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

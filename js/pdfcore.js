// Initialisation de PDF.js (moteur de rendu) et du composant PDFViewer
import * as pdfjsLib from '../lib/pdfjs/pdf.min.mjs';
import { S } from './state.js';
import { getSettings } from './util.js';

globalThis.pdfjsLib = pdfjsLib;
const V = await import('../lib/pdfjs/pdf_viewer.mjs');
export { pdfjsLib, V as pdfjsViewer };

export const PDFJS_BASE = new URL('../lib/pdfjs/', import.meta.url).href;
const settings = getSettings();

pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'pdf.worker.min.mjs';
// Rendu des pages dans un thread dédié : le défilement reste fluide pendant le rendu
if (settings.workerRendering) {
  pdfjsLib.GlobalWorkerOptions.rendererSrc = PDFJS_BASE + 'pdf.renderer.min.mjs';
}

// Qualité de rendu : sur un écran 4K (devicePixelRatio 2,5 à 3), on peut plafonner la résolution des
// canevas pour diviser par 2 à 4 le nombre de pixels à calculer.
const dprDesc = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio') ||
  Object.getOwnPropertyDescriptor(Window.prototype, 'devicePixelRatio');
const realDpr = () => (dprDesc?.get ? dprDesc.get.call(window) : 1);
export const QUALITY_CAPS = { auto: Infinity, balanced: 2, performance: 1.25 };
const cap = QUALITY_CAPS[settings.quality] ?? Infinity;
if (cap !== Infinity && dprDesc?.get) {
  try {
    Object.defineProperty(window, 'devicePixelRatio', { get: () => Math.min(realDpr(), cap), configurable: true });
  } catch (e) { console.warn('DPR', e); }
}
export const nativeDpr = realDpr;

export function createViewer(container, viewerDiv) {
  const eventBus = new V.EventBus();
  const linkService = new V.PDFLinkService({
    eventBus,
    externalLinkTarget: V.LinkTarget.BLANK,
    externalLinkRel: 'noopener noreferrer nofollow',
  });
  const findController = new V.PDFFindController({ eventBus, linkService, updateMatchesCountOnProgress: true });
  const maxCanvasPixels = settings.quality === 'performance' ? 2 ** 23 : settings.quality === 'balanced' ? 2 ** 24 : 2 ** 25;
  const viewer = new V.PDFViewer({
    container,
    viewer: viewerDiv,
    eventBus,
    linkService,
    findController,
    textLayerMode: 1,
    annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS,
    annotationEditorMode: pdfjsLib.AnnotationEditorType.DISABLE,
    imageResourcesPath: PDFJS_BASE + 'images/',
    maxCanvasPixels,
    enableDetailCanvas: true,
    supportsPinchToZoom: true,
    enableAutoLinking: true,
    removePageBorders: true,
  });
  linkService.setViewer(viewer);
  Object.assign(S, { pdfjsLib, viewer, eventBus, linkService, findController });
  return viewer;
}

/**
 * Charge un PDF depuis des octets. `askPassword(reason)` doit renvoyer une promesse
 * résolue avec le mot de passe ou null pour annuler.
 */
export async function loadPdf(bytes, { password, askPassword } = {}) {
  let usedPassword = password ?? null;
  const task = pdfjsLib.getDocument({
    data: bytes.slice(), // PDF.js transfère le tampon au worker : on garde notre copie intacte
    password: password ?? undefined,
    cMapUrl: PDFJS_BASE + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: PDFJS_BASE + 'standard_fonts/',
    wasmUrl: PDFJS_BASE + 'wasm/',
    iccUrl: PDFJS_BASE + 'iccs/',
    enableXfa: true,
    enableHWA: settings.hwa,
  });
  task.onPassword = async (update, reason) => {
    const pw = askPassword ? await askPassword(reason) : null;
    if (pw == null) {
      task.destroy();
      return;
    }
    usedPassword = pw;
    update(pw);
  };
  const pdf = await task.promise;
  return { pdf, password: usedPassword };
}

/** Charge un PDF « jetable » (impression, export d'image…) */
export async function loadTempPdf(bytes) {
  const task = pdfjsLib.getDocument({
    data: bytes.slice(),
    cMapUrl: PDFJS_BASE + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: PDFJS_BASE + 'standard_fonts/',
    wasmUrl: PDFJS_BASE + 'wasm/',
    iccUrl: PDFJS_BASE + 'iccs/',
  });
  return task.promise;
}

/** Rend une page dans un canevas à l'échelle donnée (1 = 72 dpi). */
export async function renderPageToCanvas(pdfPage, scale, rotation, { background = '#ffffff', annotationMode } = {}) {
  const viewport = pdfPage.getViewport({ scale, rotation: rotation ?? pdfPage.rotate });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await pdfPage.render({
    canvasContext: ctx,
    viewport,
    annotationMode: annotationMode ?? pdfjsLib.AnnotationMode.ENABLE_FORMS,
  }).promise;
  return canvas;
}

/** Libère un document PDF.js (en v6, destroy() est porté par la tâche de chargement). */
export function destroyPdf(pdf) {
  try { (pdf?.loadingTask ?? pdf)?.destroy?.(); } catch (e) { console.warn(e); }
}

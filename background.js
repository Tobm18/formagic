// Formagic — service worker
// Redirige les PDF vers le lecteur de l'extension :
//  1. URL http(s) se terminant par .pdf  -> règle declarativeNetRequest (aucun téléchargement en double)
//  2. Réponses servies avec Content-Type: application/pdf -> détection via webRequest
//  3. Fichiers locaux file:///...pdf -> webNavigation (nécessite « Autoriser l'accès aux URL de fichier »)

const VIEWER = chrome.runtime.getURL('viewer.html');
const PDF_URL_RE = '^https?://[^?#]*\\.pdf([?#].*)?$';
const REDIRECT_RULE_ID = 1;

let intercept = true;
let bypass = new Set();
const ready = (async () => {
  const s = await chrome.storage.local.get({ intercept: true });
  intercept = s.intercept;
  const b = await chrome.storage.session.get({ bypass: [] });
  bypass = new Set(b.bypass);
})();

function viewerUrl(fileUrl) {
  return VIEWER + '?file=' + fileUrl;
}

async function applyRules() {
  await ready;
  const addRules = intercept
    ? [{
        id: REDIRECT_RULE_ID,
        priority: 1,
        action: { type: 'redirect', redirect: { regexSubstitution: VIEWER + '?file=\\0' } },
        condition: {
          regexFilter: PDF_URL_RE,
          isUrlFilterCaseSensitive: false,
          resourceTypes: ['main_frame'],
          requestMethods: ['get'],
        },
      }]
    : [];
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [REDIRECT_RULE_ID], addRules });
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function addBypass(url) {
  await ready;
  bypass.add(url);
  await chrome.storage.session.set({ bypass: [...bypass] });
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const id = rules.reduce((m, r) => Math.max(m, r.id), 100) + 1;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [{
        id,
        priority: 2,
        action: { type: 'allow' },
        condition: { regexFilter: '^' + escapeRe(url.split('#')[0]) + '(#.*)?$', resourceTypes: ['main_frame'] },
      }],
    });
  } catch (e) {
    console.warn('Règle de contournement impossible', e);
  }
}

function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'open-link',
      title: 'Ouvrir le lien avec Formagic',
      contexts: ['link'],
    });
    chrome.contextMenus.create({
      id: 'open-page',
      title: 'Ouvrir ce PDF avec Formagic',
      contexts: ['page'],
      documentUrlPatterns: ['*://*/*.pdf', '*://*/*.PDF', 'file:///*.pdf', 'file:///*.PDF'],
    });
  });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await applyRules();
  setupMenus();
  if (details.reason === 'install') {
    chrome.tabs.create({ url: VIEWER + '?welcome=1' });
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await applyRules();
  setupMenus();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const url = info.menuItemId === 'open-link' ? info.linkUrl : info.pageUrl;
  if (!url) return;
  if (info.menuItemId === 'open-page' && tab?.id >= 0) {
    chrome.tabs.update(tab.id, { url: viewerUrl(url) });
  } else {
    chrome.tabs.create({ url: viewerUrl(url), index: tab ? tab.index + 1 : undefined });
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'intercept' in changes) {
    intercept = changes.intercept.newValue !== false;
    applyRules();
  }
});

// 2. Détection par Content-Type (PDF sans extension .pdf dans l'URL)
chrome.webRequest.onHeadersReceived.addListener(
  async (d) => {
    if (d.tabId < 0 || d.frameId !== 0 || d.method !== 'GET') return;
    if (d.statusCode < 200 || d.statusCode >= 300) return;
    await ready; // le service worker peut se réveiller ici : attendre l'état (contournements)
    if (!intercept || bypass.has(d.url)) return;
    if (new RegExp(PDF_URL_RE, 'i').test(d.url)) return; // déjà géré par la règle DNR (ou contourné)
    const h = (name) => d.responseHeaders?.find((x) => x.name.toLowerCase() === name)?.value || '';
    const type = h('content-type').toLowerCase();
    const disp = h('content-disposition').toLowerCase();
    const isPdf = type.includes('application/pdf') || type.includes('application/x-pdf') ||
      (type.includes('application/octet-stream') && /\.pdf["']?\s*(;|$)/.test(disp));
    if (!isPdf) return;
    if (disp.startsWith('attachment')) return; // laisser Chrome télécharger
    chrome.tabs.update(d.tabId, { url: viewerUrl(d.url) });
  },
  { urls: ['<all_urls>'], types: ['main_frame'] },
  ['responseHeaders']
);

// 3. Fichiers locaux
chrome.webNavigation.onBeforeNavigate.addListener(
  async (d) => {
    await ready;
    if (d.frameId !== 0 || !intercept || bypass.has(d.url)) return;
    let path = '';
    try { path = new URL(d.url).pathname; } catch { return; }
    if (!/\.pdf$/i.test(path)) return;
    chrome.tabs.update(d.tabId, { url: viewerUrl(d.url) });
  },
  { url: [{ schemes: ['file'] }] }
);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await ready;
    switch (msg?.type) {
      case 'bypass':
        await addBypass(msg.url);
        sendResponse({ ok: true });
        break;
      case 'getState':
        sendResponse({
          intercept,
          fileAccess: await chrome.extension.isAllowedFileSchemeAccess(),
        });
        break;
      default:
        sendResponse({ ok: false });
    }
  })();
  return true;
});

applyRules();

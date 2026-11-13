const viewer = chrome.runtime.getURL('viewer.html');

document.getElementById('open').onclick = () => {
  chrome.tabs.create({ url: viewer + '?action=open' });
  window.close();
};
document.getElementById('new').onclick = () => {
  chrome.tabs.create({ url: viewer + '?action=new' });
  window.close();
};

const cb = document.getElementById('intercept');
chrome.storage.local.get({ intercept: true }, (s) => { cb.checked = s.intercept; });
cb.onchange = () => chrome.storage.local.set({ intercept: cb.checked });

chrome.extension.isAllowedFileSchemeAccess((allowed) => {
  document.getElementById('fileWarn').hidden = allowed;
});
document.getElementById('ext').onclick = () => {
  chrome.tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id });
  window.close();
};

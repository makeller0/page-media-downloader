import { canDownload, downloadMedia, videoUnavailable } from './download.js';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'image', title: '下载这张图片', contexts: ['image'] });
  chrome.contextMenus.create({ id: 'video', title: '下载这个视频', contexts: ['video'] });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.action === 'download-drag' && ['image', 'video'].includes(message.type)) {
    startDownload(message.url, message.type).then(error => sendResponse({ error }));
    return true;
  }
  if (message?.action !== 'download-batch' || !Array.isArray(message.items)) return;

  const requests = message.items.map(async ({ url, type }) => downloadMedia(url, type));
  Promise.allSettled(requests).then(results => {
    const started = results.filter(result => result.status === 'fulfilled').length;
    sendResponse({ started, failed: results.length - started });
  });
  return true;
});

async function startDownload(url, type) {
  if (!canDownload(url, type)) {
    return type === 'video' ? videoUnavailable : '这张图片不能直接下载。';
  }
  try {
    await downloadMedia(url, type);
    return '';
  } catch {
    return '未能开始下载，请稍后再试。';
  }
}

async function showError(tabId, title) {
  if (tabId === undefined) return;
  try {
    await chrome.action.setTitle({ tabId, title });
    await chrome.action.setBadgeText({ tabId, text: '!' });
  } catch {
    // The tab may have closed while starting the download.
  }
}

chrome.contextMenus.onClicked.addListener(async ({ menuItemId, srcUrl }, tab) => {
  if (menuItemId !== 'image' && menuItemId !== 'video') return;
  const error = await startDownload(srcUrl, menuItemId);
  if (error) await showError(tab?.id, error);
});

import { canDownload, downloadMedia, videoUnavailable } from './download.js';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'image', title: '下载这张图片', contexts: ['image'] });
  chrome.contextMenus.create({ id: 'video', title: '下载这个视频', contexts: ['video'] });
});

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
  if (!canDownload(srcUrl, menuItemId)) {
    await showError(tab?.id, menuItemId === 'video' ? videoUnavailable : '这张图片不能直接下载。');
    return;
  }
  try {
    await downloadMedia(srcUrl, menuItemId);
  } catch {
    await showError(tab?.id, '未能开始下载，请稍后再试。');
  }
});

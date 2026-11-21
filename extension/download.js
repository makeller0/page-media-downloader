export const videoUnavailable = '这个视频是流式视频，不能直接下载。';

export function canDownload(raw, type) {
  try {
    const url = new URL(raw);
    if (type === 'video' && /\.(?:m3u8?|mpd)$/i.test(url.pathname)) return false;
    return ['https:', 'http:'].includes(url.protocol)
      || (type === 'image' && /^data:image\//i.test(url.href));
  } catch {
    return false;
  }
}

export function downloadMedia(url, type) {
  if (!canDownload(url, type)) throw new Error('无法直接下载这个文件。');
  return chrome.downloads.download({ url, conflictAction: 'uniquify' });
}

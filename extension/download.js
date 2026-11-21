export const videoUnavailable = '这个视频是流式视频，不能直接下载。';

const imageExtensions = new Map([
  ['apng', 'png'],
  ['avif', 'avif'],
  ['bmp', 'bmp'],
  ['gif', 'gif'],
  ['jpeg', 'jpg'],
  ['png', 'png'],
  ['svg+xml', 'svg'],
  ['webp', 'webp'],
  ['x-icon', 'ico']
]);

export function canDownload(raw, type, mimeType) {
  try {
    const url = new URL(raw);
    if (type === 'video' && (/\.(?:m3u8?|mpd)$/i.test(url.pathname) ||
      /^\s*application\/(?:x-mpegurl|vnd\.apple\.mpegurl|dash\+xml)\s*(?:;|$)/i.test(mimeType))) return false;
    return ['https:', 'http:'].includes(url.protocol)
      || (type === 'image' && /^data:image\//i.test(url.href));
  } catch {
    return false;
  }
}

export function downloadMedia(url, type, mimeType) {
  if (!canDownload(url, type, mimeType)) throw new Error('无法直接下载这个文件。');
  const options = { url, conflictAction: 'uniquify' };
  const inlineFormat = url.match(/^data:image\/([^;,]+)/i)?.[1].toLowerCase();
  const extension = imageExtensions.get(inlineFormat);
  if (extension) options.filename = `网页图片.${extension}`;
  return chrome.downloads.download(options);
}

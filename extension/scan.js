export function scanPage() {
  const items = new Map();
  const visited = new Set();
  let blockedVideo = false;
  const playlist = /\.(?:m3u8?|mpd)$/i;
  const videoFile = /\.(?:mp4|webm|ogv|mov|m4v)$/i;
  const lazyImageAttrs = ['data-src', 'data-lazy-src', 'data-original'];
  const srcsetAttrs = ['srcset', 'data-srcset', 'data-lazy-srcset'];

  function resolve(raw, base, type) {
    if (!raw?.trim() || raw.trim().startsWith('#')) return null;
    try {
      const url = new URL(raw, base);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url;
      if (type === 'image' && /^data:image\//i.test(url.href)) return url;
      if (type === 'video' && url.protocol === 'blob:') blockedVideo = true;
    } catch {
      return null;
    }
    return null;
  }

  function add(raw, base, type, width = 0, height = 0, poster = '') {
    const url = resolve(raw, base, type);
    if (!url) return;
    if (type === 'video' && playlist.test(url.pathname)) {
      blockedVideo = true;
      return;
    }
    const key = type + ':' + url.href;
    const entry = items.get(key);
    if (!entry) {
      items.set(key, { url: url.href, type, width, height, poster });
    } else {
      if (width && height && !entry.width) Object.assign(entry, { width, height });
      if (poster && !entry.poster) entry.poster = poster;
    }
  }

  function addSets(element, base) {
    for (const attr of srcsetAttrs) {
      let rest = element.getAttribute(attr)?.trimStart() || '';
      while (rest) {
        const token = rest.match(/^[^\t\n\f\r ]+/)[0];
        const url = token.replace(/,+$/, '');
        add(url, base, 'image');
        rest = rest.slice(token.length);
        if (token === url) {
          const comma = rest.indexOf(',');
          rest = comma === -1 ? '' : rest.slice(comma + 1);
        }
        rest = rest.trimStart();
      }
    }
  }

  function read(doc) {
    if (!doc || visited.has(doc)) return;
    visited.add(doc);
    for (const element of doc.querySelectorAll('*')) {
      const base = element.baseURI;
      if (element.localName === 'img') {
        add(element.currentSrc, base, 'image', element.naturalWidth, element.naturalHeight);
        add(element.getAttribute('src'), base, 'image');
        for (const attr of lazyImageAttrs) add(element.getAttribute(attr), base, 'image');
        addSets(element, base);
      } else if (element.localName === 'source' && element.parentElement?.localName === 'picture') {
        addSets(element, base);
      } else if (element.localName === 'video') {
        const poster = resolve(element.getAttribute('poster'), base, 'image')?.href;
        const streams = new Set();
        if (element.srcObject) blockedVideo = true;
        for (const source of element.querySelectorAll('source')) {
          if (/mpegurl|dash\+xml/i.test(source.type)) {
            blockedVideo = true;
            for (const attr of ['src', 'data-src']) {
              streams.add(resolve(source.getAttribute(attr), source.baseURI, 'video')?.href);
            }
          } else {
            add(source.getAttribute('src'), source.baseURI, 'video', 0, 0, poster);
            add(source.getAttribute('data-src'), source.baseURI, 'video', 0, 0, poster);
          }
        }
        if (!streams.has(element.currentSrc)) {
          add(element.currentSrc, base, 'video', element.videoWidth, element.videoHeight, poster);
        }
        add(element.getAttribute('src'), base, 'video', 0, 0, poster);
        add(element.getAttribute('data-src'), base, 'video', 0, 0, poster);
      } else if (element.localName === 'iframe') {
        read(element.contentDocument);
      }
      const css = doc.defaultView.getComputedStyle(element).backgroundImage;
      for (const match of (css || '').matchAll(/url\((?:"([^"]*)"|'([^']*)'|([^)]*))\)/gi)) {
        add(match[1] ?? match[2] ?? match[3], base, 'image');
      }
    }
    for (const entry of doc.defaultView.performance.getEntriesByType('resource')) {
      if (!/^https?:/i.test(entry.name)) continue;
      const url = resolve(entry.name, doc.baseURI, 'video');
      if (!url) continue;
      if (videoFile.test(url.pathname)) add(url.href, doc.baseURI, 'video');
      if (playlist.test(url.pathname)) blockedVideo = true;
    }
  }

  read(document);
  return { items: [...items.values()], blockedVideo };
}

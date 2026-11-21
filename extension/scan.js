export async function scanPage() {
  const items = new Map();
  const visited = new Set();
  let blockedVideo = false;
  const playlist = /\.(?:m3u8?|mpd)$/i;
  const videoFile = /\.(?:mp4|webm|ogv|mov|m4v)$/i;
  const lazyImageAttrs = ['data-src', 'data-lazy-src', 'data-original'];
  const srcsetAttrs = ['srcset', 'data-srcset', 'data-lazy-srcset'];
  const stickerName = /表情|贴纸|(?:^|[^a-z])(?:stickers?|emojis?|emoticons?|twemoji)(?:$|[^a-z])/i;

  function imageCategory(url) {
    const mime = url.protocol === 'data:' ? url.href.match(/^data:([^;,]+)/i)?.[1] : '';
    if (/^image\/(?:gif|apng)$/i.test(mime || '') ||
        (url.protocol !== 'data:' && /\.(?:gif|apng)$/i.test(url.pathname))) return 'animated';
    if (url.protocol !== 'data:') {
      let path = url.pathname;
      try {
        path = decodeURIComponent(path);
      } catch {
        // Keep the original path if it contains malformed escapes.
      }
      if (stickerName.test(path)) return 'sticker';
    }
    return '';
  }

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

  function add(raw, base, type, width = 0, height = 0, poster = '', category = '') {
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
    const candidate = type === 'image' ? imageCategory(url) || category : category;
    const item = items.get(key);
    if (candidate && (!item.category || candidate === 'animated')) item.category = candidate;
  }

  function addSets(element, base, category = '') {
    for (const attr of srcsetAttrs) {
      let rest = element.getAttribute(attr)?.trimStart() || '';
      while (rest) {
        const token = rest.match(/^[^\t\n\f\r ]+/)[0];
        const url = token.replace(/,+$/, '');
        add(url, base, 'image', 0, 0, '', category);
        rest = rest.slice(token.length);
        if (token === url) {
          const comma = rest.indexOf(',');
          rest = comma === -1 ? '' : rest.slice(comma + 1);
        }
        rest = rest.trimStart();
      }
    }
  }

  function addCssImages(css, base) {
    for (const match of (css || '').matchAll(/url\((?:"([^"]*)"|'([^']*)'|([^)]*))\)/gi)) {
      add(match[1] ?? match[2] ?? match[3], base, 'image');
    }
  }

  function readRoot(root, doc) {
    for (const element of root.querySelectorAll('*')) {
      const base = element.baseURI;
      if (element.localName === 'img') {
        const names = ['alt', 'title', 'class', 'aria-label'].map(attr => element.getAttribute(attr)).join(' ');
        const category = stickerName.test(names) ? 'sticker' : '';
        add(element.currentSrc, base, 'image', element.naturalWidth, element.naturalHeight, '', category);
        add(element.getAttribute('src'), base, 'image', 0, 0, '', category);
        for (const attr of lazyImageAttrs) add(element.getAttribute(attr), base, 'image', 0, 0, '', category);
        addSets(element, base, category);
      } else if (element.localName === 'source' && element.parentElement?.localName === 'picture') {
        addSets(element, base);
      } else if (element.localName === 'video') {
        const poster = resolve(element.getAttribute('poster'), base, 'image')?.href;
        const category = element.loop && (element.muted || element.defaultMuted)
          && (!Number.isFinite(element.duration) || element.duration <= 30) ? 'animated' : '';
        const streams = new Set();
        if (element.srcObject) blockedVideo = true;
        for (const source of element.querySelectorAll('source')) {
          if (/mpegurl|dash\+xml/i.test(source.type)) {
            blockedVideo = true;
            for (const attr of ['src', 'data-src']) {
              streams.add(resolve(source.getAttribute(attr), source.baseURI, 'video')?.href);
            }
          } else {
            add(source.getAttribute('src'), source.baseURI, 'video', 0, 0, poster, category);
            add(source.getAttribute('data-src'), source.baseURI, 'video', 0, 0, poster, category);
          }
        }
        if (!streams.has(element.currentSrc)) {
          add(element.currentSrc, base, 'video', element.videoWidth, element.videoHeight, poster, category);
        }
        add(element.getAttribute('src'), base, 'video', 0, 0, poster, category);
        add(element.getAttribute('data-src'), base, 'video', 0, 0, poster, category);
      } else if (element.localName === 'iframe') {
        read(element.contentDocument);
      }
      addCssImages(doc.defaultView.getComputedStyle(element).backgroundImage, base);
      for (const pseudo of ['::before', '::after']) {
        const style = doc.defaultView.getComputedStyle(element, pseudo);
        if (style.content && style.content !== 'none' && style.content !== 'normal') {
          addCssImages(style.content, base);
          addCssImages(style.backgroundImage, base);
        }
      }
      if (element.shadowRoot) readRoot(element.shadowRoot, doc);
    }
  }

  function read(doc) {
    if (!doc?.defaultView || visited.has(doc)) return;
    visited.add(doc);
    readRoot(doc, doc);
    for (const entry of doc.defaultView.performance.getEntriesByType('resource')) {
      if (!/^https?:/i.test(entry.name)) continue;
      const url = resolve(entry.name, doc.baseURI, 'video');
      if (!url) continue;
      if (videoFile.test(url.pathname)) add(url.href, doc.baseURI, 'video');
      if (playlist.test(url.pathname)) blockedVideo = true;
    }
  }

  function isAnimated(bytes) {
    const tag = offset => String.fromCharCode(...bytes.subarray(offset, offset + 4));
    if (tag(0) === 'GIF8') return true;
    if (tag(0) === 'RIFF' && tag(8) === 'WEBP') {
      return tag(12) === 'VP8X' && Boolean(bytes[20] & 2);
    }
    if (bytes[0] !== 137 || tag(1) !== 'PNG\r') return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 8; i + 8 <= bytes.length; i += 12 + view.getUint32(i)) {
      const kind = tag(i + 4);
      if (kind === 'acTL') return true;
      if (kind === 'IDAT' || kind === 'IEND') break;
    }
    return false;
  }

  async function detectAnimatedImages(images) {
    const candidates = images.filter(({ type, url, category }) => {
      if (type !== 'image' || category === 'animated') return false;
      const parsed = new URL(url);
      if (parsed.protocol === 'data:') return /^data:image\/(?:png|webp)[;,]/i.test(url);
      const name = parsed.pathname.split('/').at(-1);
      return /\.(?:png|webp)$/i.test(name) || !name.includes('.');
    });
    const limit = 32768;
    const signal = AbortSignal.timeout(1500);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(6, candidates.length) }, async () => {
      while (!signal.aborted && next < candidates.length) {
        const item = candidates[next++];
        let reader;
        try {
          const headers = item.url.startsWith('data:') ? undefined : { Range: `bytes=0-${limit - 1}` };
          const response = await fetch(item.url, { headers, cache: 'force-cache', signal });
          if (!response.ok) continue;
          reader = response.body?.getReader();
          if (/^image\/(?:gif|apng)\b/i.test(response.headers.get('Content-Type') || '')) {
            item.category = 'animated';
            continue;
          }
          if (!reader) continue;
          const bytes = new Uint8Array(limit);
          let size = 0;
          while (size < limit) {
            const { value, done } = await reader.read();
            if (done) break;
            const chunk = value.subarray(0, limit - size);
            bytes.set(chunk, size);
            size += chunk.length;
          }
          if (isAnimated(bytes.subarray(0, size))) item.category = 'animated';
        } catch {
          continue;
        } finally {
          reader?.cancel().catch(() => {});
        }
      }
    }));
  }

  read(document);
  const media = [...items.values()].filter(({ type, width, height }) =>
    type !== 'image' || !(width && height && width <= 2 && height <= 2)
  );
  await detectAnimatedImages(media);
  return { items: media.filter(({ type, width, height, category }) =>
    type !== 'image' || category || !(width && height && width <= 16 && height <= 16)
  ), blockedVideo };
}

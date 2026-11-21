(() => {
  let enabled = false;
  let gesture;
  let toast;
  let toastTimer;

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.dragToDownload) return;
    enabled = changes.dragToDownload.newValue !== false;
    if (!enabled) gesture = undefined;
  });
  chrome.storage.local.get({ dragToDownload: true }).then(settings => {
    enabled = settings.dragToDownload;
  }).catch(() => {});

  function mediaAt(event) {
    const path = event.composedPath();
    const image = path.find(node => node.localName === 'img');
    if (image) {
      const url = image.currentSrc || image.src;
      return url && { url, type: 'image' };
    }
    const video = path.find(node => node.localName === 'video');
    if (video) {
      const bounds = video.getBoundingClientRect();
      if (video.controls && event.clientY >= bounds.bottom - Math.min(48, bounds.height * .35)) return;
      if (video.currentSrc || video.src || video.srcObject) {
        return { url: video.currentSrc || video.src || '', type: 'video' };
      }
      return;
    }
    const elements = path.filter(node => node instanceof Element).slice(0, 5);
    for (const target of elements) {
      for (const pseudo of [null, '::after', '::before']) {
        const style = getComputedStyle(target, pseudo);
        if (pseudo && (!style.content || style.content === 'none' || style.content === 'normal')) continue;
        const media = backgroundMedia(style.backgroundImage, target.baseURI);
        if (media) return media;
      }
    }
  }

  function backgroundMedia(background, base) {
    const match = background.match(/url\((?:"([^"]*)"|'([^']*)'|([^)]*))\)/i);
    const url = match?.[1] ?? match?.[2] ?? match?.[3];
    if (!url) return;
    try {
      return { url: new URL(url, base).href, type: 'image', background: true };
    } catch {
      return;
    }
  }

  function showToast(message) {
    toast?.remove();
    clearTimeout(toastTimer);
    const host = document.createElement('div');
    host.style.cssText = 'all: initial !important; position: fixed !important; top: 16px !important; right: 16px !important; z-index: 2147483647 !important; pointer-events: none !important;';
    const label = document.createElement('div');
    label.setAttribute('role', 'status');
    label.style.cssText = 'max-width: 250px; padding: 10px 14px; border-radius: 8px; background: #174639; color: #fff; font: 14px/1.5 system-ui, sans-serif; box-shadow: 0 2px 8px #0004;';
    label.textContent = message;
    host.attachShadow({ mode: 'closed' }).append(label);
    document.documentElement.append(host);
    toast = host;
    toastTimer = setTimeout(() => host.remove(), 3000);
  }

  async function download(url, type) {
    try {
      const { error } = await chrome.runtime.sendMessage({ action: 'download-drag', url, type });
      showToast(error || '已开始下载');
    } catch {
      showToast('未能开始下载，请稍后再试。');
    }
  }

  function finish(event) {
    const start = gesture;
    gesture = undefined;
    if (!enabled || (start.background && document.getSelection()?.isCollapsed === false)) return;
    const down = event.clientY - start.y;
    const sideways = Math.abs(event.clientX - start.x);
    if (down >= 60 && down >= sideways * 1.5) download(start.url, start.type);
  }

  window.addEventListener('pointerdown', event => {
    if (!event.isTrusted || !event.isPrimary || event.pointerType !== 'mouse' || event.button !== 0) return;
    gesture = undefined;
    if (!enabled) return;
    const media = mediaAt(event);
    if (media) gesture = { ...media, id: event.pointerId, x: event.clientX, y: event.clientY };
  }, true);

  window.addEventListener('pointermove', event => {
    if (!event.isTrusted || gesture?.id !== event.pointerId || gesture.native) return;
    if (!(event.buttons & 1)) gesture = undefined;
    else if (event.clientY - gesture.y >= 60) gesture.moved = true;
  }, true);

  window.addEventListener('pointerup', event => {
    if (!event.isTrusted || gesture?.id !== event.pointerId || gesture.native || event.button !== 0) return;
    if (gesture.moved) finish(event);
    else gesture = undefined;
  }, true);

  window.addEventListener('pointercancel', event => {
    if (event.isTrusted && gesture?.id === event.pointerId && !gesture.native) gesture = undefined;
  }, true);

  window.addEventListener('dragstart', event => {
    if (!event.isTrusted || !gesture) return;
    if (gesture.background && document.getSelection()?.isCollapsed === false) {
      gesture = undefined;
      return;
    }
    const start = gesture;
    start.native = true;
    setTimeout(() => {
      if (event.defaultPrevented) start.native = false;
    }, 0);
  }, true);

  window.addEventListener('dragend', event => {
    if (!event.isTrusted || !gesture?.native) return;
    const dropEffect = event.dataTransfer?.dropEffect ?? 'none';
    if (dropEffect !== 'none' ||
        event.clientX < 0 || event.clientX >= innerWidth || event.clientY < 0 || event.clientY >= innerHeight) {
      gesture = undefined;
      return;
    }
    finish(event);
  }, true);
})();

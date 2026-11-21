import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { canDownload, downloadMedia } from '../extension/download.js';
import { scanPage } from '../extension/scan.js';

const baseURI = 'https://example.test/album/';
function element(localName, attrs = {}, properties = {}) {
  return { localName, baseURI, getAttribute: name => attrs[name] ?? null, ...properties };
}
function documentWith(elements, resources = []) {
  return {
    baseURI,
    querySelectorAll: () => elements,
    defaultView: {
      getComputedStyle: (node, pseudo) => pseudo ? node[pseudo] || {} : ({ backgroundImage: node.background }),
      performance: { getEntriesByType: () => resources.map(name => ({ name })) }
    }
  };
}
async function runScan(document, fetch = async () => new Response(null, { status: 404 })) {
  const result = await vm.runInNewContext(`(${scanPage.toString()})()`, { document, URL, fetch, AbortSignal });
  return JSON.parse(JSON.stringify(result));
}

test('scans and deduplicates image candidates, retaining known dimensions', async () => {
  const pictureSource = element('source', { srcset: 'picture.avif 2x' }, { parentElement: element('picture') });
  const img = element('img', {
    src: 'small.png',
    'data-lazy-src': 'lazy.png',
    srcset: 'small.png 1x, large.png?q=a,b 2x',
    'data-srcset': 'data:image/png;base64,FAKE 1x, retina.png 2x'
  }, { currentSrc: baseURI + 'large.png?q=a,b', naturalWidth: 800, naturalHeight: 600 });
  const background = element('div', {}, { background: `url("${baseURI}small.png"), url("${baseURI}background.png")` });
  const frame = element('iframe', {}, { contentDocument: documentWith([element('img', { src: 'frame.png' })]) });
  const { items, blockedVideo } = await runScan(documentWith([pictureSource, img, background, frame]));
  assert.equal(blockedVideo, false);
  assert.deepEqual(items.map(x => x.url), [
    baseURI + 'picture.avif', baseURI + 'large.png?q=a,b', baseURI + 'small.png',
    baseURI + 'lazy.png', 'data:image/png;base64,FAKE', baseURI + 'retina.png',
    baseURI + 'background.png', baseURI + 'frame.png'
  ]);
  assert.deepEqual(items[1], { url: baseURI + 'large.png?q=a,b', type: 'image', width: 800, height: 600, poster: '' });
});

test('collects direct video files and reports stream-only sources without listing them', async () => {
  const mp4 = element('source', { src: 'clip.mp4?token=demo' }, { type: 'video/mp4' });
  const webm = element('source', { 'data-src': 'clip.webm' }, { type: 'video/webm' });
  const stream = element('source', { src: 'playlist' }, { type: 'application/vnd.apple.mpegurl' });
  const video = element('video', { poster: 'poster.jpg' }, {
    currentSrc: baseURI + 'clip.mp4?token=demo', videoWidth: 640, videoHeight: 360,
    querySelectorAll: () => [mp4, webm]
  });
  const streamVideo = element('video', {}, { currentSrc: baseURI + 'playlist', querySelectorAll: () => [stream] });
  const blobVideo = element('video', { src: 'blob:https://example.test/demo' }, { querySelectorAll: () => [] });
  const { items, blockedVideo } = await runScan(documentWith(
    [video, streamVideo, blobVideo],
    [baseURI + 'manifest.M3U8?demo', baseURI + 'clip.mp4?token=demo', baseURI + 'fetch.webm']
  ));
  assert.equal(blockedVideo, true);
  assert.deepEqual(items.map(x => x.url), [
    baseURI + 'clip.mp4?token=demo', baseURI + 'clip.webm', baseURI + 'fetch.webm'
  ]);
  assert.deepEqual(items[0], { url: baseURI + 'clip.mp4?token=demo', type: 'video', width: 640, height: 360, poster: baseURI + 'poster.jpg' });
});

test('finds sticker images and animations in the DOM, CSS and open shadow roots', async () => {
  const img = (name, width, height, alt = '') => element('img', { src: name, alt }, {
    currentSrc: new URL(name, baseURI).href, naturalWidth: width, naturalHeight: height
  });
  const host = element('div', {}, {
    shadowRoot: documentWith([img('smile.svg', 64, 64, '笑脸表情包')]),
    '::before': { content: 'url("bounce.gif")' },
    '::after': { content: '""', backgroundImage: 'url("animation.png")' }
  });
  const looping = element('video', { src: 'loop.mp4' }, {
    loop: true, muted: true, duration: 3, querySelectorAll: () => []
  });
  const images = [
    img('motion.webp', 180, 126), img('still.webp', 180, 126), img('cdn-asset', 80, 80),
    img('tracking-pixel.gif', 1, 1), img('ui-icon.png', 16, 16)
  ];
  const animationWebp = Buffer.from('524946460000000057454250565038580a00000002000000', 'hex');
  const stillWebp = Buffer.from(animationWebp);
  stillWebp[20] = 0;
  const apng = Buffer.from('89504e470d0a1a0a000000086163544c000000020000000000000000', 'hex');
  const responses = new Map([
    ['animation.png', new Response(apng, { headers: { 'Content-Type': 'image/png' } })],
    ['motion.webp', new Response(animationWebp)],
    ['still.webp', new Response(stillWebp)],
    ['cdn-asset', new Response(new Uint8Array(), { headers: { 'Content-Type': 'image/gif' } })]
  ]);
  const { items } = await runScan(documentWith([host, ...images, looping]), async url =>
    responses.get(url.slice(baseURI.length)) || new Response(null, { status: 404 })
  );
  assert.deepEqual(items.map(({ url, type, category }) => [url.slice(baseURI.length), type, category]), [
    ['bounce.gif', 'image', 'animated'],
    ['animation.png', 'image', 'animated'],
    ['smile.svg', 'image', 'sticker'],
    ['motion.webp', 'image', 'animated'],
    ['still.webp', 'image', undefined],
    ['cdn-asset', 'image', 'animated'],
    ['loop.mp4', 'video', 'animated']
  ]);
});

test('only submits downloadable media URLs, keeping existing downloads safe from overwrites', async t => {
  const calls = [];
  const originalChrome = globalThis.chrome;
  globalThis.chrome = { downloads: { download: async options => { calls.push(options); return 123; } } };
  t.after(() => { globalThis.chrome = originalChrome; });
  assert.equal(canDownload('data:image/png;base64,FAKE', 'image'), true);
  for (const url of ['blob:https://example.test/demo', baseURI + 'live.m3u8?hi', 'javascript:alert(1)']) {
    assert.equal(canDownload(url, 'video'), false);
    assert.throws(() => downloadMedia(url, 'video'));
  }
  const url = baseURI + 'clip.mp4?token=demo';
  assert.equal(await downloadMedia(url, 'video'), 123);
  assert.deepEqual(calls, [{ url, conflictAction: 'uniquify' }]);
  const inline = [
    ['data:image/gif;base64,FAKE', 'gif'],
    ['data:image/apng;base64,FAKE', 'png'],
    ['data:image/webp;base64,FAKE', 'webp'],
    ['data:image/svg+xml,%3Csvg%3E%3C/svg%3E', 'svg']
  ];
  for (const [dataUrl] of inline) await downloadMedia(dataUrl, 'image');
  assert.deepEqual(calls.slice(1), inline.map(([dataUrl, extension]) => ({
    url: dataUrl, conflictAction: 'uniquify', filename: `网页图片.${extension}`
  })));
});

test('the background submits the whole batch before any individual download finishes', async t => {
  const pending = new Map();
  let receiveMessage;
  const originalChrome = globalThis.chrome;
  globalThis.chrome = {
    runtime: {
      onInstalled: { addListener() {} },
      onMessage: { addListener: listener => { receiveMessage = listener; } }
    },
    contextMenus: { onClicked: { addListener() {} } },
    downloads: { download: ({ url }) => new Promise((resolve, reject) => pending.set(url, { resolve, reject })) }
  };
  t.after(() => { globalThis.chrome = originalChrome; });
  await import('../extension/background.js');

  const first = baseURI + 'image.png';
  const second = baseURI + 'clip.mp4';
  const third = baseURI + 'last.png';
  let reply;
  const response = new Promise(resolve => { reply = resolve; });
  assert.equal(receiveMessage({ action: 'other' }, {}, reply), undefined);
  assert.equal(receiveMessage({
    action: 'download-batch',
    items: [
      { url: first, type: 'image' },
      { url: second, type: 'video' },
      { url: third, type: 'image' }
    ]
  }, {}, reply), true);
  assert.deepEqual([...pending.keys()], [first, second, third]);
  pending.get(first).resolve(1);
  pending.get(second).reject(new Error('Download cancelled'));
  pending.get(third).resolve(2);
  assert.deepEqual(await response, { started: 2, failed: 1 });
});

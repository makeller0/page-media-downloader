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
      getComputedStyle: node => ({ backgroundImage: node.background }),
      performance: { getEntriesByType: () => resources.map(name => ({ name })) }
    }
  };
}
function runScan(document) {
  const result = vm.runInNewContext(`(${scanPage.toString()})()`, { document, URL });
  return JSON.parse(JSON.stringify(result));
}

test('scans and deduplicates image candidates, retaining known dimensions', () => {
  const pictureSource = element('source', { srcset: 'picture.avif 2x' }, { parentElement: element('picture') });
  const img = element('img', {
    src: 'small.png',
    'data-lazy-src': 'lazy.png',
    srcset: 'small.png 1x, large.png?q=a,b 2x',
    'data-srcset': 'data:image/png;base64,FAKE 1x, retina.png 2x'
  }, { currentSrc: baseURI + 'large.png?q=a,b', naturalWidth: 800, naturalHeight: 600 });
  const background = element('div', {}, { background: `url("${baseURI}small.png"), url("${baseURI}background.png")` });
  const frame = element('iframe', {}, { contentDocument: documentWith([element('img', { src: 'frame.png' })]) });
  const { items, blockedVideo } = runScan(documentWith([pictureSource, img, background, frame]));
  assert.equal(blockedVideo, false);
  assert.deepEqual(items.map(x => x.url), [
    baseURI + 'picture.avif', baseURI + 'large.png?q=a,b', baseURI + 'small.png',
    baseURI + 'lazy.png', 'data:image/png;base64,FAKE', baseURI + 'retina.png',
    baseURI + 'background.png', baseURI + 'frame.png'
  ]);
  assert.deepEqual(items[1], { url: baseURI + 'large.png?q=a,b', type: 'image', width: 800, height: 600, poster: '' });
});

test('collects direct video files and reports stream-only sources without listing them', () => {
  const mp4 = element('source', { src: 'clip.mp4?token=demo' }, { type: 'video/mp4' });
  const webm = element('source', { 'data-src': 'clip.webm' }, { type: 'video/webm' });
  const stream = element('source', { src: 'playlist' }, { type: 'application/vnd.apple.mpegurl' });
  const video = element('video', { poster: 'poster.jpg' }, {
    currentSrc: baseURI + 'clip.mp4?token=demo', videoWidth: 640, videoHeight: 360,
    querySelectorAll: () => [mp4, webm]
  });
  const streamVideo = element('video', {}, { currentSrc: baseURI + 'playlist', querySelectorAll: () => [stream] });
  const blobVideo = element('video', { src: 'blob:https://example.test/demo' }, { querySelectorAll: () => [] });
  const { items, blockedVideo } = runScan(documentWith(
    [video, streamVideo, blobVideo],
    [baseURI + 'manifest.M3U8?demo', baseURI + 'clip.mp4?token=demo', baseURI + 'fetch.webm']
  ));
  assert.equal(blockedVideo, true);
  assert.deepEqual(items.map(x => x.url), [
    baseURI + 'clip.mp4?token=demo', baseURI + 'clip.webm', baseURI + 'fetch.webm'
  ]);
  assert.deepEqual(items[0], { url: baseURI + 'clip.mp4?token=demo', type: 'video', width: 640, height: 360, poster: baseURI + 'poster.jpg' });
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
});

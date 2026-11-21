import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../extension/drag-download.js', import.meta.url), 'utf8');
const url = 'https://example.test/sticker.gif';
const sticker = { localName: 'img', currentSrc: url };
const clip = {
  localName: 'video', currentSrc: 'https://example.test/clip.mp4', controls: true,
  getBoundingClientRect: () => ({ bottom: 180, height: 180 })
};

async function contentScript() {
  const listeners = new Map();
  const messages = [];
  let onStorage;
  let isCollapsed = true;
  class Element {}
  const target = Object.assign(new Element(), { localName: 'div', baseURI: 'https://example.test/' });
  vm.runInNewContext(source, {
    window: { addEventListener: (name, listener) => listeners.set(name, listener) },
    document: { getSelection: () => ({ isCollapsed }) },
    innerWidth: 800, innerHeight: 600, setTimeout: () => {},
    Element, URL, getComputedStyle: () => ({ backgroundImage: 'url("sticker.gif")' }),
    chrome: {
      storage: {
        local: { get: async defaults => defaults },
        onChanged: { addListener: listener => { onStorage = listener; } }
      },
      runtime: { sendMessage: message => { messages.push({ ...message }); return new Promise(() => {}); } }
    }
  });
  await Promise.resolve();
  function fire(name, properties = {}) {
    listeners.get(name)({
      isTrusted: true, isPrimary: true, pointerType: 'mouse',
      pointerId: 1, button: 0, buttons: 1, clientX: 20, clientY: 40,
      composedPath: () => [sticker],
      ...properties
    });
  }
  return {
    fire, messages, target,
    selectText: () => { isCollapsed = false; },
    disable: () => onStorage({ dragToDownload: { newValue: false } }, 'local')
  };
}

test('a native drag downloads once after release, not when movement is sideways or too short', async () => {
  const { fire, messages } = await contentScript();
  for (const [clientX, clientY] of [[90, 110], [20, 90], [20, 110]]) {
    fire('pointerdown');
    fire('dragstart');
    fire('pointercancel');
    fire('dragend', { clientX, clientY });
    fire('pointerup', { clientX, clientY });
  }
  assert.deepEqual(messages, [{ action: 'download-drag', url, type: 'image' }]);
});

test('video pointer drags work without intercepting clicks or seeks; synthetic events cannot download', async () => {
  const { fire, messages } = await contentScript();
  const composedPath = () => [clip];
  fire('pointerdown', { composedPath });
  fire('pointerup', { composedPath });
  fire('pointerdown', { composedPath, clientY: 160 });
  fire('pointermove', { clientY: 240 });
  fire('pointerup', { clientY: 240 });
  fire('pointerdown', { isTrusted: false, composedPath });
  fire('pointermove', { clientY: 120 });
  fire('pointerup', { clientY: 120 });
  assert.equal(messages.length, 0);
  fire('pointerdown', { composedPath });
  fire('pointermove', { clientY: 120 });
  fire('pointerup', { clientY: 120 });
  assert.deepEqual(messages, [{ action: 'download-drag', url: clip.currentSrc, type: 'video' }]);
});

test('a background-image drag ignores selected text, and disabling the setting cancels a gesture', async () => {
  const { fire, messages, target, selectText, disable } = await contentScript();
  const composedPath = () => [target];
  fire('pointerdown', { composedPath });
  fire('pointermove', { clientY: 120 });
  fire('pointerup', { clientY: 120 });
  fire('pointerdown', { composedPath });
  selectText();
  fire('pointermove', { clientY: 120 });
  fire('pointerup', { clientY: 120 });
  fire('pointerdown');
  fire('dragstart');
  disable();
  fire('dragend', { clientY: 120 });
  assert.deepEqual(messages, [{ action: 'download-drag', url, type: 'image' }]);
});

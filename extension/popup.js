import { scanPage } from './scan.js';

const type = document.querySelector('#type');
const size = document.querySelector('#size');
const result = document.querySelector('#result');
const notice = document.querySelector('#notice');
const feedback = document.querySelector('#feedback');
const grid = document.querySelector('#grid');
const rescan = document.querySelector('#rescan');
const selectAll = document.querySelector('#select-all');
const count = document.querySelector('#count');
const download = document.querySelector('#download');

const selected = new Set();
let items = [];
let visible = [];
let scanning = false;
let downloading = false;

function setFeedback(text) {
  feedback.textContent = text;
  feedback.hidden = !text;
}

function updateSelection() {
  const checked = visible.filter(item => selected.has(item)).length;
  for (const [index, input] of [...grid.querySelectorAll('input')].entries()) {
    input.checked = selected.has(visible[index]);
  }
  selectAll.disabled = !visible.length;
  selectAll.checked = visible.length > 0 && checked === visible.length;
  selectAll.indeterminate = checked > 0 && checked < visible.length;
  count.textContent = `已选 ${checked} 项`;
  download.disabled = !checked || downloading;
}

function makeCard(item) {
  const label = document.createElement('label');
  label.className = 'card';
  const name = item.type === 'video' ? '视频' : '图片';
  const preview = document.createElement('span');
  preview.className = 'preview';
  const placeholder = document.createElement('span');
  placeholder.textContent = item.type === 'video' ? '视频文件' : '无预览';
  preview.append(placeholder);
  const thumbnail = item.type === 'image' ? item.url : item.poster;
  if (thumbnail) {
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('load', () => { img.classList.add('ready'); }, { once: true });
    img.src = thumbnail;
    preview.append(img);
  }
  const info = document.createElement('span');
  info.className = 'info';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.setAttribute('aria-label', `选择${name}`);
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) selected.add(item);
    else selected.delete(item);
    updateSelection();
  });
  const dimensions = item.width && item.height ? `${item.width} × ${item.height}` : '尺寸未知';
  info.append(checkbox, name + ' · ' + dimensions);
  label.append(preview, info);
  return label;
}

function render() {
  const min = Number(size.value);
  visible = items.filter(item =>
    (type.value === 'all' || item.type === type.value)
    && Math.min(item.width, item.height) >= min
  );
  const cards = document.createDocumentFragment();
  for (const item of visible) cards.append(makeCard(item));
  grid.replaceChildren(cards);
  updateSelection();
  if (!scanning) {
    result.textContent = visible.length ? `找到 ${visible.length} 项可下载的内容`
      : items.length ? '没有符合筛选条件的内容。'
      : '没找到可下载的图片或视频。可以先在网页上往下滚动，再重新扫描。';
  }
}

async function scan() {
  scanning = true;
  rescan.disabled = type.disabled = size.disabled = true;
  items = [];
  selected.clear();
  notice.hidden = true;
  setFeedback('');
  result.textContent = '正在查找网页里的图片和视频……';
  render();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error();
    if (await chrome.action.getBadgeText({ tabId: tab.id }) === '!') {
      setFeedback(await chrome.action.getTitle({ tabId: tab.id }));
      await chrome.action.setBadgeText({ tabId: tab.id, text: '' });
      await chrome.action.setTitle({ tabId: tab.id, title: chrome.runtime.getManifest().action.default_title });
    }
    const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scanPage });
    items = injection.result.items;
    notice.hidden = !injection.result.blockedVideo;
    scanning = false;
    render();
    type.disabled = size.disabled = false;
  } catch {
    items = [];
    result.textContent = '无法读取这个页面。请打开普通网页后重试；浏览器设置页等页面不能扫描。';
  } finally {
    scanning = false;
    rescan.disabled = false;
  }
}

type.addEventListener('change', render);
size.addEventListener('change', render);
rescan.addEventListener('click', scan);
selectAll.addEventListener('change', () => {
  for (const item of visible) {
    if (selectAll.checked) selected.add(item);
    else selected.delete(item);
  }
  updateSelection();
});
download.addEventListener('click', async () => {
  const chosen = visible.filter(item => selected.has(item)).map(({ url, type }) => ({ url, type }));
  downloading = true;
  updateSelection();
  setFeedback(`正在提交 ${chosen.length} 项下载。如果浏览器询问保存位置，请按提示保存。`);
  try {
    const { started, failed } = await chrome.runtime.sendMessage({ action: 'download-batch', items: chosen });
    const summary = started ? `已开始下载 ${started} 项。${failed ? `另有 ${failed} 项未能开始。` : ''}`
      : '没有文件开始下载。';
    setFeedback(`${summary}在浏览器菜单里点“下载”可查看进度。`);
  } catch {
    setFeedback('无法确认下载是否开始。请先在浏览器菜单里点“下载”查看，再决定是否重试。');
  } finally {
    downloading = false;
    updateSelection();
  }
});

scan();

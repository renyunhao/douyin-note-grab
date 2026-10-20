const $ = (id) => document.getElementById(id);
const els = {
  keyword: $('keyword'),
  count: $('count'),
  sort: $('sort'),
  template: $('template'),
  preview: $('preview'),
  append: $('append'),
  cacheInfo: $('cacheInfo'),
  status: $('status'),
  logs: $('logs'),
  list: $('list'),
};

let snapshot = { items: [], logs: [], logDropped: 0, status: 'idle', collected: 0, total: 0, count: 0, keyword: '', cache: null };
let renderedLogs = 0;
let renderedDropped = -1;
let templateReady = false;
let previewTimer = null;

function send(type, extra = {}) {
  return new Promise((resolve) => chrome.runtime.sendMessage({ type, ...extra }, resolve));
}

async function updatePreview() {
  const p = await send('panel:preview', { template: els.template.value });
  els.preview.textContent = p?.names?.length
    ? `预览（内置示例笔记）：${p.names.join('　')}`
    : '预览：—';
}

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    chrome.storage.local.set({ nameTemplate: els.template.value });
    updatePreview();
  }, 250);
}

const notice = (msg) => send('dyg:log', { msg });

function atBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}

function renderLogs() {
  const { logs, logDropped = 0 } = snapshot;
  if (logDropped !== renderedDropped || logs.length < renderedLogs) {
    els.logs.innerHTML = '';
    renderedLogs = 0;
    renderedDropped = logDropped;
  }
  if (logs.length === renderedLogs) return;

  const stick = atBottom(els.logs);
  for (let i = renderedLogs; i < logs.length; i++) {
    const line = document.createElement('div');
    line.className = 'logline';
    line.textContent = logs[i];
    els.logs.appendChild(line);
  }
  renderedLogs = logs.length;
  if (stick) els.logs.scrollTop = els.logs.scrollHeight;
}

function renderList() {
  const items = snapshot.items;
  if (els.list.childElementCount === items.length) return;
  els.list.innerHTML = '';
  for (const n of items) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <img loading="lazy" referrerpolicy="no-referrer" src="${n.images[0]}" alt="" />
      <div class="meta">
        <div class="desc"></div>
        <div class="sub"></div>
        <a class="link" target="_blank" rel="noreferrer">打开笔记</a>
      </div>`;
    card.querySelector('.desc').textContent = n.desc || '(无标题)';
    card.querySelector('.sub').textContent = `${n.author} · ${n.images.length} 图`;
    card.querySelector('a').href = n.page_url;
    card.querySelector('img').onerror = (e) => (e.target.style.opacity = 0.15);
    els.list.appendChild(card);
  }
}

function render() {
  const s = snapshot;
  const label = { idle: '空闲', running: '收集中', done: '已完成', error: '出错' }[s.status] ?? s.status;
  const mode = s.append ? '追加' : '覆盖';
  els.status.textContent = `${label}　${s.keyword ? `「${s.keyword}」${mode}` : ''}　本次 ${s.collected}/${s.count}　库内 ${s.total}`;
  els.status.className = `status ${s.status}`;
  if (s.cache) {
    els.cacheInfo.textContent = `已收集 ${s.cache.seenCount} 条笔记　最近收集 ${s.cache.seenLatest}`;
  }
  renderLogs();
  renderList();
}

async function poll() {
  const next = await send('panel:state');
  if (next) snapshot = next;
  if (!templateReady) {
    templateReady = true;
    if (!els.template.value && snapshot.defaultTemplate) els.template.value = snapshot.defaultTemplate;
  }
  render();
}

$('start').onclick = () => {
  const keyword = els.keyword.value.trim();
  if (!keyword) return alert('请填写关键词');
  send('panel:start', {
    cfg: {
      keyword,
      count: Math.max(1, Number(els.count.value) || 20),
      sort: els.sort.value,
      append: els.append.checked,
    },
  });
};
$('stop').onclick = () => send('panel:stop');

let clearArmed = 0;
$('clearCache').onclick = async () => {
  const now = Date.now();
  if (now - clearArmed > 6000) {
    clearArmed = now;
    $('clearCache').textContent = '确认清空？再点一次';
    notice('再次点击将清空「已收集笔记」缓存，清空后重复的图文会被重新收集。');
    setTimeout(() => {
      if (Date.now() - clearArmed >= 6000) $('clearCache').textContent = '清空缓存';
    }, 6500);
    return;
  }
  clearArmed = 0;
  $('clearCache').textContent = '清空缓存';
  await send('panel:cacheClear', { scope: 'all' });
  poll();
};
$('clear').onclick = async () => {
  await send('panel:clear');
  renderedLogs = 0;
  renderedDropped = -1;
  poll();
};
$('export').onclick = async () => {
  const notes = snapshot.items;
  if (!notes.length) return alert('还没有数据');
  const payload = { keyword: snapshot.keyword, exported_at: new Date().toISOString(), notes };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  await send('panel:export', { blobUrl: url });
};
$('download').onclick = async () => {
  if (!snapshot.items.length) return alert('还没有数据');
  const r = await send('panel:download', { maxImages: 2000, template: els.template.value });
  if (r?.queued) notice(`已排入下载队列 ${r.queued} 张`);
};
els.template.addEventListener('input', schedulePreview);
$('resetTemplate').onclick = () => {
  els.template.value = snapshot.defaultTemplate ?? '';
  schedulePreview();
};
$('copy').onclick = async () => {
  const urls = snapshot.items.flatMap((n) => n.images);
  if (!urls.length) return alert('还没有数据');
  await navigator.clipboard.writeText(urls.join('\n'));
  notice(`已复制 ${urls.length} 条图片 URL`);
};

chrome.storage.local.get('nameTemplate').then(({ nameTemplate }) => {
  if (nameTemplate) els.template.value = nameTemplate;
  updatePreview();
});

poll();
setInterval(poll, 1200);

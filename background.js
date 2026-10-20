const SEARCH_HOST = 'https://www.douyin.com/';
const SEEN_CAP = 5000;

const job = {
  keyword: '',
  count: 0,
  sort: '综合排序',
  append: true,
  status: 'idle',
  tabId: null,
  runBase: 0,
  logs: [],
  items: {},
  order: [],
  hasMore: null,
};

const cache = {
  seen: {},
};

async function persist() {
  await chrome.storage.session.set({ job });
}

async function restore() {
  const { job: saved } = await chrome.storage.session.get('job');
  if (saved) Object.assign(job, saved);
}

let cacheTimer = null;
function flushCache() {
  clearTimeout(cacheTimer);
  cacheTimer = setTimeout(() => chrome.storage.local.set({ seen: cache.seen }), 800);
}

async function loadCache() {
  const { seen } = await chrome.storage.local.get('seen');
  cache.seen = seen ?? {};
}

function rememberSeen(id) {
  cache.seen[id] = Date.now();
  const ids = Object.keys(cache.seen);
  if (ids.length > SEEN_CAP) {
    for (const old of ids.sort((a, b) => cache.seen[a] - cache.seen[b]).slice(0, ids.length - SEEN_CAP)) {
      delete cache.seen[old];
    }
  }
  flushCache();
}

function addLog(msg) {
  job.logs.push(`${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${msg}`);
  while (job.logs.length > 200) {
    job.logs.shift();
    job.logDropped = (job.logDropped ?? 0) + 1;
  }
}

const noteCount = () => job.order.length;
const collectedThisRun = () => noteCount() - job.runBase;

function dl(opts) {
  return new Promise((resolve) => {
    chrome.downloads.download(opts, (id) => {
      const err = chrome.runtime.lastError?.message;
      resolve(err ? { ok: false, error: err } : { ok: true, id });
    });
  });
}

let failedLogged = 0;
chrome.downloads.onChanged.addListener((d) => {
  const err = d.error?.current;
  if (err && failedLogged < 5) {
    failedLogged++;
    addLog(`下载失败（id=${d.id}）：${err}`);
    persist();
  }
});

async function ensureRefererRule() {
  if (!chrome.declarativeNetRequest?.updateSessionRules) return;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [1],
    addRules: [
      {
        id: 1,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{ header: 'referer', operation: 'set', value: 'https://www.douyin.com/' }],
        },
        condition: {
          urlFilter: '||douyinpic.com',
          resourceTypes: ['image', 'xmlhttprequest', 'other'],
        },
      },
    ],
  });
}

async function findDouyinTab() {
  const tabs = await chrome.tabs.query({ url: 'https://www.douyin.com/*' });
  return tabs[0] ?? null;
}

async function waitReady(tabId, timeoutMs = 40000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'dyg:ping' });
      if (res?.ok) return res;
    } catch {}
    await new Promise((r) => setTimeout(r, 800));
  }
  return null;
}

async function startRun(cfg) {
  Object.assign(job, {
    keyword: cfg.keyword,
    count: cfg.count,
    sort: cfg.sort,
    append: cfg.append !== false,
    status: 'running',
    hasMore: null,
  });

  if (job.append) {
    job.runBase = noteCount();
    addLog(`任务开始（追加模式）：关键词「${cfg.keyword}」，本次再收 ${cfg.count} 条，库里已有 ${noteCount()} 条`);
  } else {
    job.runBase = 0;
    Object.assign(job, { logs: [], logDropped: 0, items: {}, order: [] });
    addLog(`任务开始（覆盖模式）：关键词「${cfg.keyword}」，目标 ${cfg.count} 条图文，已清空本次列表`);
  }

  let tab = await findDouyinTab();
  const url = `${SEARCH_HOST}search/${encodeURIComponent(cfg.keyword)}?type=general`;
  if (!tab) {
    tab = await chrome.tabs.create({ url, active: true });
    addLog('已新开抖音标签页');
  } else {
    await chrome.tabs.update(tab.id, { url, active: true });
    addLog(`已在标签页 ${tab.id} 内跳转搜索页`);
  }
  job.tabId = tab.id;
  await persist();

  await new Promise((r) => setTimeout(r, 1500));
  await chrome.tabs
    .get(tab.id)
    .then((t) => (t.status === 'complete' ? null : new Promise((res) => {
      const listener = (id, change) => {
        if (id === tab.id && change.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          res();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        res();
      }, 30000);
    })));

  const ready = await waitReady(tab.id);
  if (!ready) {
    job.status = 'error';
    addLog('内容脚本未响应，请刷新抖音页面后重试（或确认已登录）。');
    await persist();
    return;
  }
  addLog(`页面就绪（MAIN 注入：${ready.mainSeen ? '成功' : '未确认，任务里会再握手'}）`);
  await persist();
  chrome.tabs.sendMessage(tab.id, { type: 'dyg:run', cfg }).catch((e) => {
    job.status = 'error';
    addLog(`启动收集失败: ${e.message}`);
    persist();
  });
}

async function ingest(notes) {
  let added = 0;
  let dupInRun = 0;
  let dupInCache = 0;
  for (const n of notes) {
    if (collectedThisRun() >= job.count) break;
    const id = n?.aweme_id;
    if (!id) continue;
    if (job.items[id]) {
      dupInRun++;
      continue;
    }
    if (cache.seen[id]) {
      dupInCache++;
      continue;
    }
    job.items[id] = n;
    job.order.push(id);
    rememberSeen(id);
    added++;
  }
  if (added || dupInRun || dupInCache) {
    const dupText = dupInCache ? `，跳过已收集 ${dupInCache} 条` : dupInRun ? `，跳过本次已有 ${dupInRun} 条` : '';
    addLog(`本批 ${notes.length} 条 → 新增 ${added}${dupText}；本次 ${collectedThisRun()}/${job.count}，库内 ${noteCount()} 条`);
    await persist();
  }
  if (collectedThisRun() >= job.count && job.status === 'running') {
    await chrome.tabs.sendMessage(job.tabId, { type: 'dyg:stop' }).catch(() => {});
    job.status = 'done';
    addLog('本次目标已达成，停止滚动。');
    await persist();
  }
}

function cacheInfo() {
  const seenTs = Object.values(cache.seen);
  return {
    seenCount: seenTs.length,
    seenLatest: seenTs.length ? new Date(Math.max(...seenTs)).toLocaleString('zh-CN', { hour12: false }) : '—',
  };
}

function imageJobs(layout) {
  const flat = layout === 'flat';
  const list = [];
  for (const id of job.order) {
    const note = job.items[id];
    for (let i = 0; i < note.images.length; i++) {
      list.push({
        url: note.images[i],
        name: flat ? `dy-${id}_${i + 1}.jpg` : `douyin-grab/${id}/${i + 1}.jpg`,
      });
    }
  }
  return list;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const t = msg?.type;

  if (t === 'dyg:log') {
    addLog(msg.msg);
    persist();
    sendResponse({ ok: true });
    return;
  }
  if (t === 'dyg:count') {
    sendResponse({ count: collectedThisRun() });
    return;
  }
  if (t === 'dyg:notes') {
    if (job.status !== 'running') {
      sendResponse({ ok: true, ignored: true });
      return;
    }
    job.hasMore = msg.payload.has_more ?? job.hasMore;
    if (msg.payload.notes?.length) addLog(`[响应] ${msg.payload.summary}`);
    ingest(msg.payload.notes ?? []);
    sendResponse({ ok: true });
    return;
  }
  if (t === 'dyg:done') {
    if (job.status === 'running') job.status = 'done';
    addLog(`任务结束：本次新增 ${collectedThisRun()} 条，库内共 ${noteCount()} 条。`);
    persist();
    sendResponse({ ok: true });
    return;
  }

  if (t === 'panel:start') {
    (async () => {
      await restore();
      await startRun(msg.cfg);
    })();
    sendResponse({ ok: true });
    return;
  }
  if (t === 'panel:stop') {
    chrome.tabs.sendMessage(job.tabId, { type: 'dyg:stop' }).catch(() => {});
    job.status = 'idle';
    addLog('手动停止。');
    persist();
    sendResponse({ ok: true });
    return;
  }
  if (t === 'panel:state') {
    sendResponse({
      status: job.status,
      keyword: job.keyword,
      count: job.count,
      append: job.append,
      collected: collectedThisRun(),
      total: noteCount(),
      logs: job.logs.slice(),
      logDropped: job.logDropped ?? 0,
      items: job.order.map((id) => job.items[id]),
      cache: cacheInfo(),
    });
    return;
  }
  if (t === 'panel:clear') {
    Object.assign(job, { status: 'idle', logs: [], logDropped: 0, items: {}, order: [], runBase: 0, keyword: '', count: 0 });
    persist();
    sendResponse({ ok: true });
    return;
  }
  if (t === 'panel:cache') {
    sendResponse(cacheInfo());
    return;
  }
  if (t === 'panel:cacheClear') {
    cache.seen = {};
    chrome.storage.local.set({ seen: {} });
    addLog('缓存已清空（已收集笔记）');
    persist();
    sendResponse({ ok: true, cache: cacheInfo() });
    return;
  }
  if (t === 'panel:export') {
    const name = `douyin-grab/${(job.keyword || 'notes').replace(/[\\/:*?"<>|]/g, '_')}-${Date.now()}.json`;
    if (!msg.blobUrl) {
      sendResponse({ ok: false, error: 'no blob url' });
      return;
    }
    dl({ url: msg.blobUrl, filename: name, saveAs: false }).then((r) => {
      addLog(r.ok ? `已导出 ${job.order.length} 条 JSON → ${name}` : `导出失败：${r.error}`);
      persist();
    });
    sendResponse({ ok: true });
    return;
  }
  if (t === 'panel:download') {
    const maxImages = msg.maxImages ?? 2000;
    const slice = imageJobs(msg.layout).slice(0, maxImages);
    addLog(`开始下载 ${slice.length} 张（${msg.layout === 'flat' ? '平铺' : '分目录'}）`);
    persist();
    (async () => {
      await ensureRefererRule();
      let ok = 0;
      let firstError = null;
      for (const it of slice) {
        const r = await dl({ url: it.url, filename: it.name, conflictAction: 'uniquify', saveAs: false });
        if (r.ok) ok++;
        else if (!firstError) firstError = r.error;
        await new Promise((r2) => setTimeout(r2, 120));
      }
      addLog(`下载队列已提交：成功 ${ok}/${slice.length}${firstError ? `，首个错误：${firstError}` : ''}`);
      failedLogged = 0;
      persist();
    })();
    sendResponse({ ok: true, queued: slice.length });
    return;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  loadCache();
  restore();
});

loadCache();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);

let stopRequested = false;
let batches = [];
let mainSeen = false;

const log = (msg) => chrome.runtime.sendMessage({ type: 'dyg:log', msg }).catch(() => {});

function helloMain() {
  window.postMessage({ source: 'dyg-cmd', kind: 'hello' }, location.origin);
}

window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.source !== 'dyg-capture') return;
  mainSeen = true;
  if (d.kind === 'diag') {
    log(`[注入] ${d.msg}`);
    return;
  }
  batches.push(d);
  chrome.runtime
    .sendMessage({
      type: 'dyg:notes',
      payload: { notes: d.notes, has_more: d.has_more, summary: `${d.endpoint} 卡片${d.cards} 图文${d.notes.length} 类型${JSON.stringify(d.types)}` },
    })
    .catch(() => {});
});

function visible(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function deepestByText(text) {
  const all = [...document.querySelectorAll('*')].filter(
    (e) => (e.textContent ?? '').trim() === text && visible(e)
  );
  return all.filter((e) => ![...e.children].some((c) => (c.textContent ?? '').trim() === text));
}

function clickEl(el) {
  el.scrollIntoView({ block: 'center' });
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }
}

async function clickText(text, { within } = {}) {
  let nodes = deepestByText(text);
  if (within) {
    const inside = nodes.filter((n) => within.contains(n));
    if (inside.length) nodes = inside;
  }
  const el = nodes[nodes.length - 1];
  if (!el) return null;
  clickEl(el);
  return el;
}

function sectionBox(label) {
  const head = deepestByText(label).pop();
  if (!head) return null;
  let box = head.parentElement;
  for (let i = 0; i < 7 && box; i++) {
    if (/图文/.test(box.textContent) && /不限/.test(box.textContent)) return box;
    box = box.parentElement;
  }
  return null;
}

let cachedScroller = null;

async function scrollStep() {
  const before = window.scrollY;
  window.scrollBy(0, Math.round(window.innerHeight * 0.85));
  await sleep(400);
  if (window.scrollY !== before) return 'window';

  if (!cachedScroller) {
    cachedScroller =
      [...document.querySelectorAll('div,main,section')]
        .filter((e) => e.scrollHeight > e.clientHeight + 400 && visible(e))
        .sort((a, b) => b.scrollHeight - a.scrollHeight)[0] ?? null;
  }
  if (cachedScroller) {
    cachedScroller.scrollTop += Math.round(cachedScroller.clientHeight * 0.85);
    return `容器 ${(cachedScroller.className || '').toString().slice(0, 40)}`;
  }
  return '未找到可滚动区域';
}

async function notesSoFar() {
  return new Promise((resolve) => chrome.runtime.sendMessage({ type: 'dyg:count' }, (r) => resolve(r?.count ?? 0)));
}

async function applyFilterAndWait() {
  const trigger = deepestByText('筛选');
  log(`自检：匹配到「筛选」${trigger.length} 个，「图文」${deepestByText('图文').length} 个`);
  if (!trigger.length) {
    log('没匹配到「筛选」按钮。请你在页面右上角手动点 筛选 → 内容形式 → 图文，我最多等 90 秒。');
  } else {
    clickEl(trigger[trigger.length - 1]);
    await sleep(rnd(800, 1200));
    const box = sectionBox('内容形式');
    const hit = await clickText('图文', { within: box ?? undefined });
    log(hit ? '已点击「内容形式 → 图文」' : '面板里没匹配到「图文」，请手动点一下，我最多等 90 秒。');

    if (cfg.sort && cfg.sort !== '综合排序') {
      await sleep(rnd(500, 900));
      const sortBox = sectionBox('排序依据');
      const sortHit = await clickText(cfg.sort, { within: sortBox ?? undefined });
      log(sortHit ? `已点击「排序依据 → ${cfg.sort}」` : `面板里没匹配到「${cfg.sort}」，按默认排序继续`);
    }
  }

  const mark = batches.length;
  const end = Date.now() + 90000;
  const describe = (b) => `${b.endpoint} 卡片${b.cards} 图文${b.notes.length} 类型${JSON.stringify(b.types)}`;
  while (Date.now() < end) {
    await sleep(1500);
    for (const b of batches.slice(mark)) {
      if (b.notes.length) {
        log(`检测到图文结果（${describe(b)}），开始滚动收集`);
        return true;
      }
    }
    if (batches.slice(mark).some((b) => b.cards > 0)) {
      await sleep(1500);
      const latest = batches[batches.length - 1];
      if (latest?.notes.length) {
        log(`检测到图文结果（${describe(latest)}），开始滚动收集`);
        return true;
      }
    }
  }
  log('90 秒内没等到图文结果，仍尝试滚动收集。');
  return false;
}

async function runLoop(cfg) {
  batches = [];
  stopRequested = false;
  helloMain();
  await sleep(1200);
  if (!mainSeen) {
    log('MAIN 世界脚本没有响应，无法截获接口数据。请在 edge://extensions 重新加载本扩展后刷新抖音页面。');
    chrome.runtime.sendMessage({ type: 'dyg:done', count: 0 }).catch(() => {});
    return;
  }
  await applyFilterAndWait();

  let idle = 0;
  let last = await notesSoFar();
  for (let step = 0; step < 80 && !stopRequested; step++) {
    const how = await scrollStep();
    await sleep(rnd(1400, 2600));
    const now = await notesSoFar();
    if (now >= cfg.count) {
      log(`已收集 ${now} 条，达到目标。`);
      break;
    }
    idle = now === last ? idle + 1 : 0;
    last = now;
    if (idle >= 8) {
      log(`连续 8 次滚动无新增（滚动方式：${how}），停止。当前 ${now} 条。`);
      break;
    }
    if (step % 5 === 4) log(`滚动 ${step + 1} 次（${how}），已收集 ${now}/${cfg.count}`);
  }
  chrome.runtime.sendMessage({ type: 'dyg:done', count: await notesSoFar() }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'dyg:ping') {
    sendResponse({ ok: true, href: location.href, mainSeen });
    return;
  }
  if (msg?.type === 'dyg:run') {
    sendResponse({ ok: true });
    runLoop(msg.cfg);
    return;
  }
  if (msg?.type === 'dyg:stop') {
    stopRequested = true;
    sendResponse({ ok: true });
    return;
  }
});

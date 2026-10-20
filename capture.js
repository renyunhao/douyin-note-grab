(() => {
  if (window.__dygCaptureInstalled) return;
  window.__dygCaptureInstalled = true;

  window.addEventListener('message', (e) => {
    if (e.data?.source === 'dyg-cmd' && e.data?.kind === 'hello') {
      window.postMessage({ source: 'dyg-capture', kind: 'diag', msg: 'MAIN 握手成功' }, location.origin);
    }
  });

  const pick = (list) => (Array.isArray(list) && list.length ? list : []);

  function extractNote(aweme) {
    const imgs = aweme.images;
    if (!Array.isArray(imgs) || !imgs.length) return null;
    const groups = imgs.map((im) => pick(im.url_list)).filter((urls) => urls.length);
    if (!groups.length) return null;
    return {
      aweme_id: aweme.aweme_id,
      aweme_type: aweme.aweme_type,
      desc: aweme.desc || '',
      author: aweme.author?.nickname || aweme.author?.unique_id || '',
      author_uid: aweme.author?.unique_id || '',
      create_time: aweme.create_time || null,
      digg: aweme.statistics?.digg_count ?? null,
      page_url: `https://www.douyin.com/note/${aweme.aweme_id}`,
      images: groups.map((urls) => urls[0]),
      images_all: groups,
    };
  }

  function handle(url, text) {
    if (!text || text.length < 40) return;
    if (!/general\/search\/(single|stream)/.test(url)) return;
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      window.postMessage({ source: 'dyg-capture', kind: 'diag', msg: `响应无法解析 bytes=${text.length}` }, location.origin);
      return;
    }
    const notes = [];
    const types = {};
    for (const card of json.data ?? []) {
      const candidates = [card.aweme_info, ...(card.aweme_list ?? [])];
      for (const item of candidates) {
        const aweme = item?.aweme_info ?? item;
        if (!aweme?.aweme_id) continue;
        types[aweme.aweme_type] = (types[aweme.aweme_type] ?? 0) + 1;
        const note = extractNote(aweme);
        if (note) notes.push(note);
      }
    }
    window.postMessage(
      {
        source: 'dyg-capture',
        kind: 'batch',
        endpoint: /stream/.test(url) ? 'stream' : 'single',
        notes,
        types,
        cards: (json.data ?? []).length,
        has_more: json.has_more,
      },
      location.origin
    );
  }

  const nativeFetch = window.fetch;
  window.fetch = async (...args) => {
    const res = await nativeFetch(...args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url ?? '');
      if (/general\/search\/single/.test(url)) res.clone().text().then((t) => handle(url, t)).catch(() => {});
    } catch {}
    return res;
  };

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__dygUrl = String(url ?? '');
    return nativeOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', () => {
      try {
        handle(this.__dygUrl, this.responseText);
      } catch {}
    });
    return nativeSend.apply(this, args);
  };

  window.postMessage({ source: 'dyg-capture', kind: 'diag', msg: 'MAIN 注入成功' }, location.origin);
})();

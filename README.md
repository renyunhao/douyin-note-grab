# Douyin 图文取图

一个 Chrome / Edge 的 Manifest V3 扩展：按关键词搜索抖音「图文」笔记，收集笔记的原图 URL，导出 JSON 或批量下载图片。

在**你自己已登录的浏览器里手动点一次**运行，不是后台爬虫，也不需要额外起进程。

## 安装

1. 打开 `edge://extensions`（Chrome 是 `chrome://extensions`），开启「开发人员模式」。
2. 点「加载解压缩的扩展」，选择本仓库根目录（`manifest.json` 所在这一层）。
3. 先在浏览器里正常登录 [douyin.com](https://www.douyin.com)。

> 改了代码后要在扩展页点刷新 ↻，并刷新已打开的抖音标签页。

## 使用

点工具栏图标打开侧边栏，填关键词和数量，点「开始收集」。扩展会自动跳转搜索页、点开右上角「筛选 → 内容形式 → 图文」，然后边滚动边截获结果，达到数量即停。

| 控件 | 作用 |
| --- | --- |
| 关键词 / 数量 | `数量` 是**本次新增的硬上限**。抖音一次响应就有约 10 条，超出部分直接丢弃，不会多收 |
| 排序 | 对应筛选面板的「排序依据」：综合排序 / 最新发布 / 最多点赞。选「综合排序」时不点，保持默认 |
| 图片保存结构 | `分目录` → `douyin-grab/<笔记ID>/1.jpg`；`平铺` → 下载根目录下的 `dy-<笔记ID>_1.jpg` |
| 追加模式（默认开） | 开着：保留上次列表，`数量` 表示"再新增 N 条"。关掉：开始即清空列表 |
| 导出 JSON / 下载图片 / 复制图片 URL | 三个独立动作，都基于当前列表 |

## 去重与缓存

`chrome.storage.local` 里存一份**已收集笔记**的 `aweme_id → 时间戳`，跨任务、跨重启生效，上限 5000 条按最早写入淘汰。

- 命中缓存的条目会被跳过，日志写 `跳过已收集 X 条`，所以同关键词重复跑只会翻出新内容。
- 「已收集」是在**收集成功那一刻**记录的，不是下载成功才记。收了没下载就重跑会被当重复，此时点「清空缓存」（二次点击确认）。
- 下载不做判重：同一次任务连点两次「下载图片」会靠浏览器的 `uniquify` 产生 `(1)` 副本。

## 工作原理

- **取数不靠 DOM 类名**。`capture.js` 以 `world: "MAIN"` 注入页面，钩住 `fetch` / `XMLHttpRequest`，直接解析抖音自己发出的 `aweme/v1/web/general/search/single` 响应，从 `data[].aweme_info.images[].url_list` 取原图数组。图文的 `aweme_type` 是 `68`，视频是 `0` 且该字段为空，所以"只收图文"是数据层判定的结果。抖音改版换 class 名不影响取数。
- **交互靠文案匹配**。`content.js` 用元素文案找「筛选」「图文」「最新发布」等节点并派发鼠标事件。抖音改了 UI 文案时，改 `content.js` 里的字符串即可。
- **下载要带 Referer**。抖音图片 CDN 校验来源，下载前 `background.js` 会下一条 `declarativeNetRequest` session rule，把 `referer` 设为 `https://www.douyin.com/`。
- **导出 JSON 用 Blob URL**。`data:` URL 的下载会被 Edge 拦掉，所以 JSON 由侧边栏 `URL.createObjectURL(new Blob(...))` 生成再交给 downloads API。
- 任务状态放在 service worker 里，关掉侧边栏不影响正在跑的任务。

## 限制

- 图片 URL 带签名，**几小时后失效**，收集完尽快下载。
- 依赖已登录会话。抖音对异常行为会返回空结果或弹验证，需要人工在页面上过一次。
- 只在 `www.douyin.com` 的搜索页工作。
- 抓到的图片是他人创作内容，请自行确认使用边界。

## 文件

```
manifest.json     MV3 清单，声明 MAIN / ISOLATED 两个 content script
capture.js        MAIN world：钩 fetch/XHR，解析搜索响应里的图文数组
content.js        ISOLATED world：点筛选、滚动加载、转发数据
background.js     service worker：任务状态、去重缓存、下载、导出
sidepanel.*       侧边栏界面
```

## JSON 输出格式

```json
{
  "keyword": "收纳",
  "exported_at": "2026-10-20T04:00:00.000Z",
  "notes": [
    {
      "aweme_id": "7668522522060524854",
      "aweme_type": 68,
      "desc": "标题文本",
      "author": "作者昵称",
      "create_time": 1760000000,
      "digg": 1234,
      "page_url": "https://www.douyin.com/note/7668522522060524854",
      "images": ["https://p3-sign.douyinpic.com/..."],
      "images_all": [["原图多镜像地址", "..."]]
    }
  ]
}
```

`images` 是每张图的首选地址（下载用的就是它），`images_all` 保留每张图的全部镜像。

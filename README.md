# dsh-image-question

给 DSH Web 的**图片标注提问**插件：Agent 带图提问，用户在浏览器里看图、缩放平移、框选或画笔标注、判定 NG/OK/不确定、写说明；Agent 拿回的是**原图坐标系**下的结构化结果。

> Ask with an image, annotate in the browser, get back structured source-pixel coordinates.
> Zero peer dependencies. No build step. Both halves are hand-written artifacts.

## 界面截图

![实际界面](ScreenShot.png)

---

## 1. 它解决什么

Agent 判断不了的事情里，有很大一类必须由人看图：截图取图失败要确认、检测结果要判 NG/OK、UI 细节要指出位置。官方 `ask_user_question` 只能传文字，位置与范围说不清楚；把图丢进对话，用户回来也只能用「左上角那个」「大概中间」描述。

本插件注册一个工具 `ask_user_question_image`：Agent 给出**本地图片文件路径**，Host 读取并作为附件入库，浏览器端接管提问卡片渲染出标注界面，用户在图**原图坐标系**上标注并提交，Agent 收到与缩放、平移、窗口尺寸、设备像素比**无关**的坐标。

## 2. 用户侧能做什么

| 能力 | 说明 |
|---|---|
| 看图 | 滚轮缩放、拖拽平移、三档缩放按钮 |
| 框选 | `rect`，拖出矩形区域 |
| 画笔 | `brush`，按住连续画；单击落点进入套索模式，双击或右键闭合 |
| 笔刷大小 | 选中「画笔」时其右侧出现滑动条（4–160，默认 28），单位是**屏幕上覆盖的宽度**；缩放视图不会改变手感，落笔时按当前缩放换算成原图像素 |
| 重画 | 清空当前题的所有标注 |
| 撤销 | 逐步回退，每一步都可回退 |
| 调色 | 4 色调色板，默认 `#fa0202` |
| 判定 | NG / OK / 不确定 |
| 说明 | 自由文本，上限 200 字 |
| 提交 | 整批一次提交，结果按 `id` 回传 |

## 3. 工具契约

工具名 `ask_user_question_image`，零 peer 依赖，注册时提交原始 JSON-Schema。

入参：

```jsonc
{
  "questions": [{
    "id": "q1",                          // 必填，回传时原样带回
    "question": "这张图算 NG 吗？",        // 必填
    "source_image": "D:/path/to/a.png",  // 必填，绝对路径；路径本身不上 wire
    "header": "NG 标注",                  // 可选，卡片短标题
    "detail": "补充说明文字",              // 可选
    "sentinel": "PROBE-42"               // 可选，端到端关联用的不透明回环令牌
  }],
  "timeout_ms": 600000,                  // 可选，默认 10 分钟
  "mask": {                              // 可选：提交后把标注落成蒙版 PNG
    "out_dir": "D:/masks/",              // 必填，绝对路径，缺失则递归创建
    "name": "hero",                      // 可选，文件名主干，默认用题目 id
    "shape": "gray",                     // gray（默认）| alpha | both
    "grow_px": 0                         // 可选，边界外扩像素数
  }
}
```

约束：一道题**恰好一张图**；`source_image` 支持 `.png` / `.jpg` / `.jpeg` / `.webp` / `.gif`；整批一次提交。

`mask` 是 2026-10-11 加的：以前标注回给模型就结束了，要去跑图还得手工把坐标转成一张 mask 图。
现在把它写进请求，回答到手的同时磁盘上就有了蒙版，返回值里带路径。尺寸按**原图**算（坐标本来就是原图坐标），
所以蒙版和用户点名的那张文件天然对齐。

`shape` 默认 `gray` —— 只写一个文件。这既是最常用的那种（ComfyUI 的 `LoadImageMask(channel="red")`
直接吃它），也避免同一个区域在磁盘上留下两张**数值相反**的图给人拿错：

| shape | 文件 | 通道 | 约定 | 给谁用 |
|---|---|---|---|---|
| `gray`（默认） | `<stem>-mask.png` | 单通道灰度 | **白 255 = 要改** | `LoadImageMask(channel="red")`、`ImageToMask`、`MaskComposite` |
| `alpha` | `<stem>-alpha.png` | RGBA | **透明 = 要改** | 走 alpha 的入口（`LoadImage` 取 alpha 再反转） |
| `both` | 两个都写 | | | 明确知道下游两种都要时 |

`alpha` 版只保证 alpha 通道正确，RGB 是占位白 —— 插件零依赖、不做图像解码，所以没有原图像素可填。
`grow_px` 加在**几何**上（矩形四边外扩、笔迹线宽加粗），不是事后膨胀：笔迹回来时的线宽是源像素 2px，
细得像根线，想让它代表一片区域就靠这个。

返回：

```jsonc
{
  "answers": [{
    "id": "q1",
    "selected": ["NG"],
    "mode": "annotated",                 // 或 "generic-fallback"
    "verdict": "ng",                     // ng | ok | unsure
    "note": "色差超标",
    "annotations": [ /* 原图像素坐标下的矩形与笔迹 */ ],
    "image": { "width": 4000, "height": 4000 },
    "source_path": "D:/path/to/a.png",   // 仅回给模型，不上 wire
    "raw_custom": "{...}",
    "mask": {                            // 仅当请求带了 mask 且这一题有标注
      "width": 4000, "height": 4000,
      "mask_path": "D:/masks/hero-mask.png",
      "alpha_path": "D:/masks/hero-alpha.png",
      "covered_pixels": 920322,
      "grow_px": 0
    },
    "mask_error": { /* 落盘失败的原因；答案本身照样有效 */ }
  }]
}
```

写蒙版失败**不会**作废答案：人的活儿已经干完了，所以失败按 `mask_error` 记在该题上，工具调用照常成功。
这一条和下面那些失败码是同一个原则 —— 失败是数据，不是中断。

失败一律作为**数据**返回，不是中断的工具调用：`CALLER_NOT_LIVE`、`EMPTY_QUESTIONS`、`IMAGE_ANNOTATION_BUSY`、`UNSUPPORTED_MEDIA_TYPE`、`IMAGE_READ_FAILED`、`IMAGE_ADMISSION_FAILED`，超时则返回超时错误。

坐标系声明为 `source-oriented-pixel-edge`，原点左上、x 向右、y 向下，尺寸取**原图**尺寸（`originalDimensions ?? width`）。

## 4. 安装

```bash
# 在 profile 清单里加两处（~/.dsh/profiles/<profile>/package.json）
#   dependencies:      "dsh-image-question": "link:/abs/path/to/dsh-image-question/plugin"
#   dsh.profile.bundles: 追加 "dsh-image-question"
cd ~/.dsh/profiles/<profile> && pnpm install
dsh --profile <profile> --host 127.0.0.1 --port 3101 --no-open
```

`plugin/package.json` 自带 `dsh.bundle` 与 `dsh.client` manifest，`cordis.patch.yml` 随插件一起生效，不需要额外传 `--patch`。

开发期叠加（`dsh --profile <profile> --patch dev/patch.yml`）与正式安装**互斥**：两者同时存在会让同一插件被注册两次，启动直接失败（`resolves from multiple active Loader sources`）。要用 overlay 就先卸掉 profile 里那两行。

改代码怎么生效：两个半边都是手写产物、**没有构建步骤**，但 Host 会快照 bundle 字节，所以 `plugin/lib/index.js`、`plugin/client.js`、`plugin/cordis.patch.yml` 的改动都靠**重启**生效。

## 5. 实现要点

Host 半边只做三件事：注册工具、把图片经 `ctx.attachments.saveImage()` 入库并签发**每图一个的不透明能力令牌**、通过只读 Fetch 路由 `/api/image-question.view` 按令牌发字节。经 `saveImage()` 入库的附件不进会话事件流，官方会话授权图片路由服务不了它（会报 `ATTACHMENT_NOT_REFERENCED`），这正是自建只读路由的原因。

令牌表只是叠在既有附件库上的**授权映射**：提问前签发、按同一引用读回、结算即撤销。它不是第二个图库、不是上传端点、不是文件缓存、不是归一化管线，也从不接受文件系统路径。未知、过期、已撤销的令牌一律返回相同的 404，不泄漏是哪一种。

并发：同一个 Agent 同时只允许一个未答的图片提问，第二次调用在读取任何文件之前就被拒绝（`IMAGE_ANNOTATION_BUSY`），因此被拒的调用不留孤儿附件、不留无人回答的卡片。不同 Agent 互不干扰，父 Agent 与子 Agent 可各问各的。

`cordis.patch.yml` 把 `attachment-local` 行的保真上限抬到 4096×4096（`normalizedImageMaxPixels` / `normalizedImageMaxBytes` → 16777216，`normalizedImageMaxDimension` → 8192），这样 4000×4000 的源图不被降采样、可按原尺寸读取；它只改该行的 `config`，不编辑任何官方文件。

Client 半边是一个 bundle 注册两个 id（`dsh-image-question` 与 `dsh-image-question/logic`），用 `priority: -100` 接管官方提问卡片的 chain 选举——chain 规则是 `(priority ?? 0)` **升序**、数值最小者先被调用。selector 只认带 `imageAnnotation` 标记的题，其余（含带 `intent` 的 plan-review）一律返回 `null`，让位官方卡片。

## 6. 版本适配（DSH 0.2.0-rc.2）

原始版本对着更早的 DSH 写的，在 `0.2.0-rc.2` 上有三处会直接失效。三处的共同特征是**都不报错**：装得上、起得来、工具也在，只是界面或取图悄悄退化成官方行为。

| 症状 | 原因 | 修法 |
|---|---|---|
| 卡片是官方提问卡，没有图片和标注工具 | 新版 `PendingQuestion` 上没有 `cancel` 成员（已改名 `dismiss`），selector 的 `typeof pending.cancel !== 'function'` 直接返回 false，插件永不接管 | `closePending(pending)`：`dismiss()` 优先、`cancel()` 兜底；selector 改判它是否为 null |
| 卡片接管成功，但显示「取图失败：HTTP 400」 | `ctx.connection.fetch.register` 新增必填的 `requestBody`；缺失时 Node bridge 落到 streaming 分支，带 body 构造 GET 抛 TypeError，返回**空 body 400**，handler 一次都没被调用 | 路由加 `requestBody: 'buffered'` |
| host 半边能用，但浏览器从不加载 `client.js` | `cordis.patch.yml` 自注册行写成包名时，client-modules 在 profile 安装（symlink）形态下静默解析不到包根，该包不进任何 bundle 批次 | 自注册行 name 改相对路径 `'./lib/index.js'`，走 path-like 分支按目录向上找 manifest |

三处都已在真机验证：`/plugins` 批次里出现 `dsh-image-question/client.js`、卡片 `data-dsh-image-question="m4"`、图片按 1200×800 原尺寸以 blob 加载、点 NG 提交后工具返回 `verdict: ng` / `mode: annotated` / `source-oriented-pixel-edge`。

生产实例（systemd `dsh-web.service`，3080）也实测过一轮：1440×2160 的源图按**原尺寸**回传
`sourceWidth/Height = storedWidth/Height = 1440/2160`（说明 `cordis.patch.yml` 的附件保真覆盖仍然生效、没有被降采样），
一道题带一个 `rect` 标注回传，坐标 `x=105.45 y=1218.12 w=1240.76 h=739.88` —— 画回原图与用户所画位置重合。
同一次会话里先中断再重发没有被 `IMAGE_ANNOTATION_BUSY` 拦住，说明 abort 路径下的 claim 释放是对的。

## 7. 已知限制

- 只在 **Web** 平台有界面（`dsh.client.platform = "web"`）；非 Web 环境里工具仍注册，但没有卡片可答。
- 一道题恰好一张图，一个 Agent 同时一道未答的图片提问。
- 矮窗口下卡片完整可见，但会话区剩余可见高度随窗口变矮而变小（图片区高度取 `min(100%, 50vh)`）。
- 取图失败提示、DPR 1.25、自然时钟上界等边界项未经运行时穷尽验证。

## 8. 目录

```
plugin/
├── package.json          dsh.bundle + dsh.client manifest
├── cordis.patch.yml      bundle 层 patch（附件保真上限 + insert 插件行）
├── lib/index.js          Host 半边：工具注册、附件入库、只读视图路由
├── lib/token-store.js    能力令牌表（签发 / 查找 / 撤销 / 过期）
├── lib/concurrency.js    Agent 身份 + 单飞守卫（claim / release）
├── lib/mask.js           标注 → 蒙版栅格 + 手写 PNG 编码（零依赖，只编码不解码）
└── client.js             Client 半边：接管提问卡片的标注界面
AGENTS.md                 开发守则（本项目的长期规矩与踩坑清单）
```

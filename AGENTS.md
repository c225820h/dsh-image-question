# 图片交互提问插件 — 开发守则

本项目为 DSH Web 开发一个「带图片标注的提问插件」：Agent 遇到不确定时带图提问，用户在 Web 界面里看图、缩放平移、框选/画笔标注、判定 NG/OK/不确定、写说明、提交，Agent 收到**原图坐标系**下的结构化结果。

---

## 0. 开工前必读

| 顺序 | 文件 | 用途 | 什么时候读 |
|---|---|---|---|
| 1 | `进度.md` | **唯一状态真源**：做到哪了、下一步、已定决策、待验证项 | 每次接手都先读 |
| 2 | `方案-图片交互提问插件.md` | 设计依据、已核实机制、接口定义、验收标准 | 动手前读相关章节 |
| 3 | `需求.txt` / `UI图.png` | 原始需求与界面基准 | 做 UI 时必须对着 `UI图.png` 逐区对照 |
| 4 | 本文件 | 长期规矩与踩坑清单 | 每次接手都读 |

**新会话接手的第一件事**：读 `进度.md` 的「当前状态」与「下一步」，不要凭上下文猜测进度。

---

## 1. 不可协商的规矩

### 1.1 不碰的东西

- **官方安装目录**：`C:\Users\asus\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\` 及其下任何文件。升级会覆盖，改了会破坏本机环境。
- **官方 preset 安装目录**（shipped `agent-presets`）。
- **`~/.dsh/profiles/*/` 里其他插件的配置**。

允许写入的范围**仅限**：

- 本项目目录 `D:\DSH-WorkSpace\dsh-image-user-question\`
- 安装/卸载时，改 `~/.dsh/profiles/web/package.json` 里 **仅限** 「依赖加一行 + bundles 加一行」这两处

### 1.2 技术前提（都是已经踩过的坑，别重走）

1. **注册工具**用 `ctx.tools.register({ name, description, parameters, output, execute })` 提交**原始 JSON-Schema**。
   **不要** `import { defineTool } from '@deepseek-ai/dsh-tools'` —— profile 的 `node_modules` 里没有这个包，会解析失败。本地插件应当零 peer 依赖。
2. **client 半边**手写 `window.__ModuleLoader__.load({ id, factory })`。
   **不要**引入 tsdown / rollup / JSX / TypeScript。`client.js` 本身就是可加载产物，**本项目没有构建步骤**。
   平台模块（`react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-store`）可直接 `require`，无需声明。
3. **chain 接管**用 `priority: -100`。规则是**升序、数值最小者优先**（官方文案 `lowest renders`）。用正数会输。
4. **发起提问必须带 `exec.agent`**。不带 agent 的 request 走 agentless 瀑布，**根本不会被转发到浏览器**。
5. 四条**不要**：不要伪造 `intent.kind`；不要把协议塞进 `detail`；不要抢 `user-questions/request` 的 listener（激活顺序不可依赖）；不要用未文档化的 `pendingInteractions` 接口。
6. **原图尺寸**用 `ref.originalDimensions ?? ref.width`，不要自己实现 EXIF 方向规则（会与 DSH 不一致）。
7. **关闭卡片**调 `pending.cancel()`（产生标准 `ASK_CANCELLED`），**不要**调 `delegate()`（那是 provider 路由语义）。
8. **平台模块的来源**是 shell 的静态 seed 表，不在磁盘 node_modules 里，不要试图去安装它们。

### 1.3 开发节奏

- 严格按 `进度.md` 的里程碑 **M0 → M1 → M2 → …** 推进，**不跳级**。M0 未通过不写 M1 的界面。
- 一个里程碑收尾 = **跑完该里程碑的验收标准** + **更新 `进度.md`**。只写代码不改进度，视为未完成。
- **写完必须实测**：重启 `dsh web` + 真实触发一次，把观察到的结果记进进度文档。不许「写完即宣布完成」。
- **改动 `plugin/**` 后必须重跑审计自检入口**：`node 编排/verify/evidence/selfcheck/run.js`（**147 断言**，退出码 `0` = 全过；`--json` 给机器读，`--only=<id>` 定点复跑）。它是 M0–M5 各轮「跑完即删的临时自检」的固化产物（只读、零依赖、不进入插件包），用来补上「自检无可审计产物」这个长期缺口。**新发现的缺陷应先固化成该入口的一条断言，再动手修**（防回归）；反向对照（把修复退回去、断言必须失败）是证明断言有区分度的标准做法。
- 验证要有**可复现的操作步骤**与**明确通过/失败判定**，不写「看起来正常」。

### 1.4 最小改动

- 只做当前里程碑必需的事。不顺手重构、不加需求之外的功能、不做无关验证。
- 想改动方案（尤其是扩大范围、改官方行为、引入新依赖），**先报告等确认**，不要自行决定。

---

## 2. 环境操作

```bash
# 安装（首次）
# 1) 编辑 C:\Users\asus\.dsh\profiles\web\package.json
#    dependencies 加:  "dsh-image-question": "link:D:/DSH-WorkSpace/dsh-image-user-question/plugin"
#    dsh.profile.bundles 追加: "dsh-image-question"
# 2) 装依赖
cd /c/Users/asus/.dsh/profiles/web && pnpm install
# 3) 重启
dsh web
```

- **改了 host 半边**（`lib/index.js`、`cordis.patch.yml`）→ **重启 `dsh web`**
- **改了 client 半边**（`client.js`）→ host 会快照 bundle 字节，内容变更须经 HMR；可靠做法同样是**重启**
- **卸载/回滚**：删掉 profile 里那两行 → `pnpm install` → 重启
- **⚠️ 正式安装与 dev overlay（`--patch dev/patch.yml`）互斥**（2026-09-18 实测）：正式安装落地后再带 `--patch`，同一插件会被注册两次，`dsh web` **启动直接失败** ——`client-modules: package dsh-image-question resolves from multiple active Loader sources` + `connection: exact Fetch route "/api/image-question.view" is already registered`。要用 dev overlay 就先卸掉 profile 那两行；**已正式安装时直接用 `dsh --profile web --host 127.0.0.1 --port <port> --no-open` 启动**，保真覆盖由插件自带的 `cordis.patch.yml`（bundle 层）承担、实测同样生效。
- **可复制的安装 / 更新 / 卸载步骤、生效判据与验证证据**：见 `安装与运维.md`。

参考先例（形态照抄，读源码时优先看）：

- `C:\Users\asus\.dsh\plugins\dsh-purge\` —— 双面本地插件的完整范例（`package.json`、`cordis.patch.yml`、`lib/index.js:517` 的工具注册、`client.js`）
- 官方源码根：`C:\Users\asus\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`
  - `dsh-tool-ask-user\lib\index.js` —— 工具 schema 写法
  - `dsh-client-ui-user-questions\lib\client.js` —— client bundle 格式、提问组件结构与 CSS（照抄配色与间距）

---

## 3. 文档维护

- `进度.md` 是**唯一的状态真源**：状态、待办勾选、决策记录、待验证项、更新日志都写这里。
- `方案-图片交互提问插件.md` 只记**设计与依据**，不记流水账；只有设计或机制结论变化时才改。
- 两者冲突时：**机制结论以方案文档为准，进度状态以进度文档为准**。
- 发现方案里的机制判断被实测推翻时，**两份都要改**，并在进度文档更新日志里记一行。

---

## 4. 卡住时怎么办

- **先查再猜**：DSH 是开源的（<https://github.com/deepseek-ai/deepseek-harness>），接口有疑问直接查源码或 <https://deepseek-harness.github.io/deepseek-harness/>。
- **不凭记忆断言官方 API 行为**。凡是推断出来的结论，必须在进度文档里标明「待验证」，实测后补上结论。
- 方案第 7.3 节列了必须实测的机制清单，逐条打勾。
- 遇到真阻塞（例如某个机制实测不成立），先记录现象与复现步骤，再报告，不要静默改成别的方案。

---

## 5. 交付纪律

- 每次向林爷汇报，说清三件事：**做了什么 / 验证结果 / 下一步**。
- 不要为了显得有进展而虚报完成度。没验证的就说没验证。
- 交付的代码必须能直接跑：本项目是**纯手写产物**，没有构建步骤，所以「文件写对了」就等于「产物对了」。

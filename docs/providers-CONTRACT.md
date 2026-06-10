# 视频生成 Provider 契约（CONTRACT）

> 版本：2026-06-10 · 状态：**冻结**。五路并行实现期间任何人不得擅改本契约；
> 发现契约与现实矛盾（如官方 API 与假设不符），在自己的汇报里上报，不要自行改约。

## 0. 术语与命名（全篇统一，违者返工）

- provider id：`emo` | `omnihuman` | `seedance`（全小写；env 值、接口字段、缓存字段、前端状态一律用 id）
- 显示名：`阿里 EMO` / `字节 OmniHuman` / `字节 Seedance 2.0`
- 「视频 provider」专指对口型视频生成后端；与 LLM/TTS/ASR 的 provider 概念无关，不要混用变量名
- 本项目是 **ESM**（`import`/`export`），所有新文件保持一致；注释风格沿用现有中文注释惯例

## 1. Provider 模块接口

每个 provider 一个文件：`realhuman/providers/<id>.js`，default export 一个对象：

```js
export default {
  id: 'emo',
  displayName: '阿里 EMO',

  /**
   * 配置自检（同步、零网络请求）
   * @returns {{ ready: boolean, missing: string[] }}  missing = 缺失的 env 变量名列表
   */
  configStatus() {},

  /**
   * 形象预处理：该 provider 首次使用、或形象更换（version 变化）后调用一次。
   * @param {{ imageBuffer: Buffer, mime: string, ratio: '3:4'|'1:1' }} input
   * @returns {Promise<{ meta: object }>}
   *   meta 是 provider 私有数据，调用方原样持久化、原样传回 generateVideo。
   *   EMO 的 meta：{ imageUrl(oss://), faceBbox, extBbox, checkPass, uploadedAt, detectError? }
   *   质量检查不通过 ≠ 失败：返回 meta.checkPass=false + meta.detectError，由调用方决定降级。
   *   检测尝试本身异常（服务未开通/网络抖动/服务端可重试错误，非确定性未通过）时，meta 须额外带
   *   retryable: true——调用方据此在下次 speak 时自动重新 prepare；确定性检查未通过（如
   *   check_pass=false / status!==1）不得带此标记，以便秒拦截、不重复烧钱。
   *   真正失败（鉴权/配置错误）：throw Error。
   */
  async prepareFigure(input) {},

  /**
   * 对口型视频生成（含 provider 内部所需的全部上传/刷新/轮询）。
   * @param {{ imageBuffer: Buffer, mime: string, meta: object, audioUrl: string, text: string }} input
   *   - audioUrl：公网 MP3（CosyVoice 产物，24h 有效）。provider 若需要音频文件/base64，自己下载转换。
   *   - meta：本 provider prepareFigure 的产物；形象 URL 过期刷新（如 EMO oss 48h）由 provider
   *     内部用 imageBuffer 重传解决，可原地更新 meta 字段（调用方负责在调用后持久化 meta）。
   * @returns {Promise<{ videoUrl?: string, videoBuffer?: Buffer }>} 二选一，优先 videoUrl（http/https 远端地址）
   *   失败：throw Error。错误消息必须可执行：哪一步失败 + 可能原因 + 缺什么去哪开通。
   */
  async generateVideo(input) {},
}
```

自包含纪律：provider 之间**零相互 import**；公共工具（如轮询 sleep）允许少量重复，不允许为了复用把
EMO 的 DashScope 逻辑泄漏给火山 provider。OmniHuman 如需火山 AK/SK 签名，签名 helper 单独放
`realhuman/providers/volc-sign.js`（属 omnihuman 区域）。

## 2. 注册表：`realhuman/providers/index.js`

```js
import emo from './emo.js';
import omnihuman from './omnihuman.js';
import seedance from './seedance.js';

export const providers = { emo, omnihuman, seedance };
export function getProvider(id) {}   // 未知 id → throw
export function listProviders() {}   // [{ id, displayName, ready, missing }]（ready/missing 来自 configStatus）
```

## 3. server.js 改动点（区域 A 所有）

1. **运行时状态**：`let videoProvider = process.env.VIDEO_PROVIDER || 'emo'`；非法值回退 `'emo'` 并 console.warn。
2. **切换端点**：
   - `GET /api/avatar/realhuman/provider` → `{ current, providers: listProviders() }`
   - `POST /api/avatar/realhuman/provider`，body `{ provider }` → 校验 id；**内存切换，不写 .env**；
     返回 `{ ok: true, current }`；目标 provider `ready=false` 时**仍允许切换**，但响应多带
     `warning: '缺 <env 键>，仅能播放已缓存视频'`。
3. **rhFigure 持久化升级**（同文件 `data/realhuman-figure.json`）：
   ```
   { localImage, source, uploadedAt, version, providers: { <id>: { meta, preparedAt } } }
   ```
   旧格式兼容：读入时若发现顶层 `imageUrl/faceBbox/extBbox`，迁移为 `providers.emo.meta`。
4. **形象本地源文件是唯一真相**：上传照片存 `public/avatars/current-upload.jpg`，文生图下载到
   `public/avatars/current.png`。各 provider 的 `prepareFigure`/`generateVideo` 的 `imageBuffer`
   一律由 server 读这两个本地文件提供（按 `rhFigure.source` 选）。`freshFigureImageUrl` 的 48h
   刷新逻辑整体下沉进 emo provider 的 `generateVideo`，server 里删除。
5. **speak 流程**：TTS 不变 → 话术库三层命中（见 6）→ miss 且 `lipsync` 时：
   懒 prepare（`rhFigure.providers[当前id]` 不存在或 `preparedAt < rhFigure.version` 时调
   `prepareFigure` 并持久化）→ `generateVideo` → 下载/写盘到 `public/avatars/videos/` →
   入库条目 `{ path, text, voice, figVer, provider, embedding }`。
6. **缓存隔离**：`speakCacheKey` 的 parts **加 `provider`**；`findSpeakMatch` 过滤条件 =
   `figVer 一致 && entry.provider === 当前 id`；**旧条目无 provider 字段一律视为 `'emo'`**（读入时补字段）。
7. `GET /api/avatar/realhuman/speak-cache` 列表条目带 `provider` 字段；DELETE 行为不变。
8. `/api/health` 的 `avatar` 块增加 `videoProvider: { current, ready }`。
9. `realhuman/api.js` 保留 `chatStream/tts/asr/uploadFile/pollTask`，EMO 专属函数
   （`genFigure/emoDetect/emoGen` 及 oss 解析头逻辑）移入 `providers/emo.js`；api.js **re-export
   这三个函数**保持旧 import 不炸（文生图路由 `/figure` 仍用 `genFigure`——文生图属形象来源，不属视频 provider，三路共用）。

## 4. env 键（.env.example / README / 代码三处必须一字不差）

```bash
VIDEO_PROVIDER=emo              # 对口型视频后端: emo | omnihuman | seedance（运行中可在设置页热切换）

# —— OmniHuman（火山引擎，AK/SK 签名）——
VOLC_ACCESS_KEY_ID=
VOLC_SECRET_ACCESS_KEY=

# —— Seedance 2.0（火山方舟，Bearer key）——
ARK_API_KEY=
SEEDANCE_MODEL=                 # 默认值由调研结论确定，实现者填入并在汇报中注明
```

调研若发现还需 region/host/额外参数键，统一加 `VOLC_` / `SEEDANCE_` / `OMNIHUMAN_` 前缀，
并在实现汇报 `decisions` 里列出（docs 区域据此同步）。

## 5. 错误与降级纪律（silent-failure 审查重点）

- **绝不跨 provider 静默回退**：A 失败不准偷偷调 B。
- 降级路径只有一条（沿用现状）：视频失败 → 返回 `{ audioUrl, videoError }`，前端播音频 + 静态形象。
- key 未配置时 speak 的 videoError 文案格式：
  `「字节 OmniHuman 未配置：缺 VOLC_ACCESS_KEY_ID/VOLC_SECRET_ACCESS_KEY，开通步骤见 README『三路视频 provider』」`
- 所有 catch：console.warn/error 带上下文 + 原因进响应；**不准吞错、不准空 catch**（现有代码里
  「缓存写盘失败忽略」类 `catch (_)` 属既有约定，可保留）。

## 6. 前端要求（区域 D 所有，public/index.html）

- 设置页「形象」区加**三选一分段控件**（emo/omnihuman/seedance，显示中文显示名）：
  - 载入时 `GET /provider` 渲染当前值 + 各自 ready 状态（未配置的显示 ⚠️ 缺 key 提示，但可选）
  - 切换时 `POST /provider`，响应有 `warning` 就 toast 出来
- 话术库列表条目显示 provider 徽章（沿用「旧形象」徽章的样式语言）
- 聊天页 🎬 快捷 chips 只显示「当前 provider + 当前 figVer」的条目（现有 figVer 过滤上再加 provider 过滤）
- 不改 Live2D 路线的任何逻辑

## 7. 自测脚本（区域 E 所有，scripts/test-video-provider.js）

`node scripts/test-video-provider.js [emo|omnihuman|seedance] [--real]`

- 无 `--real`：打印该 provider configStatus、缺哪些 key、开通入口链接（零网络请求）
- `--real`：key 齐备时跑最小真实链路——读 `public/avatars/` 现有形象图（没有则提示先生成）→
  prepareFigure → 用一句固定短文本走 TTS + generateVideo → 视频落盘 `/tmp/` 并打印路径与耗时
- 这是用户「填 key 即测」的唯一入口，README 要引用它

## 8. 文件所有权（实现期间互不越界，越界 = 返工）

| 区域 | 文件 |
|---|---|
| A backend-core | `realhuman/api.js`、`realhuman/providers/index.js`、`realhuman/providers/emo.js`、`server.js` |
| B omnihuman | `realhuman/providers/omnihuman.js`、`realhuman/providers/volc-sign.js`（如需） |
| C seedance | `realhuman/providers/seedance.js` |
| D frontend | `public/index.html` |
| E docs+script | `.env.example`、`README.md`、`docs/PRD.md`、`scripts/test-video-provider.js` |

通用纪律：完工前对自己所有 JS 文件跑 `node --check`；不跑 git 命令（统一由主编排收尾提交）。

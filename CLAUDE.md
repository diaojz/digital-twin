# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

家庭陪伴数字人「小忆」：照片/提示词生成写实形象，TTS + 对口型视频对话。原为零基础教学项目，**2026-06 起转入工程实战阶段**——教学约束（单文件、零依赖）已解除，按真实工程项目标准维护。

两形态：本地卡通「城北」（Live2D 旧线，备份在 `public/index.live2d.bak.html`）/ 云端真人「小忆」（当前主线）。

## 常用命令

```bash
npm install && npm run build && npm start   # 生产形态（3000；占用时 PORT=3100）

# 日常开发（前端 HMR）
npm start            # 终端 1：后端
npm run dev:web      # 终端 2：Vite dev server（5173，/api /avatars 代理到 3000）

# 视频 provider 自测（「填 key 即测」唯一入口）
node scripts/test-video-provider.js                      # 零网络：三路 key 配置状态 + 开通入口
node scripts/test-video-provider.js seedance --real      # 真实链路（⚠️ 计费约 1 元/秒）

# 可选本地服务
ollama serve                          # 本地 LLM（关代理/VPN，否则 11434 不通）
.venv-asr/bin/python asr_server.py    # Whisper ASR（仅 Apple Silicon）
```

两端版口令（`.env`）：`CHILD_CODE` / `PARENT_CODE` 决定角色（带哪个口令进就是哪端）。三者任一被配即进口令模式；只设老 `ACCESS_CODE` 时它自动当子女端口令（向后兼容）；全不配则本地裸跑，前端按路由带 `X-Twin-Role` 头切角色。访问入口：`/#/child`、`/#/parent`（hash 路由）。

无自动化测试套件；验证靠 `node --check`、`npm run build`、起服务实测与 agent-browser。

## 架构

### 数据流

```
浏览器(Vue) → Express /api/* → 云端（阿里百炼 / 火山引擎）或本地服务（Ollama / Whisper）
```

后端是「转发层」，所有 key 只存服务端 `.env`，前端永不接触。

### 后端

- `server.js`：全部路由。聊天 `/api/chat`(SSE 流式)；真人版 `/api/avatar/realhuman/*`——figure(文生图)/figure/upload(传照片)/speak(TTS+对口型)/speak-cache(话术库)/provider(视频后端热切换)
- `realhuman/api.js`：阿里百炼封装（qwen3-max / CosyVoice / qwen3-asr / 临时存储上传）
- `realhuman/providers/`：**对口型视频 provider 可插拔架构**（emo 阿里 / omnihuman 火山即梦 / seedance 火山方舟），契约见 `docs/providers-CONTRACT.md`——改 provider 前必读，核心纪律：接口 `configStatus/prepareFigure/generateVideo`、provider 间零 import 零兜底、瞬态检测失败标 `meta.retryable=true`、错误消息必须可执行（缺什么 key 去哪开通）
- `memory.js`：`node:sqlite` 记忆库 + Ollama 向量检索（未就绪降级关键词）

### 两端版（子女端 × 父母端 · 契约见 `docs/M1-CONTRACT.md`，A-D 模块零相互 import）

子女建分身 + 配话术 → 把链接发父母；父母聊天/求助 → 子女用原声回 → 父母收对口型回信视频。新增后端模块（各司一职）：

- `family.js`：家庭数据模型（`data/family.db`，可用 `FAMILY_DB` 覆盖）——family/member/inbox_message/quota_usage 四表 + 启动 seed 单家庭；**双口令角色中间件 `authMiddleware()`**（替换原 `ACCESS_CODE` 块）：`?code=`/cookie `twin_code` → `resolveMemberByCode` 解析出 `req.member={id,familyId,role}`，无效 401；裸跑（无任何 code）默认 child，按 `X-Twin-Role` 头切 parent。`CHILD_CODE` 缺省回落 `ACCESS_CODE` 再回落 `'dev-child'`；`PARENT_CODE` 仅裸跑时缺省 `'dev-parent'`——**口令模式下未显式设置则随机生成并打印启动日志**（防 `?code=dev-parent` 被猜中，安全修复 dd3c5dd）
- `inbox.js`：收件箱状态机——`pending（待回复）→ generating（生成中）→ delivered（视频）/ voice_delivered（语音降级）→ viewed（已查看）`，非法迁移 throw；`scanReminders()` 由 server 每 10min 跑一次，pending 超 4h 自动标提醒
- `intent.js`：意图分类（qwen3-max 非流式 + 10s 超时，只输出 JSON，失败/超时一律回落 `chat` 不阻塞主链路）+ 求助类 system prompt（给初步答案 + 结尾「我再帮你问问本人」+ 医疗/转账/验证码硬拒答转真人）
- `quota.js` + `speak-templates.js`：额度护栏（按家庭+自然月累计视频秒数，cap 来自 `QUOTA_VIDEO_SECONDS` 默认 300，超额 `checkQuota` 不过）+ 初始话术包（10 条模板：问候×4 / 关心×3 / 想念×2 / 欢迎视频×1）

**F4 求助闭环（一句话）**：父母 chat → `classifyIntent` 判 `help` → 注入求助 prompt 流式先保底回 + `createMessage` 转子女收件箱 → 子女 `POST /api/inbox/:id/reply` 录原声 → 后台 uploadFile 换 oss + provider `generateVideo({audioUrl})`（**原声直驱不经 TTS**）→ `delivered` 落 `public/avatars/replies/`，失败重试 1 次或额度不过 → `voice_delivered` 降级。

`server.js` 接线（唯一允许动它的人）：中间件换 `authMiddleware`；chat 管线仅 `role==='parent'` 时跑意图分类（child 走原逻辑零变化）；11 条新路由（`/api/family*`、`/api/inbox*`、`/api/parent/replies`、`/api/avatar/realhuman/speak-batch`、`/api/speak-templates`）；speak 路由成功处 `addUsage` 计量。**红线：现有路由请求/响应形状一字不变，child 裸跑行为与改造前完全一致**。

### 前端（web/，Vue 3 + Vite + Pinia，纯 JS）

- **双入口**：`router.js`（vue-router@4，`createWebHashHistory` → `/#/child`、`/#/parent`，刷新/深链稳）；`/` 按已存 role / 链接 `?code=` 重定向；所有请求带 `X-Twin-Role` 头，`?code=` 优先（线上口令模式）。入口组件 `views/child/ChildHome.vue`（C1-C5 控制台）/ `views/parent/ParentHome.vue`（P1-P4 适老化流，`theme-elder`：正文 ≥20px、主按钮 ≥56px、技术报错一律转「稍后再试试」）
- `stores/`：chat（消息+五色状态机）/ settings（音色人设开关，内存态不持久化）/ avatar（形象+话术库）
- `composables/`：useAudioQueue（TTS 播放队列）/ useRecorder（录音+VAD+双 ASR：webspeech 说完无条件发送、whisper 受 autoSend 开关控制）/ useChatStream（SSE）
- 构建产出 `dist/`（gitignore）；`server.js` 优先服务 dist，缺失时兜底 `public/index.legacy.html`（迁移前旧版，纯对照）

### 话术库（成本核心，动 speak 链路前先理解它）

对口型视频按需生成贵（EMO 0.16 元/秒、火山约 1 元/秒）且慢（分钟级），所以：对话默认「流畅模式」只回语音秒回；视频在设置页预生成入库；命中三层（精确 MD5 / 归一化 / 语义，语义默认关 `SPEAK_SEMANTIC`）秒出。**缓存键含 `provider`+`figVer` 双隔离**——换视频后端或换形象都不会误播旧视频；无 provider 字段的旧条目一律视为 `emo`。

## 关键约束与踩坑

- **EMO 链路**：emo-detect-v1 是同步接口（勿加 X-DashScope-Async）；emo-v1 视频在 `output.results.video_url`；本地照片走 DashScope 临时存储换 `oss://` URL（48h 有效，emo provider 内部自动重传刷新）；官方说文件绑定 model，实测可跨模型共用，只传一份
- **OmniHuman**：火山 V4 签名（`volc-sign.js`）；只收公网 URL，形象图经 tmpfiles.org 图床中转（60 分钟直链，换图床改 `uploadToTmpHost` 一个函数）；并发限额 1；req_key 取值待真实 key 验证
- **Seedance 2.0**：ARK Bearer key；图片 base64 data URI 内联；音频 `audio_url + role=reference_audio`；单次 ≤15s；真人人脸可能触发内容审核
- **ASR 三选一**：webspeech（大陆不可用）/ whisper（本地 mlx，仅 Apple Silicon）/ dashscope（在线部署用）
- 改默认链路前确认：**每个能力的零依赖默认（say/webspeech/关键词记忆）必须保持开箱即用**，高质量后端是可选升级

## 部署

线上演示：香港服务器（`ssh hk`）`~/digital-twin`，systemd 服务 `digital-twin`，caddy 反代 `https://twin.chengbei.org`。公网保护靠 `.env` 的 `ACCESS_CODE`（`?code=口令` 种 30 天 cookie）。同步：`ssh hk 'cd ~/digital-twin && git pull && npm run build && sudo systemctl restart digital-twin'`。⚠️ 日本服务器（aigw）跑着关键服务，禁止部署。

## 不进库的本地数据

`.env`（真实 key）、`data/`（记忆库+话术库索引）、`public/avatars/`（形象图+视频缓存）、`dist/`、`.venv-*`。

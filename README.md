<div align="center">

# 数字分身助手 Digital Twin

一个**写实真人数字分身助手「小忆」**——能聊天、会说话、能听懂、记得你，  
还能用你上传的照片**对口型说话**（云端阿里百炼 EMO，一个 API Key 跑通）。

> 💡 没有 API Key 也能玩：本地模式（Ollama）支持文字对话 + 语音 + 记忆，零 Key 零费用，见下方路线 A。
> 早期的 **Live2D 卡通版「城北」** 已被真人版替代，代码在 git 历史里（`git checkout 643980b`），不再维护。

![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.5-3C873A?style=flat-square&logo=node.js&logoColor=white)
![Local First](https://img.shields.io/badge/Local--First-Apple%20Silicon-F2A65A?style=flat-square)
![Ollama](https://img.shields.io/badge/LLM-Ollama%20%2F%20Gateway-6B5EF6?style=flat-square)
![License](https://img.shields.io/badge/Course%20Project-MVP%200--6-111827?style=flat-square)

<!-- TODO: 换成小忆真人版界面截图（docs/assets/ 下旧图是早期城北版界面，已不匹配当前 UI） -->

</div>

---

## 这个项目是什么？

这是「真人数字分身」课程项目的 **MVP 完整版**。它不是一个只停留在概念里的 Demo，而是一套可以在本地跑起来、一步步讲给零基础学员听的完整项目。

核心思路很简单：

> 前端负责互动体验，Node 后端统一转发能力，本地 Ollama / macOS say / 浏览器 Web Speech / SQLite 负责把能力跑起来。

每个能力都优先提供「零依赖开箱即用」方案，高质量版本作为可选升级。先跑通，再优化。

## 亮点能力

| 阶段 | 能力 | 效果 | 默认方案 |
|---|---|---|---|
| 0 | 文字对话 | 接本地 LLM，流式逐字回复 | Ollama / Gateway |
| 1 | 会说话 | 回复自动朗读，分句边播边说 | macOS `say` |
| 2 | 能听懂 | 点击麦克风，语音转文字并发送 | Web Speech API |
| 3 | 有张脸 | 写实形象：提示词生成 / 上传自己的照片 | 阿里百炼（云端）|
| 4 | 记得你 | 长期记忆 + 用户画像 + 记忆管理页 | SQLite |
| 5 | 像真人 | 喊唤醒词唤醒（默认「城北」，可配），说话时可打断 | 前端监听 |
| 6 | 对口型 | **已实现**真人脸对口型说话视频 + 话术库秒出 | 阿里百炼 EMO（云端）|

## 两条玩法路线（先选一条）

| | 路线 A：本地模式（零 Key） | 路线 B：完整真人版（云端） |
|---|---|---|
| 能玩什么 | 文字对话 + 语音朗读/输入 + 记忆 | 路线 A 全部 + 写实形象 + 对口型说话视频 |
| 形象 | 界面相同，但形象区是占位图（形象生成需要 Key） | 提示词文生图 / **上传自己的照片**，EMO 对口型 |
| 需要花钱/注册吗 | ❌ 全本地，零 Key | ✅ 阿里云账号 + 百炼 API Key（新用户有免费额度） |
| 前置安装 | Ollama | Python 3.12 + uv（Whisper 语音输入）、可选 Ollama |
| 适合 | 先跑通、理解架构 | 想要「真人脸说话」的完整体验 |

> 两条路线共用同一份代码，靠 `.env` 切换。建议先跑通路线 A 熟悉流程，再升级路线 B。
> 找「Live2D 卡通城北」的同学：那是本项目的早期形态，已被真人版替代，`git checkout 643980b` 可回看，不再维护。

## 路线 A：本地模式（零 Key 开箱即用）

### 0. 前置条件

- **macOS + Apple Silicon Mac**（M1/M2/M3/M4）
- **Node.js ≥ 22.5**（记忆功能用了 Node 内置 SQLite，老版本起不来；`node -v` 检查，不够就去 [nodejs.org](https://nodejs.org) 装 LTS）
- **Chrome 或 Edge** 浏览器（语音识别更稳定）
- **Ollama**（本地大模型运行器）：[ollama.com](https://ollama.com) 下载安装

### 1. 安装依赖

```bash
npm install
```

### 2. 准备配置

```bash
cp .env.example .env
```

默认使用本地 Ollama，先把模型拉下来（约 4.7GB，嫌大可先用 `qwen2.5:0.5b` 验证）：

```bash
ollama pull qwen2.5:7b
ollama serve          # ⚠️ 关掉系统代理/VPN，否则 localhost:11434 会通信失败
```

`.env` 保持：

```env
LLM_PROVIDER=ollama
OLLAMA_MODEL=qwen2.5:7b
```

### 3. 启动项目

```bash
npm start
```

打开浏览器访问：

```text
http://localhost:3000
```

## 路线 B：小忆云端真人版（需要阿里百炼 Key）

真人版的对话 / 语音 / 形象 / 对口型全部走 **阿里云百炼**，一个 API Key 跑通。**先把下面 3 个前置条件全部做完再启动**，否则会出现「页面能开但形象生成报错 / 语音输入没反应」。

### 前置 1：创建阿里百炼 API Key（必须）

1. 注册 / 登录阿里云，开通 [百炼大模型平台](https://bailian.console.aliyun.com)（开通免费，按用量计费）。
2. 控制台右上角「API-KEY」→ 创建一个新 Key（形如 `sk-xxxx`），**地域选「华北2（北京）」**。
3. 在「模型广场」确认以下模型可用（新开通账号一般自带免费额度，2026-06 时点）：

| 模型 | 用途 | 免费额度（开通后） | 超出后计费 |
|---|---|---|---|
| `qwen3-max` | 对话 | 有赠送 token | 按 token |
| `cosyvoice-v2` | 语音合成（龙婉女声） | 有赠送额度 | 按字符 |
| `wanx2.1-t2i-turbo` | 文生图（生成形象） | 有赠送张数 | 按张 |
| `emo-detect-v1` | 人脸检测 | 200 张 | 0.004 元/张 |
| `emo-v1` | **对口型视频** | 1800 秒 | 1:1 画幅 0.08 元/秒；3:4 画幅 0.16 元/秒 |

> ⚠️ **EMO（悦动人像）大概率要单独申请开通**：在模型广场搜「悦动人像」，没开通时调用会报 403。没开通也能玩——形象、对话、语音都正常，只是没有对口型视频（系统会自动降级，不会卡死）。
> 额度和价格会变，以 [官方计费页](https://help.aliyun.com/zh/model-studio/emo-quick-start/) 为准。

### 前置 2：本地 Whisper 语音输入（想用语音对话就必须）

真人版语音输入走**本地 mlx-whisper**（浏览器 Web Speech 在大陆连不上谷歌服务器，不可用）。需要 **Python 3.12**（⚠️ 不能用系统自带的 Python，版本不对装不上 mlx）和 [uv](https://docs.astral.sh/uv/)：

```bash
# 1. 装 uv（已装可跳过）
curl -LsSf https://astral.sh/uv/install.sh | sh

# 2. 建 Python 3.12 虚拟环境并装依赖（uv 会自动下载 Python 3.12）
uv venv --python 3.12 .venv-asr
uv pip install --python .venv-asr mlx-whisper fastapi uvicorn python-multipart

# 3. 启动 Whisper 服务（⚠️ 首次启动会自动下载模型，约 1.5GB，耐心等）
#    脚本内置了 HuggingFace 国内镜像 + 绕过系统代理，大陆网络可直接下
.venv-asr/bin/python asr_server.py
```

看到 `Uvicorn running on http://127.0.0.1:8001` 即就绪。**模型只下载一次**，之后秒启动。只想打字聊天的话，这步可跳过（`.env` 里把 `ASR_PROVIDER` 留成 `webspeech` 即可，语音按钮在大陆不可用但不影响打字）。

### 前置 3（可选）：Ollama embedding（话术库语义命中用）

不装也完全能玩（精确命中、归一化命中不依赖它）。想让「意思相近、用词不同的话」也命中缓存视频再装：

```bash
ollama serve && ollama pull nomic-embed-text
```

### 配置并启动

`.env` 改成：

```env
LLM_PROVIDER=dashscope
AVATAR_PROVIDER=realhuman
DASHSCOPE_API_KEY=sk-你的key
ASR_PROVIDER=whisper     # 没做前置 2 就留 webspeech
PORT=3100
```

```bash
.venv-asr/bin/python asr_server.py   # 终端 1：Whisper（做了前置 2 才需要）
npm start                            # 终端 2：主服务
# 浏览器开 http://localhost:3100
```

启动后的体验路径：**设置 → 形象图片**（生成形象或上传自己的照片）→ **设置 → 对口型视频**（预生成常用话术）→ 回聊天页点 **🎬 快捷按钮** 秒出对口型视频。

## 推荐运行环境

- macOS + Apple Silicon Mac
- Node.js ≥ 22.5（内置 SQLite 的最低版本）
- Chrome / Edge（语音识别更稳定）
- Ollama（路线 A 必需；路线 B 可选）
- Python 3.12 + uv（路线 B 的 Whisper 语音输入；Kokoro TTS 可选升级同理）

## 项目结构

```text
digital-twin/
├── server.js                         # Express 后端：LLM / TTS / ASR / 记忆 / 真人形象 / 话术库
├── memory.js                         # 记忆模块：SQLite + 关键词 / Ollama 向量检索（也供话术库语义命中）
├── realhuman/
│   └── api.js                        # 阿里百炼封装：qwen3-max / CosyVoice / 文生图 / EMO 对口型
├── public/
│   ├── index.html                    # 单页前端：聊天、形象、语音、对口型、设置、记忆面板
│   └── avatars/                      # 形象图 + 对口型视频本地缓存（gitignore）
├── docs/
│   ├── PRD.md                        # 真人版产品规范
│   ├── 高保真设计稿.html              # 关怀岛屿紫色风视觉稿
│   ├── 调研报告-数字人与TTS方案-2026.06.md
│   └── 真人形象-云端部署指南.md
├── tts_server.py                     # Kokoro TTS 可选服务
├── asr_server.py                     # Whisper ASR 服务（真人版语音输入；内置 hf 镜像 + 绕代理）
├── .env.example                      # 配置模板
└── README.md
```

本地私有数据不会提交：

```text
.env
node_modules/
data/memory.db
```

## 能力拆解

### 文字对话

前端向 Node `/api/chat` 发请求，Node 再转发给本地 Ollama 或中转网关。回复是流式输出，用户能看到文字一点点出现。

### TTS 语音合成

默认使用 macOS 自带 `say` 命令，不需要额外安装：

```env
TTS_ENABLED=true
TTS_PROVIDER=say
TTS_VOICE=Tingting
```

如果想要更自然的声音，可以启动可选 Kokoro 服务：

```bash
uv venv --python 3.12 .venv-tts
uv pip install --python .venv-tts mlx-audio "misaki[zh]" fastapi uvicorn
.venv-tts/bin/python tts_server.py
```

### ASR 语音识别

默认使用浏览器 Web Speech API：

```env
ASR_ENABLED=true
ASR_PROVIDER=webspeech
```

如果想要本地离线识别，可以启动可选 Whisper 服务：

```bash
uv venv --python 3.12 .venv-asr
uv pip install --python .venv-asr mlx-whisper fastapi uvicorn python-multipart
.venv-asr/bin/python asr_server.py
```

### 长期记忆

记忆存在本地 SQLite：

```text
data/memory.db
```

它会记录两类内容：

- 用户画像：称呼、职业、偏好等稳定信息
- 对话记忆：重要经历、需求、上下文

如果 Ollama embedding 模型可用，会优先走向量检索；否则自动降级关键词匹配。

```bash
ollama pull nomic-embed-text
```

### 唤醒词和打断

- 喊唤醒词可以唤醒助手（默认「城北」，沿用早期版本，可在 `.env` 改成任何词）
- 助手朗读时，你开口说话可以打断它
- 这两项都优先在浏览器前端完成，不强依赖 Python 服务

```env
WAKE_WORD_ENABLED=true
WAKE_WORDS=城北
BARGE_IN_ENABLED=true
```

### 真人形象「小忆」（realhuman 模式 · 已实现）

真人版「小忆」是本项目的主线形态——全部云端能力接 **阿里百炼**，一个 `DASHSCOPE_API_KEY` 跑通：

| 能力 | 模型 / 接口 |
|---|---|
| 脑（对话） | `qwen3-max`（流式） |
| 声（语音） | `cosyvoice-v2`（龙婉 / 龙橙 / 龙华女声） |
| 脸（形象） | `wanx2.1-t2i-turbo` 文生图，**或上传自己的照片**（DashScope 临时存储换 `oss://` URL） |
| 脸（对口型） | `emo-detect-v1`(同步) + `emo-v1`(异步)，生成嘴型同步视频 |
| 听（语音输入） | 本地 `mlx-whisper`（大陆可用；Web Speech 在大陆连不上谷歌） |

> 开通 Key、装 Whisper 等**前置条件和启动步骤见上方 [路线 B](#路线-b小忆云端真人版需要阿里百炼-key)**，这里讲设计。

**核心体验设计**：

- **流畅模式（默认）**：对话只播**语音 + 静态写实形象**，秒回不卡。对口型视频云端生成慢（~40s），不在对话现场做。
- **对口型话术库**：在「设置 → 对口型视频」里**预生成**常用语（开场白等），存进话术库；对话说到**相同的话**（标点/断句不同也算）就秒出口型，字幕自动同步成库里那句，保证「嘴上说的」和「屏幕显示的」一致。生成过的视频在设置里有**可视化列表**（重播 / 单条删除，刷新重启都不丢），聊天页底部还有 **🎬 快捷 chips**——每条已缓存视频一个按钮，点击不走 LLM，小忆直接秒说这句（演示最稳路径）。还有一层「语义命中」（用词不同但意思相近）**默认关闭**——nomic-embed-text 对含相同名字的中文短句相似度虚高（「你好呀小忆」和「小忆陪你慢慢来」高达 0.978），易误命中播错视频；要启用设 `SPEAK_SEMANTIC=true`（建议先换更好的中文 embedding 模型）。
- **持续对话（免手）**：AI 回完自动开麦，讲完停顿自动发送，一轮接一轮；8 秒没说话自动退出省电。设置可关。
- **上传自己的照片做形象**：「设置 → 形象图片」里可直接上传照片（单人、正面、五官清晰，最短边 ≥ 400px），之后对口型视频就是照片里的你。EMO 不收 base64，本地照片走官方「临时存储」上传（`getPolicy` → OSS 直传 → `oss://` URL + `X-DashScope-OssResourceResolve: enable` 请求头）；`oss://` 仅 48h 有效，生成视频前快过期会用本地原图**自动重传刷新**。注意：上传时绑定的模型必须和后续调用一致，所以 `emo-detect-v1` / `emo-v1` 各传一份。
- **本地缓存**：形象图、对口型视频都下载到本地（`public/avatars/`），重启复用、不怕 24h 临时 URL 过期、不重复烧额度；「重置形象」/「清除视频缓存」可在设置里单独管理。

> ⚠️ **EMO 接口坑**：`emo-detect-v1` 是**同步**接口（不要加 `X-DashScope-Async`，否则报 403「不支持异步调用」，容易被误判为账号未开通）；`emo-v1` 是异步，视频 URL 在 `output.results.video_url`。
> 历史参考（"真人形象本地不可行"）见 [`docs/真人形象-云端部署指南.md`](docs/真人形象-云端部署指南.md)；本实现走的是「云端按需生成 + 本地缓存 + 话术库命中」路线。

## 常见问题

### 真人版形象生成 / 对口型报 403？

最常见原因是 **EMO（悦动人像）服务没开通**——去百炼模型广场搜「悦动人像」申请开通。注意：`emo-detect-v1` 是同步接口，403 也可能是代码里误加了异步请求头（本仓代码已处理）。没开通 EMO 时形象和语音照常可用，只是没有对口型视频。

### 上传自己的照片后提示「人脸检测未通过」？

EMO 对照片有要求：**单人、正面、五官清晰无遮挡**，最短边 ≥ 400 像素。侧脸、多人合影、脸太小、戴墨镜都会被拒。换一张符合要求的照片即可；被拒的照片仍会作为静态形象展示，只是不能生成对口型视频。

### Whisper 首次启动卡很久？

首次启动 `asr_server.py` 要下载约 1.5GB 模型，大陆网络走脚本内置的 HuggingFace 镜像，一般几分钟。看到 `Uvicorn running on http://127.0.0.1:8001` 才算就绪。只下载一次，之后秒启动。

### 页面能打开，但发消息没回复？

先检查 Ollama 是否启动：

```bash
ollama list
ollama serve
```

如果开着系统代理 / VPN，可能会影响 `localhost:11434`，建议先关掉再试。

### 语音按钮没反应？

请使用 Chrome 或 Edge。Safari 对 Web Speech API 支持有限。

### Whisper / Kokoro 安装失败？

确认使用 Python 3.12，不要使用系统自带 Python：

```bash
uv venv --python 3.12 .venv-asr
uv venv --python 3.12 .venv-tts
```

### 真人版对口型视频生成很慢 / 想要秒出？

对口型视频是云端 EMO 渲染，单条 ~40 秒，属正常。对话默认是「流畅模式」（只语音 + 静态形象，秒回）。想要秒出口型：在「设置 → 对口型视频」里**预生成**常用语，对话说到**相同的话**（标点/断句不同也行）就秒出。

### 想开「语义命中」（意思相近、用词不同的话也秒出）？

默认**关闭**。原因：`nomic-embed-text` 对含相同名字/关键词的中文短句相似度虚高（「你好呀小忆」和「小忆陪你慢慢来」高达 0.978，只因都含「小忆」），开了会误命中、反复播错视频。

默认只用「精确 + 归一化命中」（说相同的话、标点不同也算），可靠不误伤。

真要语义命中，先起 Ollama 并**建议换更适合中文的 embedding 模型**（如 `bge-m3`），再开开关：

```bash
ollama serve && ollama pull bge-m3
```

```env
SPEAK_SEMANTIC=true
EMBED_MODEL=bge-m3
SPEAK_MATCH_THRESHOLD=0.85
```

## 教学定位

这个项目适合用来讲：

- 一个 AI 产品如何从最小 MVP 逐步长出来
- 前端、Node 后端、本地模型服务之间如何分工
- 为什么「真人数字分身」本地实时不可行（依赖 NVIDIA CUDA），以及两条现实路径：本地 Live2D 卡通（本项目早期形态）/ 云端 EMO 按需生成 + 缓存（当前主线）
- 如何用零依赖默认方案降低学习门槛，再逐步升级质量

---

<div align="center">

**先跑起来，再一点点变强。**

</div>

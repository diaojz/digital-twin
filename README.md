<div align="center">

# 数字分身助手 Digital Twin

一个跑在 **Apple Silicon Mac 纯本地** 的卡通数字分身助手「城北」。  
能聊天、会说话、能听懂、记得你，还支持唤醒词和语音打断。

![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-3C873A?style=flat-square&logo=node.js&logoColor=white)
![Local First](https://img.shields.io/badge/Local--First-Apple%20Silicon-F2A65A?style=flat-square)
![Ollama](https://img.shields.io/badge/LLM-Ollama%20%2F%20Gateway-6B5EF6?style=flat-square)
![License](https://img.shields.io/badge/Course%20Project-MVP%200--6-111827?style=flat-square)

<img src="docs/assets/digital-twin-home.png" alt="数字分身助手首页截图" width="880">

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
| 3 | 有张脸 | Live2D 卡通形象，口型随音频动 | Live2D |
| 4 | 记得你 | 长期记忆 + 用户画像 + 记忆管理页 | SQLite |
| 5 | 像真人 | 喊「城北」唤醒，说话时可打断 | 前端监听 |
| 6 | 真人形象 | 预留云端真人形象接口和部署指南 | 云端进阶 |

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 准备配置

```bash
cp .env.example .env
```

默认使用本地 Ollama：

```bash
ollama pull qwen2.5:7b
ollama serve
```

`.env` 保持：

```env
LLM_PROVIDER=ollama
OLLAMA_MODEL=qwen2.5:7b
```

如果暂时不想装 Ollama，也可以切到中转网关：

```env
LLM_PROVIDER=gateway
GATEWAY_BASE=https://gw.diaoye.org/v1
GATEWAY_KEY=你的_API_Key
GATEWAY_MODEL=claude-sonnet-4-5
```

### 3. 启动项目

```bash
npm start
```

打开浏览器访问：

```text
http://localhost:3000
```

## 推荐运行环境

- macOS + Apple Silicon Mac
- Node.js 18+
- Chrome / Edge（语音识别更稳定）
- Ollama（本地 LLM 推荐）
- Python 3.12（仅 Kokoro TTS / Whisper ASR 可选升级需要）

## 项目结构

```text
digital-twin/
├── server.js                         # Express 后端：LLM / TTS / ASR / 记忆 / 形象配置
├── memory.js                         # 记忆模块：SQLite + 关键词 / 向量检索
├── public/
│   └── index.html                    # 单页前端：聊天、形象、语音、记忆面板
├── docs/
│   ├── assets/
│   │   └── digital-twin-home.png     # README 首页截图
│   └── 真人形象-云端部署指南.md        # 阶段 6 云端真人形象方案
├── tts_server.py                     # Kokoro TTS 可选服务
├── asr_server.py                     # Whisper ASR 可选服务
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

- 喊「城北」可以唤醒助手
- 城北朗读时，你开口说话可以打断它
- 这两项都优先在浏览器前端完成，不强依赖 Python 服务

```env
WAKE_WORD_ENABLED=true
WAKE_WORDS=城北
BARGE_IN_ENABLED=true
```

### 真人形象进阶

Mac 本地实时真人写实形象目前不可行，主流方案依赖 NVIDIA CUDA。项目保留了云端接入位：

```env
AVATAR_PROVIDER=live2d
REALHUMAN_SERVICE_URL=
```

完整方案见：[`docs/真人形象-云端部署指南.md`](docs/真人形象-云端部署指南.md)

## 常见问题

### 页面能打开，但发消息没回复？

先检查 Ollama 是否启动：

```bash
ollama list
ollama serve
```

如果开着系统代理 / VPN，可能会影响 `localhost:11434`，建议先关掉再试。

### 语音按钮没反应？

请使用 Chrome 或 Edge。Safari 对 Web Speech API 支持有限。

### Live2D 形象没加载？

Live2D 资源依赖网络和 CDN。形象加载失败不影响文字对话功能。

### Whisper / Kokoro 安装失败？

确认使用 Python 3.12，不要使用系统自带 Python：

```bash
uv venv --python 3.12 .venv-asr
uv venv --python 3.12 .venv-tts
```

## 教学定位

这个项目适合用来讲：

- 一个 AI 产品如何从最小 MVP 逐步长出来
- 前端、Node 后端、本地模型服务之间如何分工
- 为什么「真人数字分身」本地不可行，而 Live2D 是更现实的教学路径
- 如何用零依赖默认方案降低学习门槛，再逐步升级质量

---

<div align="center">

**先跑起来，再一点点变强。**

</div>

# 数字分身助手 — MVP 完整版（阶段 0-6）

「真人数字分身」课程项目的 **MVP 完整版**，一个跑在 **Apple Silicon Mac 纯本地、不买 GPU** 的卡通数字分身「小艾」：能聊、会说、能听、记得你、像真人一样可唤醒可打断。

这是「课件 = 项目」双线产物 —— 课程带零基础学员从最小 MVP 一步步搭到这个完整形态，每一阶段都是一次能跑出效果的真实迭代。

## 它能干嘛（7 个阶段累积出来的能力）

| 阶段 | 能力 | 一句话 | 本地可行 |
|---|---|---|---|
| 0 | 文字对话 | 接本地 Ollama，真的能聊（流式逐字回复） | ✅ |
| 1 | 会说话 | TTS 朗读，流式分句边说边播 | ✅ |
| 2 | 能听懂 | ASR 语音输入，完整语音对话闭环 | ✅ |
| 3 | 有张脸 | Live2D 卡通形象，嘴型跟真实 TTS 音频同步、眼随鼠标 | ✅ |
| 4 | 记得你 | 长期记忆 + 用户画像，记住你是谁、聊过什么 | ✅ |
| 5 | 像真人 | 喊「小艾」唤醒 + 说话时能打断它 | ✅ |
| 6 | 真人形象 | 真人写实需云端 N 卡（本地不可行），预留接口 + 部署指南 | ❌ 云端 |

**核心设计原则**：每个能力都有「零依赖开箱即用」的默认方案（say / webspeech / 关键词记忆 / Live2D / 前端打断唤醒），高质量方案（kokoro / whisper / 向量记忆 / openWakeWord）作为需 Python 3.12 的可选升级。先跑通，再优化。

## 运行步骤

### 1. 安装依赖

```bash
cd app/digital-twin
npm install
```

### 2. 配置 LLM 后端

复制 `.env.example` 改名为 `.env`，编辑里面的配置：

```bash
cp .env.example .env
```

**模式 A：本地 Ollama（推荐）**

先确保 Ollama 已安装并下载模型：

```bash
# 安装 Ollama（若未安装）
brew install ollama

# 下载模型（约 4.7GB，第一次需要等一会儿）
ollama pull qwen2.5:7b

# 启动 Ollama 服务（保持这个终端窗口开着）
ollama serve
```

`.env` 里保持默认即可：

```
LLM_PROVIDER=ollama
OLLAMA_MODEL=qwen2.5:7b
```

> 坑预警：跑 Ollama 时必须关掉系统代理（VPN / Clash / Surge 等），
> 否则本地 localhost:11434 通信会失败！

**模式 B：中转网关（没装 Ollama 时用）**

```
LLM_PROVIDER=gateway
GATEWAY_BASE=https://gw.diaoye.org/v1
GATEWAY_KEY=你的_API_Key
GATEWAY_MODEL=claude-sonnet-4-5
```

### 3. 启动服务

```bash
npm start
```

看到以下输出说明服务已起：

```
[Config] 已加载 .env 文件
[Config] LLM_PROVIDER=ollama
[Config] Ollama: http://localhost:11434, model=qwen2.5:7b
[Server] 数字分身助手已启动
[Server] 打开浏览器访问: http://localhost:3000
```

### 4. 打开浏览器

访问 http://localhost:3000，在输入框里输入消息，Enter 发送。

顶部说明条会显示后端连接状态（绿点 = 已连接，红点 = 离线）。

## 项目结构

```
digital-twin/
├── server.js        ← 后端：Express + LLM + TTS + ASR + 记忆 CRUD + 形象配置路由
├── memory.js        ← 记忆模块：SQLite 存储 + 向量/关键词检索 + LLM 抽取
├── tts_server.py    ← Kokoro TTS 服务（Python 3.12 + mlx-audio，可选）
├── asr_server.py    ← Whisper ASR 服务（Python 3.12 + mlx-whisper，可选）
├── public/
│   └── index.html   ← 前端：暖米 UI + 对话 + TTS + ASR + 记忆管理 + 真人形象入口
├── docs/
│   └── 真人形象-云端部署指南.md  ← 阶段 6：Vast.ai + LiveTalking 部署完整指南
├── data/            ← 记忆数据库（.gitignore 掉，本地私有）
│   └── memory.db    ← SQLite 数据库（自动创建）
├── package.json
├── .env             ← 本地配置（不提交 git）
├── .env.example     ← 配置模板（含阶段 6 AVATAR_PROVIDER + REALHUMAN_SERVICE_URL）
├── .gitignore
└── README.md
```

## 阶段 1：TTS 语音合成

### TTS 模式 A：say（推荐，零依赖，开箱即用）

macOS 自带 `say` 命令，不需要安装任何东西。`.env` 里保持：

```
TTS_ENABLED=true
TTS_PROVIDER=say
TTS_VOICE=Tingting
```

启动服务后，小艾说话时会自动朗读。顶栏的 **🔊 朗读** 按钮可以随时开/关。

可选音色（中文）：
- `Tingting` - 普通话女声（推荐）
- `Meijia` - 台湾国语女声
- `Eddy` - 普通话男声

### TTS 模式 B：kokoro（本地高质量，需要 Python 3.12）

> 重要：必须用 Python **3.12**，不能用系统自带的 Python（macOS 上系统 Python 可能是 3.14，
> mlx-audio 暂时无法在 3.14 上安装）。

**Step 1：创建 Python 3.12 虚拟环境**

```bash
cd app/digital-twin

# 用 uv 指定 Python 3.12（需要先装 uv：brew install uv）
uv venv --python 3.12 .venv-tts

# 安装依赖
uv pip install --python .venv-tts mlx-audio "misaki[zh]" fastapi uvicorn
```

**Step 2：启动 Kokoro TTS 服务**

```bash
# 在一个单独的终端窗口里跑（保持开着）
.venv-tts/bin/python tts_server.py
```

看到以下输出说明 Kokoro 模型加载成功：

```
[TTS] 正在加载 Kokoro-82M 模型，首次启动约需 10-30 秒...
[TTS] Kokoro 模型加载成功
[TTS] misaki[zh] 中文 G2P 加载成功
INFO:     Uvicorn running on http://127.0.0.1:8000
```

**Step 3：切换 .env**

```
TTS_ENABLED=true
TTS_PROVIDER=kokoro
TTS_VOICE=zf_xiaoxiao
TTS_SERVICE_URL=http://127.0.0.1:8000
```

Kokoro 音色：
- `zf_xiaoxiao` - 中文女声（推荐）
- `zm_yunxi` - 中文男声

## 阶段 2：ASR 语音识别

### ASR 模式 A：webspeech（推荐，零依赖，开箱即用）

直接用浏览器内置的 Web Speech API，**不需要装任何 Python 包**，在 Chrome / Edge 上直接可用。

> 注意：webspeech 模式需要联网到 Google 服务器做识别，国内可能需要 VPN。

`.env` 里保持（或不改）：

```
ASR_ENABLED=true
ASR_PROVIDER=webspeech
```

启动服务后，点击左侧「说话」按钮或输入框旁的麦克风按钮，开始说话，识别完自动发送。

**录音流程**：
1. 点击「说话」按钮 → 状态切换为「聆听绿」+ 波形动画
2. 说完话后，浏览器自动检测停顿并识别
3. 识别结果自动填入输入框并发送给小艾
4. 小艾回复并朗读（如果 TTS 开启）

### ASR 模式 B：whisper（本地高质量，需要 Python 3.12）

本地离线识别，不依赖网络，中文识别质量更好。

> 重要：必须用 Python **3.12**，不能用系统自带的 Python（macOS 上系统 Python 可能是 3.14，
> mlx 系列暂时无法在 3.14 上安装）。

**Step 1：创建 Python 3.12 虚拟环境并安装依赖**

```bash
cd app/digital-twin

# 用 uv 指定 Python 3.12（需要先装 uv：brew install uv）
uv venv --python 3.12 .venv-asr

# 安装依赖
uv pip install --python .venv-asr mlx-whisper fastapi uvicorn python-multipart
```

**Step 2：启动 Whisper ASR 服务**

```bash
# 在一个单独的终端窗口里跑（保持开着）
.venv-asr/bin/python asr_server.py
```

第一次使用时会自动下载模型（`mlx-community/whisper-large-v3-turbo`，约 1.5GB）：

```
[ASR] 数字分身 ASR 服务启动中，端口 8001
[ASR] 模型: mlx-community/whisper-large-v3-turbo
[ASR] 提示：第一次收到请求时才加载模型（懒加载），请稍等片刻
INFO:     Uvicorn running on http://127.0.0.1:8001
```

**Step 3：切换 .env**

```
ASR_ENABLED=true
ASR_PROVIDER=whisper
ASR_SERVICE_URL=http://127.0.0.1:8001
ASR_MODEL=mlx-community/whisper-large-v3-turbo
```

也可以用更小的模型（速度更快，质量稍低）：

```
ASR_MODEL=mlx-community/whisper-medium
# 或
ASR_MODEL=mlx-community/whisper-small
```

## 阶段 4：记忆层

### 记忆怎么工作

**两类记忆**：
- **用户画像（profile）**：稳定的事实（称呼、职业、偏好等），存在 `profile` 表
- **对话记忆（memory）**：重要事件/经历，带时间戳，存在 `memories` 表

**写入（抽取）**：对话结束后，后端异步（不阻塞响应）判断用户消息里是否含有触发关键词
（"我叫/我是/我喜欢/我在"等），有的话调本地 Ollama 做一次轻量抽取，把结构化信息存库。

**读取（注入）**：每次用户发消息前，检索相关记忆 + 用户画像，拼成一段"关于这位用户
你已知道"的上下文，追加到 system prompt 里，让 LLM 在回答时自然融入。

**向量检索 vs 关键词降级**：
- 优先用 Ollama embedding（`nomic-embed-text`）做余弦相似度 top-k 检索
- 如果 Ollama 的 embedding 模型没有就绪（比如还没 `ollama pull nomic-embed-text`），自动
  降级到**关键词匹配**（字符串包含），保证不装 embedding 也能用

### SQLite 存在哪

`data/memory.db`（相对于项目根目录），已加入 `.gitignore`，本地私有不提交。
首次启动时自动创建。

### Embedding 配置（可选，提升检索质量）

```bash
# 拉取 embedding 模型（约 274MB，一次性）
ollama pull nomic-embed-text
```

拉完之后重启服务，检索会自动切换到向量模式。
没拉也没关系，关键词模式下记忆功能完全可用。

### 控制注入量

`.env` 里 `MEMORY_TOPK=4` 控制每次注入的最多记忆条数（默认 4）。
不建议设太大（>8），记忆太多会增加 token 消耗和延迟，还会让小艾"过度熟悉"显得奇怪。

### 记忆管理页

点击顶栏的「记忆」按钮打开记忆管理面板：
- **用户画像卡**（暖橙边）：展示所有已记录的画像字段，可直接编辑
- **对话记忆列表**：每条可查看/编辑/删除，内联确认不打断流程
- **手动添加**：可以手动记录一件事（小艾下次对话会知道）

## 阶段 5：唤醒词 + 语音打断

### 语音打断（barge-in）

**效果**：小艾正在朗读时，你开口说话 → 它立即停止 → 进入聆听态听你说。

**实现方式**（前端，无需 Python）：
- TTS 播放期间，用 `getUserMedia` 获取麦克风流 + `AnalyserNode` 持续检测音量
- 连续 8 帧（约 0.25s）RMS 音量超过阈值 → 触发打断
- 打断：停止当前 AudioBufferSource → 清空 TTS 队列 → 切换到聆听态 → 自动启动 ASR

**配置**（`.env`）：
```
BARGE_IN_ENABLED=true   # false 关掉打断功能
```

**UI 操作**：topbar 的 ✂️「打断」按钮可以随时开/关。

**注意**：打断需要麦克风权限。TTS 开始播放时自动申请，申请一次后后续复用不再弹窗。

---

### 唤醒词（wake word）

**效果**：不用手动点按钮，喊一声"小艾" → 金色唤醒脉冲 → 自动进入聆听态。

**实现方式**：浏览器端 Web Speech API `continuous=true` 模式，开箱即用，不需要 Python 服务。

**配置**（`.env`）：
```
WAKE_WORD_ENABLED=true       # false 关掉唤醒词功能
WAKE_WORDS=小艾,小爱          # 逗号分隔的触发词（小爱是 Web Speech 识别"小艾"时常见的误识别）
```

**UI 操作**：
- topbar 的 👂「唤醒」按钮开启/关闭常驻监听
- 开启后，界面底部显示金色提示条「正在监听唤醒词「小艾」…」
- 喊"小艾"→ 状态变金色唤醒脉冲 → 0.6 秒后自动开始聆听

**隐私提示**：
> 唤醒词监听需要麦克风常开（即使不在说话时）。浏览器会在地址栏显示麦克风占用图标。
> 如果不希望麦克风常开，关掉「唤醒」按钮即可，不影响手动点按钮说话的功能。

---

### 浏览器端 vs Python 后端的取舍

| 方案 | 优点 | 缺点 |
|------|------|------|
| **浏览器 Web Speech**（当前默认） | 零依赖，开箱即用，不需要 Python | 需要联网（Google 服务），国内需 VPN；"小艾"有时识别为"小爱"（已加进唤醒词） |
| **openWakeWord（Python + ONNX）** | 本地离线，不依赖网络，更精准 | 默认没有"小艾"中文模型，需自训练（约需准备 100+ 条录音样本 + 训练脚本） |

**结论**：默认用浏览器端方案，开箱即用。如果需要离线唤醒或"小艾"识别精度更高，
可以上 openWakeWord（自训练"小艾"模型是额外工程量，本项目不内置，作为进阶可选）。

---

### 验证打断功能（无真实麦克风时）

打开浏览器 DevTools Console，粘贴以下代码手动触发打断：

```javascript
// 模拟"检测到用户说话"，触发打断逻辑
// 前提：小艾必须正在 TTS 播放中（ttsPlaying === true）
if (ttsPlaying) {
  bargeInFrameCount = BARGE_IN_FRAMES; // 直接设到阈值
  triggerBargeIn();
}
```

---

## 各阶段扩展计划

| 阶段 | 功能 | 主要新增 |
|------|------|---------|
| 0 | 文字对话 + 本地 LLM | server.js + public/index.html |
| 1 | TTS 会说话 | POST /api/tts + 前端流式分句播放 |
| 2 | ASR 能听懂 | POST /api/asr + 前端麦克风录音 + webspeech/whisper 双模式 |
| 3 | Live2D 接真实对话 | 口型 / 表情与对话状态联动 |
| 4 | 记忆层 | SQLite + embedding + 画像抽取 + 记忆管理页 |
| 5 | 唤醒词 + 语音打断 | barge-in 前端 VAD + 唤醒词 Web Speech 持续监听 |
| 6（当前）| 真人形象预留接口 | AVATAR_PROVIDER 配置 + /api/avatar/config + 说明面板 + 云端指南 |

## 阶段 6：真人写实形象（进阶选学）

### 结论：Mac 本地跑不动，要真人必须上云

经过多轮调研核实：MuseTalk / SoulX-FlashHead / LiveTalking / LiteAvatar 全部硬绑 NVIDIA CUDA（FP8 量化 / FlashAttention-3），Apple Silicon MPS 不支持，Mac 本地零跑通证据。

**普通学员用本地 Live2D 卡通形象已经是完整产品，阶段 6 是选学内容。**

### 预留接口设计

阶段 6 已在代码里预留了"真人形象"接入位：

**后端（server.js）**：
- 读取 `AVATAR_PROVIDER` 环境变量（`live2d` / `realhuman`）
- 读取 `REALHUMAN_SERVICE_URL`（云端 LiveTalking 服务地址）
- `GET /api/avatar/config` 接口：返回当前 provider 配置给前端

**前端（public/index.html）**：
- topbar 加"真人形象（云端）"按钮，点击弹出技术边界说明面板
- 说明面板诚实告知原因 + 推荐云端方案 + 引导看部署指南
- 代码里预留 `avatarProvider` 变量和切换逻辑挂载点（见 `// TODO` 注释）

### 配置项

`.env` 里新增两个配置（默认不启用，保持 Live2D）：

```
# live2d（默认）或 realhuman（云端进阶，需配置下面的 URL）
AVATAR_PROVIDER=live2d

# 云端 LiveTalking 服务地址（AVATAR_PROVIDER=realhuman 时填）
REALHUMAN_SERVICE_URL=
```

### 云端真人形象部署

详见 `docs/真人形象-云端部署指南.md`，内容涵盖：
1. 为什么本地不可行（技术原因）
2. 推荐平台（Vast.ai RTX4090 约 $0.31/hr，约 ¥70/天）
3. LiveTalking Docker 部署步骤
4. 如何接入本项目（填 REALHUMAN_SERVICE_URL + 前端 WebRTC 接入位）
5. 成本估算 + 肖像授权注意事项

---

## 常见问题

**Q: 页面打开，但发消息没有回复**
A: 检查 Ollama 是否在运行（`ollama list` 能看到模型）；检查是否开着系统代理。

**Q: 模型还在下载中**
A: 先用模式 B（中转网关）验证链路，等模型下载完再切回 ollama。

**Q: Live2D 形象没有加载**
A: 形象依赖 CDN，需要网络。形象加载失败不影响对话功能，可以正常使用。

**Q: 点语音按钮没反应 / 提示"浏览器不支持"**
A: webspeech 模式需要用 Chrome 或 Edge，Safari 的支持有限。

**Q: webspeech 模式下，识别出来是日文或英文**
A: 已经设置了 `lang='zh-CN'`，如果识别语言不对，试试重新点击录音，或切换到 whisper 本地模式。

**Q: whisper 模式安装 mlx-whisper 报错**
A: 确保用的是 Python 3.12（`uv venv --python 3.12 .venv-asr`），不能用系统 Python（3.14 装不上 mlx）。

**Q: whisper 第一次录音很慢**
A: 第一次请求时才下载并加载模型（懒加载），之后常驻内存，速度会快很多。

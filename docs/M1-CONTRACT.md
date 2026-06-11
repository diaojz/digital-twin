# M1 两端 MVP 工程契约（CONTRACT）

> 版本：2026-06-12 · 状态：**冻结**。并行实现期间不得擅改；与现实矛盾在汇报中上报。
> 上游：docs/PRD-v2-两端版.html（产品规格）+ docs/两端高保真设计稿.html（UI 规格）。
> 本项目 ESM + Node 原生 fetch + 中文注释；新模块全部跟随。

## 0. 术语与命名

- 角色 role：`child` | `parent`（小写，库/接口/前端一律用）
- 收件箱消息 type：`help`（求助）| `alert`（告警）| `leave_word`（留言）
- 收件箱 status：`pending`（待回复）→ `generating`（生成中）→ `delivered`（已送达，视频）| `voice_delivered`（语音送达，降级）→ `viewed`（已查看）
- 意图 intent：`chat` | `help` | `emotion` | `health_risk`

## 1. 数据层：`family.js`（区域 A）

SQLite 文件 `data/family.db`（node:sqlite，建库模式参照 memory.js）。**建表一步到位、MVP 行为单家庭**：

```sql
CREATE TABLE IF NOT EXISTS family (
  id INTEGER PRIMARY KEY, name TEXT, confirmed INTEGER DEFAULT 0,  -- 试看确认过
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS member (
  id INTEGER PRIMARY KEY, family_id INTEGER, role TEXT, nickname TEXT,  -- 「妈」「爸」「小军」
  invite_code TEXT UNIQUE, last_active INTEGER, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS inbox_message (
  id INTEGER PRIMARY KEY, family_id INTEGER, from_member INTEGER,
  type TEXT, status TEXT DEFAULT 'pending',
  original_text TEXT, ai_reply TEXT,
  child_reply_audio TEXT, reply_video TEXT, reply_text TEXT,
  reminded INTEGER DEFAULT 0,
  created_at INTEGER, updated_at INTEGER, viewed_at INTEGER
);
CREATE TABLE IF NOT EXISTS quota_usage (
  family_id INTEGER, month TEXT,  -- '2026-06'
  video_seconds REAL DEFAULT 0, video_count INTEGER DEFAULT 0,
  PRIMARY KEY (family_id, month)
);
```

启动时 seed：family(id=1) + child member + parent member。invite_code 来源 env：
`CHILD_CODE`（缺省回落 `ACCESS_CODE`，再缺省 `'dev-child'`）、`PARENT_CODE`（缺省 `'dev-parent'`）。

导出：
```js
export function initFamilyDb() {}                  // 建表 + seed，幂等
export function getFamily(familyId) {}             // → { id, name, confirmed, members: [...] }
export function setFamilyConfirmed(familyId) {}
export function resolveMemberByCode(code) {}       // → member | null
export function touchMember(memberId) {}           // 更新 last_active
export function regenInviteCode(familyId, role) {} // → 新 code（写库）；env 提供的 code 不可被覆盖时返回 null 并说明
// —— 双口令/角色中间件（替换现有 ACCESS_CODE 中间件，行为向后兼容）——
export function authMiddleware() {}  // 见 §5
```

## 2. 收件箱：`inbox.js`（区域 B）

```js
export function createMessage({ familyId, fromMember, type, originalText, aiReply }) {} // → message
export function listMessages(familyId, { forRole }) {}  // child 视角全量倒序；parent 视角仅本人相关回信
export function getMessage(id) {}
export function setStatus(id, status, extra = {}) {}    // extra: { childReplyAudio, replyVideo, replyText }
export function markViewed(id) {}                       // → 记录 viewed_at（闭环时长指标数据源）
export function pendingReplies(familyId) {}             // parent 轮询：status in (delivered, voice_delivered) 未 viewed
export function unreadCount(familyId) {}                // child 角标：pending + 未读 alert
export function scanReminders() {}                      // pending 超 4h 且 reminded=0 → 置 reminded=1，返回列表（server 定时器每 10min 调一次）
```
状态机合法迁移仅限 §0 所列；非法迁移 throw。

## 3. 意图与代答：`intent.js`（区域 C）

```js
export async function classifyIntent(text) {}
// 调 qwen3-max（realhuman/api.js 的 chatStream 不适合，这里用非流式 compatible-mode chat，自带 10s 超时），
// prompt 要求只输出 JSON {"intent":"chat|help|emotion|health_risk"}；解析失败/超时一律回落 'chat'（不阻塞主链路）
export function helpSystemPrompt(personaName) {}
// 求助类回复的 system prompt 追加段：给初步答案（≤3 步）+ 结尾必带「我再帮你问问{personaName}本人哈，他看到就回您」
// + 医疗/转账/验证码类硬性拒答只转真人
export function alertComfortPrompt() {}   // health_risk 时的安抚回复追加段（不诊断、建议联系家人）
export function isUrgent(intent) {}        // health_risk → true
```

## 4. 额度与话术模板：`quota.js` + `speak-templates.js`（区域 D）

```js
// quota.js
export function addUsage(familyId, seconds) {}      // 当月累计（估秒：文本长度/4 或视频实长）
export function getUsage(familyId) {}               // → { month, videoSeconds, videoCount, capSeconds, exceeded }
export function checkQuota(familyId) {}             // → { allowed, remainSeconds }；cap 来自 env QUOTA_VIDEO_SECONDS（默认 300）
// speak-templates.js
export const SPEAK_TEMPLATES = [ /* 10 条：问候×4(早/午/晚/睡前)、关心×3(吃饭/天气/吃药)、想念×2、欢迎视频×1（欢迎条文案含「想我了就打开这个」）*/ ];
```

## 5. server.js 接线（区域 E · integrator，等 A-D 交付后动工）

1. **中间件替换**：现 ACCESS_CODE 块 → `authMiddleware()`。规则：
   - 任一 code 配置时：`?code=` / cookie `twin_code` → `resolveMemberByCode` → `req.member={id,familyId,role}`，无效 401（沿用现拦截页）
   - 全部 code 未配置（本地裸跑）：默认 `req.member={familyId:1, role: req.get('X-Twin-Role')==='parent'?'parent':'child'}`——前端按路由带头
   - 静态资源放行逻辑与现实现一致
2. **chat 管线改造**（仅 `req.member.role==='parent'` 时启用，child 走原逻辑零变化）：
   classifyIntent → `help`：helpSystemPrompt 注入 + 流式回复后 createMessage(type:'help', aiReply=完整回复文本)，响应 SSE 末尾追加事件 `data: {"inbox":{"id":N,"type":"help"}}`；
   `health_risk`：alertComfortPrompt 注入 + createMessage(type:'alert')，同样追加 inbox 事件；`emotion` 记录情绪计数（memory 既有机制），`chat` 原样
3. **新路由**（全部 JSON；除 parent 专用外默认 child 权限）：
   - `GET  /api/family` → getFamily + getUsage（child）
   - `POST /api/family/confirm` → setFamilyConfirmed（child，试看确认）
   - `POST /api/family/code/regen` body `{role}`（child）
   - `GET  /api/inbox` → listMessages（按 req.member.role 视角）
   - `POST /api/inbox/leave-word` body `{text}`（parent 留言，type:'leave_word'，无 AI 代答）
   - `POST /api/inbox/:id/reply` body `{audio:"data:audio/...;base64,..."}`（child）→ 立即 202 `{ok,status:'generating'}`，后台异步：存 `public/avatars/replies/<id>.webm` → DashScope uploadFile 换 oss URL → 当前 provider `generateVideo({audioUrl})`（**原声直驱，不经 TTS**）→ 成功 setStatus delivered + 视频落 `public/avatars/replies/<id>.mp4` + addUsage；失败重试 1 次仍败 → `voice_delivered`（child_reply_audio 即交付物）。额度 checkQuota 不通过 → 直接 voice_delivered
   - `GET  /api/inbox/:id`（双角色，parent 只能取本家庭）
   - `POST /api/inbox/:id/viewed`（parent）
   - `GET  /api/parent/replies`（parent 轮询）
   - `POST /api/avatar/realhuman/speak-batch` body `{texts:[...]}`（child）→ 逐条复用 speak 内部逻辑生成入话术库，SSE 回进度；每条过 checkQuota
   - `GET  /api/speak-templates`
4. **speak 计量**：现 speak 路由生成成功处 addUsage(估秒)；checkQuota 不过 → 返回 `{audioUrl, videoError:'本月额度已用完…'}`
5. **定时器**：`setInterval(scanReminders, 10min)`
6. 红线：现有路由请求/响应形状一字不变；child 裸跑（无任何 code）行为与改造前完全一致

## 6. 前端（区域 F/G/H，第二个工作流）

- 依赖新增：`vue-router@4`（仅此一个）
- 路由：`/`（按已存 role/链接 code 重定向）、`/child`（C1-C5 tab 控制台）、`/parent`（P1-P4 流）
- 所有请求带 `X-Twin-Role` 头；链接里 `?code=` 优先（线上口令模式）
- 父母端 `theme-elder`：正文 ≥20px、主按钮 ≥56px、单屏单任务、技术报错一律转「稍后再试试」（设计稿 P1-P4 为准）
- 子女端复用现组件：FigureSection/PersonaSection/SpeakLibSection/VideoProviderSection 进 C1/C4；新建收件箱 C2/C3、家庭成本 C5
- P4 回信轮询 `GET /api/parent/replies` 间隔 30s + 进入页面即查；播放完成调 viewed
- P3：chat SSE 收到 `inbox` 事件 → 气泡下方加状态条「✓ 已转给{子女昵称} · HH:MM」

## 7. 文件所有权

| 区域 | 文件 |
|---|---|
| A family | `family.js` |
| B inbox | `inbox.js` |
| C intent | `intent.js` |
| D quota | `quota.js`、`speak-templates.js` |
| E integrator | `server.js`（唯一允许动它的人） |
| F parent-ui | `web/src/views/parent/**`、父母端组件与 theme-elder 样式 |
| G child-ui | `web/src/views/child/**`、收件箱/家庭组件 |
| H router | `web/src/main.js`、`web/src/router.js`、`web/src/App.vue`、`web/src/api/client.js` 增量、`package.json` |

通用纪律：node --check 自检；不跑 git；错误不吞（console + 响应带因）；A-D 模块零相互 import（共享只允许 import family.js 的 db 句柄导出）。

## 8. 测试成本红线（QA agent 必读）

- 后端 QA：**禁止真实视频生成**——F4 reply 测试前先 `POST /provider {"provider":"seedance"}`（无 key）走 voice_delivered 降级路径验状态机；测完切回 emo
- 批量话术：只测 `{texts:["测试一条"]}` 单条且在 seedance 无 key 下验报错路径；真实生成留给主编排端到端阶段
- LLM/TTS/ASR 随便调（分级便宜）

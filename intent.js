/**
 * intent.js — 区域 C：意图分类与代答话术
 *
 * 职责（契约 §3）：
 *   - classifyIntent(text)  父母每轮消息过 qwen3-max 分类（非流式 compatible-mode），
 *                           只输出四类之一：chat | help | emotion | health_risk；
 *                           解析失败/超时一律回落 'chat'，不阻塞主链路。
 *   - helpSystemPrompt()    求助类回复的 system prompt 追加段（≤3 步初步答案 + 转真人兜底
 *                           + 医疗/转账/验证码硬性拒答）。
 *   - alertComfortPrompt()  健康风险（health_risk）的安抚回复追加段（不诊断、导向联系家人）。
 *   - isUrgent(intent)      health_risk → true。
 *
 * 工程纪律（契约 §7）：本模块不 import 其它 A-D 区域模块；DashScope 调用自带，
 *   鉴权从 process.env.DASHSCOPE_API_KEY 读取（由 server.js 启动时注入）。
 */

// DashScope 兼容 OpenAI 的对话端点（与 realhuman 一致，但本模块独立持有，避免跨区域 import）
const DASH_BASE = 'https://dashscope.aliyuncs.com';
const CLASSIFY_MODEL = 'qwen3-max';
const CLASSIFY_TIMEOUT = 10000; // ms，硬性 10s 超时，超了就回落 chat

// 合法意图集合（契约 §0）
const VALID_INTENTS = new Set(['chat', 'help', 'emotion', 'health_risk']);

// ── 分类 system prompt ───────────────────────────────────────
// 只做四分类，强约束「只输出 JSON」。即便后端不支持 response_format，prompt 也能兜住。
const CLASSIFY_SYSTEM = `你是一个家庭分身助手的「意图分类器」。父母（老人）会对孩子的数字分身说一句话，你判断它属于以下四类中的哪一类，只输出 JSON，不要任何解释、不要 markdown：

- chat：日常闲聊、问候、唠家常、分享见闻（例：「今天天气真好」「吃饭了吗」）
- help：生活求助、要孩子帮忙解决具体问题（例：「电视没声音了」「手机怎么连不上网」「这个药怎么吃」）
- emotion：表达情绪、想念、孤独、委屈、开心需要回应（例：「有点想你了」「今天有点闷」）
- health_risk：本人身体不适或健康风险信号（例：「我有点头晕」「胸口闷」「刚才摔了一跤」）

判断优先级：只要句子里有本人身体不适/健康风险信号，一律判 health_risk（高于其它）。

输出格式（严格）：{"intent":"chat"} —— intent 取值必须是 chat、help、emotion、health_risk 之一。`;

/**
 * 对父母这一轮消息做意图分类。
 * 调 qwen3-max 非流式 compatible-mode chat，自带 10s 超时；
 * 任何异常（无 key / 网络 / 超时 / 解析失败 / 取值非法）一律回落 { intent: 'chat' }，
 * 只 console.warn 不抛错，保证主链路（聊天）不被分类拖垮。
 *
 * @param {string} text 父母这一轮说的话（已 ASR 转文字）
 * @returns {Promise<{intent:'chat'|'help'|'emotion'|'health_risk'}>}
 */
export async function classifyIntent(text) {
  // 空输入直接当闲聊，省一次调用
  if (!text || !text.trim()) return { intent: 'chat' };

  const key = process.env.DASHSCOPE_API_KEY;
  if (!key) {
    console.warn('[intent] DASHSCOPE_API_KEY 未配置，意图分类回落 chat');
    return { intent: 'chat' };
  }

  try {
    const url = `${DASH_BASE}/compatible-mode/v1/chat/completions`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: CLASSIFY_MODEL,
        messages: [
          { role: 'system', content: CLASSIFY_SYSTEM },
          { role: 'user', content: text },
        ],
        stream: false,
        temperature: 0,
        // 优先请求 JSON 模式；DashScope 兼容模式支持则更稳，不支持时被忽略，靠 prompt 兜底
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(CLASSIFY_TIMEOUT),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.warn(`[intent] 分类接口 HTTP ${resp.status}，回落 chat：${body.slice(0, 200)}`);
      return { intent: 'chat' };
    }

    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    const intent = parseIntent(content);
    return { intent };
  } catch (err) {
    // 含 AbortError（10s 超时）、网络错误、JSON 解析错误等，全部回落 chat
    console.warn(`[intent] 意图分类异常，回落 chat：${err?.message || err}`);
    return { intent: 'chat' };
  }
}

/**
 * 从模型返回的文本里解析出合法 intent。
 * 容错：可能是纯 JSON、可能带 markdown 代码块、可能整段话里夹着 JSON。
 * 解析不到合法值就返回 'chat'。
 * @param {string} content
 * @returns {'chat'|'help'|'emotion'|'health_risk'}
 */
function parseIntent(content) {
  if (typeof content !== 'string') return 'chat';

  // 1) 优先从文本里抠出第一个 JSON 对象再解析
  const match = content.match(/\{[\s\S]*?\}/);
  if (match) {
    try {
      const obj = JSON.parse(match[0]);
      if (obj && VALID_INTENTS.has(obj.intent)) return obj.intent;
    } catch {
      // 落到关键词兜底
    }
  }

  // 2) JSON 解析失败时，从原文里直接找出现的合法意图词（防模型没按格式输出）
  const lower = content.toLowerCase();
  for (const it of ['health_risk', 'help', 'emotion', 'chat']) {
    if (lower.includes(it)) return it;
  }

  return 'chat';
}

/**
 * 求助类（help）回复的 system prompt 追加段。
 * 由 server.js 在 parent chat 管线里拼到分身人设 prompt 之后。
 *
 * @param {string} personaName 子女昵称（如「小军」），缺省给个中性兜底
 * @returns {string}
 */
export function helpSystemPrompt(personaName) {
  const name = (personaName && String(personaName).trim()) || '我';
  return `
【当前是「求助场景」，请按下面规矩回复爸妈】
1. 先用最家常、最好懂的话给一个初步办法，最多 3 步，每步一句话，别堆术语（比如「你先看看电视后面那根线插紧没」）。
2. 语气是子女对爸妈说话：暖、稳、有耐心，可以叫「爸」「妈」。
3. 结尾必须带一句兜底转真人，原话风格：「我先帮你试着弄一下，回头我再帮你问问${name}本人哈，他看到准回您。」——让爸妈知道这事一定会传到本人那里，不是石沉大海。
4. 【硬性红线·必须拒答只转真人】凡涉及以下，绝对不要给具体建议或操作，只温柔地说「这事得${name}本人来，我已经第一时间转给他了，您先别急」：
   - 医疗用药：吃什么药、加减药量、要不要去医院、病情判断；
   - 转账汇款、银行卡、密码、贷款、投资理财；
   - 短信验证码、手机/银行/社保等任何验证码、登录码。
   遇到这三类，先安抚情绪，再明确说会马上让本人处理，绝不自己拿主意。`;
}

/**
 * 健康风险（health_risk）安抚回复的 system prompt 追加段。
 * 原则：不诊断、不吓人、温柔安抚，并把出口导向「联系家人/打个真电话」（PRD F5）。
 *
 * @returns {string}
 */
export function alertComfortPrompt() {
  return `
【当前是「健康提醒场景」，爸妈刚说了身体不舒服，请这样回】
1. 先稳稳接住情绪：「我在呢，别怕」，让爸妈感觉有人陪着。
2. 绝对不要做任何诊断、不要猜是什么病、不要建议吃什么药——你不是医生。
3. 温柔地建议两件事：① 先坐下来歇一歇、慢慢喝口温水别着急；② 最好现在就给家里人打个电话，或者让我帮您把这事告诉他们，让真人尽快联系到您。
4. 语气像子女在身边一样关切、不慌不忙，让爸妈安心，知道这事我已经记下来、会让家人马上知道。`;
}

/**
 * 该意图是否需要走「紧急/告警」分支（health_risk）。
 * @param {string} intent
 * @returns {boolean}
 */
export function isUrgent(intent) {
  return intent === 'health_risk';
}

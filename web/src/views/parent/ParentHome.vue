<template>
  <!-- 父母端 P1-P4 · 适老化（theme-elder） -->
  <div class="phone theme-elder">
    <div class="screen">
      <div class="notch"></div>
      <div class="statusbar">
        <span>{{ clock }}</span>
        <span>📶 🔋</span>
      </div>

      <!-- ════════════ P1 首次告知页 ════════════ -->
      <div v-if="screen === 'onboard'" class="tell-page">
        <!-- 子女形象图（GET /api/avatar/config 的 figure；无则 emoji 占位） -->
        <div class="tell-avatar">
          <img v-if="figureSrc" :src="figureSrc" alt="">
          <span v-else>👨🏻</span>
        </div>
        <div class="tell-title">{{ childNickname }}给您做了一个<br>分身助手</div>

        <!-- 欢迎视频卡：话术库里 key 含 welcome 的条目有就可播，没有显示静态卡 -->
        <div class="tell-video-card" @click="playWelcome">
          <div class="tell-video-thumb">
            <img v-if="figureSrc" :src="figureSrc" alt="">
            <div class="play-btn">▶</div>
          </div>
          <div class="tell-video-label">点开听{{ childNickname }}说</div>
        </div>

        <!-- 三行大字说明 -->
        <div class="tell-points">
          <div class="tell-point"><span class="tp-icon">🤝</span>平时它陪您聊，24小时都在</div>
          <div class="tell-point"><span class="tp-icon">💌</span>{{ childNickname }}本人的回复会带 💌 标记</div>
          <div class="tell-point"><span class="tp-icon">🔔</span>您说的求助，{{ childNickname }}能看到</div>
        </div>

        <!-- 大按钮：开始和XX聊天 -->
        <button class="bigbtn" style="margin-top:auto;" @click="finishOnboard">
          开始和{{ childNickname }}聊天
        </button>
      </div>

      <!-- ════════════ P2 主屏 ════════════ -->
      <div v-else class="parent-main">
        <AvatarStage ref="avatarStageRef" />

        <!-- 实时字幕条（P2 听写）/ 求助态隐藏给对话腾空间 -->
        <div v-if="!helping" class="subtitle-bar">
          <div class="sub-label">{{ recording ? '您正在说' : '点下面的麦克风跟我说话' }}</div>
          {{ subtitle || (recording ? '…' : '') }}
        </div>

        <!-- 求助转达态（P3）：AI 回复气泡 + 已转达状态条 -->
        <div v-if="helping" class="chat-parent" ref="chatScrollRef">
          <template v-for="b in bubbles" :key="b.id">
            <div class="msg-parent" :class="b.role">{{ b.content }}</div>
            <div v-if="b.delivered" class="msg-status">
              <span style="font-size:16px;">✓</span> 已转给{{ childNickname }} · {{ b.deliveredAt }}
            </div>
          </template>
        </div>

        <!-- 大字话题卡（P2，仅非求助态展示，点击直接播缓存视频不走 LLM） -->
        <div v-if="!helping" class="topic-cards">
          <div
            v-for="t in topicCards"
            :key="t.key"
            class="topic-card"
            @click="playTopicCard(t)"
          >{{ t.text }}</div>
        </div>

        <!-- 大麦克风按住说话 -->
        <button
          class="bigbtn"
          :class="{ listen: recording }"
          @mousedown.prevent="micDown"
          @mouseup.prevent="micUp"
          @mouseleave="micUp"
          @touchstart.prevent="micDown"
          @touchend.prevent="micUp"
        >
          <span class="bmic">🎤</span>{{ recording ? '松开结束' : '按住说话' }}
        </button>

        <!-- 文字兜底入口（不便说话 / 测试用） -->
        <div class="text-fallback">
          <input
            v-model="textInput"
            placeholder="也可以打字跟我说…"
            @keyup.enter="sendText"
            data-test="parent-text-input"
          >
          <button @click="sendText" data-test="parent-text-send">➤</button>
        </div>
      </div>

      <!-- ════════════ P4 收回信横幅 ════════════ -->
      <div
        v-if="unreadReply && !showLetter"
        class="letter-banner"
        @click="openLetter"
        data-test="reply-banner"
      >
        <span class="lb-emoji">💌</span>
        {{ childNickname }}给您回信了
        <span class="lb-arrow">›</span>
      </div>

      <!-- ════════════ P4 收回信全屏覆盖层 ════════════ -->
      <div v-if="showLetter && activeReply" class="letter-overlay">
        <div class="letter-title">{{ childNickname }}给您回信了</div>
        <div class="real-badge">💌 {{ childNickname }}本人回复</div>

        <!-- 有 reply_video：金色边框视频 -->
        <div v-if="activeReply.replyVideo" class="letter-video-card">
          <video
            ref="letterVideoEl"
            :src="activeReply.replyVideo"
            playsinline
            controls
            data-test="reply-video"
          ></video>
        </div>
        <!-- 无 video，有 child_reply_audio：语音播放卡 -->
        <div v-else-if="activeReply.childReplyAudio" class="letter-audio-card" data-test="reply-audio-card">
          <div class="la-disc">
            <img v-if="figureSrc" :src="figureSrc" alt="">
            <span v-else>🎧</span>
          </div>
          <div class="la-text">语音回信 · 点「再听一遍」播放</div>
        </div>

        <!-- 文字补充（若有） -->
        <div v-if="activeReply.replyText" class="letter-note">
          {{ childNickname }}说：{{ activeReply.replyText }}
        </div>

        <div class="letter-btns">
          <button class="bigbtn" @click="replayLetter" data-test="reply-replay">▶ 再听一遍</button>
          <button class="bigbtn outline" @click="closeLetter" data-test="reply-close">我知道了</button>
        </div>
      </div>

      <Toast ref="toastRef" />
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue';
import AvatarStage from '../../components/AvatarStage.vue';
import Toast from '../../components/Toast.vue';
import { useChatStore } from '../../stores/chat.js';
import { useSettingsStore } from '../../stores/settings.js';
import { useAvatarStore } from '../../stores/avatar.js';
import { useRecorder } from '../../composables/useRecorder.js';
import { useAudioQueue } from '../../composables/useAudioQueue.js';
import {
  apiFetch, speak, getAvatarConfig, getHealth, getFamily,
  getSpeakCache, parentReplies, markViewed,
} from '../../api/client.js';

import '../../styles/elder.css';

const ONBOARD_KEY = 'twin_onboarded';

const chatStore     = useChatStore();
const settingsStore = useSettingsStore();
const avatarStore   = useAvatarStore();
const { playAudio, waitVideoEnd } = useAudioQueue();

// ── 视图态 ──
const screen   = ref('main');     // 'onboard' | 'main'
const helping  = ref(false);      // P3 求助转达态（出现 AI 气泡时切换）
const clock    = ref('9:41');

// ── DOM refs ──
const toastRef      = ref(null);
const avatarStageRef = ref(null);
const chatScrollRef = ref(null);
const letterVideoEl = ref(null);

// ── 家庭 / 形象 ──
const childNickname = ref('小军');
const figureSrc     = ref('');

// ── P2 字幕 + 文字兜底 ──
const subtitle  = ref('');
const textInput = ref('');

// ── P2 话题卡（话术库前 3 条）──
const topicCards = ref([
  { key: 'fallback_meal', text: '🍚 今天吃了什么' },
  { key: 'fallback_miss', text: '💭 我想你了' },
  { key: 'fallback_help', text: '🙏 帮我个忙' },
]);
const speakCacheItems = ref([]);   // 话术库缓存（含 path）

// ── P3 对话气泡 ──
const bubbles = ref([]);  // { id, role:'me'|'ai', content, delivered?, deliveredAt? }

// ── P4 回信 ──
const replies     = ref([]);
const unreadReply = computed(() => replies.value.length > 0);
const showLetter  = ref(false);
const activeReply = ref(null);
let replyTimer = null;

function showToast(msg, ms) { toastRef.value?.show(msg, ms); }
function showStatic() { avatarStageRef.value?.showStatic(); }
function showVideo(url) { avatarStageRef.value?.showVideo(url); }

function nowHHMM() {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// ════════════════════════════════════════════
// P1 首次告知
// ════════════════════════════════════════════
function welcomeItem() {
  return speakCacheItems.value.find(it => (it.key || '').includes('welcome') && it.path);
}
function playWelcome() {
  const w = welcomeItem();
  if (w && w.path) {
    chatStore.setState('speak');
    showVideo(w.path);
    const v = avatarStageRef.value?.figureVideoEl?.value;
    if (v) waitVideoEnd(v).then(() => { chatStore.setState('idle'); showStatic(); });
  } else {
    showToast(childNickname.value + '还没录欢迎视频，先点下面开始聊天吧', 3000);
  }
}
function finishOnboard() {
  try { localStorage.setItem(ONBOARD_KEY, '1'); } catch (_) {}
  screen.value = 'main';
  nextTick(() => { chatStore.setState('idle'); showStatic(); });
}

// ════════════════════════════════════════════
// P2 话题卡：点击直接播缓存视频，不走 LLM
// ════════════════════════════════════════════
function playTopicCard(t) {
  if (chatStore.busy) { showToast('稍等一下，' + childNickname.value + '正在忙'); return; }
  // 话术库里有缓存视频就秒播；否则当文字消息发出去（兜底）
  const item = speakCacheItems.value.find(it => it.key === t.key && it.path)
    || speakCacheItems.value.find(it => it.text === t.text && it.path);
  if (item && item.path) {
    helping.value = false;
    subtitle.value = item.text || t.text;
    chatStore.setState('speak');
    showVideo(item.path);
    const v = avatarStageRef.value?.figureVideoEl?.value;
    if (v) waitVideoEnd(v).then(() => { chatStore.setState('idle'); showStatic(); });
  } else {
    sendMessage((t.text || '').replace(/^[^一-龥a-zA-Z]+/, ''));
  }
}

// ════════════════════════════════════════════
// 父母端对话主链路（含 P3 求助转达事件解析）
// 自己解析 SSE：既要 delta 也要 inbox 事件帧（client.chatStream 只透传 delta）
// ════════════════════════════════════════════
async function parentChatStream(messages, persona, onDelta, onInbox) {
  const body = { messages };
  if (persona) body.persona = persona;
  const resp = await apiFetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok || !resp.body) throw new Error('chat ' + resp.status);
  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '', full = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const raw = t.slice(5).trim();
      if (raw === '[DONE]') continue;
      let j;
      try { j = JSON.parse(raw); } catch (_) { continue; }
      if (j.error) throw new Error(j.error);
      if (j.inbox) { onInbox && onInbox(j.inbox); continue; }
      const delta = j.delta || '';
      if (delta) { full += delta; onDelta(delta, full); }
    }
  }
  return full;
}

async function sendMessage(text) {
  text = (text || '').trim();
  if (!text || chatStore.busy) return;

  chatStore.setInputEnabled(false);
  subtitle.value = '';

  // 加父母气泡
  const meBubble = { id: Date.now() + Math.random(), role: 'me', content: text };
  bubbles.value.push(meBubble);
  helping.value = true;   // 进入对话气泡态（P3 容器，AI 接住后可能挂状态条）
  chatStore.messages.push({ role: 'user', content: text });
  scrollChat();

  // AI 流式回复
  chatStore.setState('think');
  const aiId = Date.now() + Math.random() + 1;
  bubbles.value.push({ id: aiId, role: 'ai', content: '' });
  // 通过 id 找回数组里的「响应式代理」再改属性（直接改原始对象不会触发更新）
  const patchAi = (patch) => {
    const b = bubbles.value.find(x => x.id === aiId);
    if (b) Object.assign(b, patch);
  };
  let reply = '';
  try {
    reply = await parentChatStream(
      chatStore.messages.slice(-20),
      settingsStore.currentPersonaPrompt(),
      (_d, full) => { patchAi({ content: full }); scrollChat(); },
      (inbox) => {
        // P3：收到 inbox 事件帧 → AI 气泡下挂「已转给{昵称}」状态条
        patchAi({ delivered: true, deliveredAt: nowHHMM() });
        console.log('[ParentChat] 已转达求助:', inbox);
      },
    );
  } catch (e) {
    reply = '我都听着呢，您慢慢说～（稍后再试试）';
    patchAi({ content: reply });
    console.error('[ParentChat] LLM 失败:', e);
  }
  if (!reply.trim()) { reply = '我在呢，您再跟我说说？'; patchAi({ content: reply }); }
  chatStore.messages.push({ role: 'assistant', content: reply });
  scrollChat();

  // 语音 + 形象（流畅模式：静态形象 + 语音；命中话术库则播视频）
  chatStore.setState('gen');
  try {
    const data = await speak({
      text: reply,
      voice: settingsStore.voice,
      rate: settingsStore.rate,
      pitch: settingsStore.pitch,
      volume: settingsStore.volume,
      lipsync: settingsStore.lipsyncInChat,
    });
    if (data.videoUrl) {
      if (data.matchedText && data.matchedText !== reply) { patchAi({ content: data.matchedText }); }
      chatStore.setState('speak');
      showVideo(data.videoUrl);
      const v = avatarStageRef.value?.figureVideoEl?.value;
      if (v) await waitVideoEnd(v);
    } else if (data.audioUrl) {
      chatStore.setState('speak');
      showStatic();
      await playAudio(data.audioUrl);
    }
  } catch (e) {
    console.error('[ParentChat] speak 失败:', e);
    showStatic();
  }

  chatStore.setState('idle');
  showStatic();
  chatStore.setInputEnabled(true);
}

function sendText() {
  const t = textInput.value.trim();
  if (!t) return;
  textInput.value = '';
  sendMessage(t);
}

function scrollChat() {
  nextTick(() => {
    const el = chatScrollRef.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

// ════════════════════════════════════════════
// 录音（按住说话）
// ════════════════════════════════════════════
const {
  asrProvider: recorderAsrProvider,
  recording,
  initASR,
  toggleMic,
  stopRecording,
} = useRecorder({
  onTranscript: (text, isFinal, source) => {
    if (!isFinal) { subtitle.value = text || ''; return; }
    if (text) { sendMessage(text); }
    else { showToast('没听清，再按住说一次', 2600); }
  },
  onError: (_msg) => {
    // 适老化：技术报错一律「稍后再试试」
    chatStore.setState('idle');
    showToast('没听清，稍后再试试，或在下面打字也行', 4000);
  },
  toast: showToast,
});

function micDown() {
  if (chatStore.busy || recording.value) return;
  subtitle.value = '';
  if (recorderAsrProvider.value === 'webspeech') chatStore.setState('listen');
  toggleMic(chatStore.busy);
}
function micUp() {
  if (recording.value) stopRecording();
}

// ════════════════════════════════════════════
// P4 回信轮询
// ════════════════════════════════════════════
async function pollReplies() {
  try {
    const list = await parentReplies();
    replies.value = Array.isArray(list) ? list : [];
  } catch (e) {
    console.error('[ParentReplies] 轮询失败:', e);
  }
}
function openLetter() {
  activeReply.value = replies.value[0] || null;
  if (!activeReply.value) return;
  showLetter.value = true;
  nextTick(() => replayLetter());
}
function replayLetter() {
  const r = activeReply.value;
  if (!r) return;
  if (r.replyVideo && letterVideoEl.value) {
    letterVideoEl.value.currentTime = 0;
    letterVideoEl.value.play().catch(() => {});
  } else if (r.childReplyAudio) {
    playAudio(r.childReplyAudio);
  }
}
async function closeLetter() {
  const r = activeReply.value;
  showLetter.value = false;
  if (r && r.id != null) {
    try { await markViewed(r.id); } catch (e) { console.error('[Letter] viewed 失败:', e); }
  }
  activeReply.value = null;
  await pollReplies();   // 刷新横幅（已读的应消失）
}

// ════════════════════════════════════════════
// 初始化
// ════════════════════════════════════════════
onMounted(async () => {
  // 时钟
  const tick = () => { clock.value = nowHHMM(); };
  tick();
  setInterval(tick, 30000);

  // 首次告知：localStorage twin_onboarded 无则显示 P1
  let onboarded = false;
  try { onboarded = !!localStorage.getItem(ONBOARD_KEY); } catch (_) {}
  screen.value = onboarded ? 'main' : 'onboard';

  chatStore.setState('idle');

  // 家庭信息：取 child nickname
  try {
    const fam = await getFamily();
    const members = (fam.family && fam.family.members) || fam.members || [];
    const child = members.find(m => m.role === 'child');
    if (child && child.nickname) childNickname.value = child.nickname;
  } catch (e) { console.error('[Parent] 家庭信息加载失败:', e); }

  // 形象：GET /api/avatar/config 的 figure
  try {
    const cfg = await getAvatarConfig();
    if (cfg.figure && (cfg.figure.localImage || cfg.figure.imageUrl)) {
      avatarStore.applyFigure(cfg.figure);
      figureSrc.value = avatarStore.figureSrc;
    }
  } catch (e) { console.error('[Parent] 形象加载失败:', e); }

  // ASR provider
  try {
    const h = await getHealth();
    if (h.asr && h.asr.provider) recorderAsrProvider.value = h.asr.provider;
  } catch (_) {}
  initASR();

  // 话术库（话题卡 + 欢迎视频）
  try {
    const items = await getSpeakCache();
    speakCacheItems.value = Array.isArray(items) ? items.filter(it => it.current !== false) : [];
    // 话题卡取话术库现有条目前 3 条（有缓存的才用其文案，否则保留默认三卡）
    const playable = speakCacheItems.value.filter(it => it.path && !(it.key || '').includes('welcome'));
    if (playable.length) {
      topicCards.value = playable.slice(0, 3).map(it => ({
        key: it.key,
        text: it.text && it.text.length > 12 ? it.text.slice(0, 11) + '…' : (it.text || '聊一聊'),
      }));
    }
  } catch (e) { console.error('[Parent] 话术库加载失败:', e); }

  nextTick(showStatic);

  // P4：进入即查 + 每 30s 轮询
  await pollReplies();
  replyTimer = setInterval(pollReplies, 30000);
});

onUnmounted(() => {
  if (replyTimer) clearInterval(replyTimer);
  stopRecording();
});
</script>

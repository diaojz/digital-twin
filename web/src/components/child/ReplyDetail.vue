<template>
  <!-- C3 回信详情 —— 原文 + AI 代答 + 按住录音 + 四态 stepper -->
  <!-- 父母原话 -->
  <div class="original-audio">
    <div class="oa-icon">{{ msg.type === 'alert' ? '🚨' : '👵' }}</div>
    <div class="oa-info">
      <div class="oa-label">{{ msg.type === 'leave_word' ? '原留言' : '原话' }}</div>
      <div class="oa-text">「{{ originalText }}」</div>
    </div>
  </div>

  <!-- AI 代答全文（可折叠展开）-->
  <div class="ai-draft" v-if="aiReply">
    <div class="ai-draft-label">🤖 AI 已代答 <span>（你的回信会覆盖它）</span></div>
    <div class="ai-draft-text">{{ aiReply }}</div>
  </div>

  <!-- 按住录音 ≤60s -->
  <button
    class="rec-btn"
    :class="{ recording }"
    :disabled="busy"
    @mousedown.prevent="startRec"
    @mouseup.prevent="stopRec"
    @mouseleave="recording && stopRec()"
    @touchstart.prevent="startRec"
    @touchend.prevent="stopRec"
  >
    <span style="font-size:24px;">🎤</span>
    <span v-if="recording">松开结束 · {{ recSecs }}s / 60s</span>
    <span v-else-if="busy">提交中…</span>
    <span v-else>按住录音回复（≤60 秒）</span>
  </button>

  <!-- 录音回放（提交前可试听）-->
  <div
    v-if="recordedUrl && !busy"
    style="display:flex;align-items:center;gap:10px;background:rgba(255,255,255,.7);border:1px solid var(--line);border-radius:12px;padding:8px 12px;margin-bottom:10px;"
  >
    <audio :src="recordedUrl" controls style="flex:1;height:32px;"></audio>
    <button class="btn ghost sm" style="margin:0;padding:6px 12px;flex:none;width:auto;" @click="submitReply">提交回信 →</button>
  </div>

  <!-- 四态 stepper -->
  <div class="status-stepper">
    <div class="step">
      <div class="step-dot" :class="dotClass(0)">{{ stepIndex > 0 ? '✓' : (stepIndex === 0 ? '●' : '✓') }}</div>
      <div class="step-label" :class="{ active: stepIndex === 0 }">待回复</div>
    </div>
    <div class="step-sep"></div>
    <div class="step">
      <div class="step-dot" :class="dotClass(1)">⏳</div>
      <div class="step-label" :class="{ active: stepIndex === 1 }">生成中<br>约 3 分钟</div>
    </div>
    <div class="step-sep"></div>
    <div class="step">
      <div class="step-dot" :class="dotClass(2)">✓</div>
      <div class="step-label" :class="{ active: stepIndex === 2 }">已送达</div>
    </div>
    <div class="step-sep"></div>
    <div class="step">
      <div class="step-dot" :class="dotClass(3)">👀</div>
      <div class="step-label" :class="{ active: stepIndex === 3 }">已看</div>
    </div>
  </div>

  <!-- 降级注记 -->
  <div
    v-if="isVoiceDelivered"
    style="font-size:10.5px;color:var(--orange);background:rgba(230,151,90,.09);border:1px solid rgba(230,151,90,.25);border-radius:10px;padding:6px 10px;margin-top:7px;line-height:1.5;text-align:left;"
  >
    ⚠️ 已降级语音送达（视频生成失败，爸妈只听到您的原声）
  </div>
  <div style="font-size:11px;color:var(--ink-faint);text-align:center;margin-top:5px;line-height:1.5;">
    用您的原声驱动视频，不经过 TTS · 效果更真实
  </div>
</template>

<script setup>
import { ref, computed, onBeforeUnmount, watch } from 'vue';
import { replyInbox, getInbox } from '../../api/client.js';

const props = defineProps({
  msg:   { type: Object,   required: true },
  toast: { type: Function, required: true },
});
const emit = defineEmits(['updated']);

const originalText = computed(() => props.msg.original_text || props.msg.originalText || '');
const aiReply      = computed(() => props.msg.ai_reply || props.msg.aiReply || '');

const status = ref(props.msg.status || 'pending');
watch(() => props.msg.status, (s) => { if (s) status.value = s; });

const isVoiceDelivered = computed(() => status.value === 'voice_delivered');

// 状态 → stepper index：pending=0 generating=1 delivered/voice_delivered=2 viewed=3
const stepIndex = computed(() => {
  switch (status.value) {
    case 'generating': return 1;
    case 'delivered':
    case 'voice_delivered': return 2;
    case 'viewed': return 3;
    default: return 0;
  }
});

function dotClass(i) {
  if (i < stepIndex.value) return 'done';
  if (i === stepIndex.value) return 'active';
  return 'idle';
}

// ── 录音（裸 MediaRecorder，不走 ASR）──
const recording   = ref(false);
const busy        = ref(false);
const recSecs     = ref(0);
const recordedUrl = ref('');
let mediaRecorder = null;
let mediaStream   = null;
let chunks        = [];
let recordedBlob  = null;
let secTimer      = null;
let maxTimer      = null;

async function startRec() {
  if (recording.value || busy.value) return;
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    props.toast('麦克风权限被拒，请允许后重试', 3500);
    return;
  }
  chunks = [];
  recordedBlob = null;
  if (recordedUrl.value) { URL.revokeObjectURL(recordedUrl.value); recordedUrl.value = ''; }
  mediaRecorder = new MediaRecorder(mediaStream);
  mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  mediaRecorder.onstop = () => {
    mediaStream.getTracks().forEach(t => t.stop());
    recordedBlob = new Blob(chunks, { type: 'audio/webm' });
    if (recordedBlob.size) recordedUrl.value = URL.createObjectURL(recordedBlob);
  };
  mediaRecorder.start();
  recording.value = true;
  recSecs.value = 0;
  secTimer = setInterval(() => { recSecs.value++; }, 1000);
  maxTimer = setTimeout(() => { if (recording.value) stopRec(); }, 60000);
}

function stopRec() {
  if (!recording.value) return;
  recording.value = false;
  clearInterval(secTimer); secTimer = null;
  clearTimeout(maxTimer); maxTimer = null;
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
}

function blobToDataUrl(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

let pollTimer = null;

async function submitReply() {
  if (!recordedBlob || !recordedBlob.size) { props.toast('先按住录一段回复'); return; }
  busy.value = true;
  try {
    const dataUrl = await blobToDataUrl(recordedBlob);
    const r = await replyInbox(props.msg.id, dataUrl);
    status.value = r.status || 'generating';
    props.toast('回信已提交，正在生成对口型视频…', 3000);
    emit('updated', { id: props.msg.id, status: status.value });
    startPoll();
  } catch (e) {
    props.toast('回信失败：' + (e.message || e), 3500);
    console.error('[ReplyDetail] 回信失败:', e);
  } finally {
    busy.value = false;
  }
}

function startPoll() {
  stopPoll();
  pollTimer = setInterval(async () => {
    try {
      const m = await getInbox(props.msg.id);
      // client.getInbox 返回整个响应体 {message:{...}}，状态在 m.message.status；
      // 兼容后端若某天直接返回 msg 的情况，回落 m.status
      const s = m?.message?.status || m?.status || status.value;
      if (s !== status.value) {
        status.value = s;
        emit('updated', { id: props.msg.id, status: s });
      }
      if (s === 'delivered' || s === 'voice_delivered' || s === 'viewed') stopPoll();
    } catch (_) { /* 轮询失败静默重试 */ }
  }, 5000);
}

function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

onBeforeUnmount(() => {
  stopPoll();
  if (secTimer) clearInterval(secTimer);
  if (maxTimer) clearTimeout(maxTimer);
  if (recording.value && mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  if (recordedUrl.value) URL.revokeObjectURL(recordedUrl.value);
});
</script>

<template>
  <div class="phone child">
    <div class="screen child-screen">
      <div class="notch"></div>
      <div class="statusbar">
        <span>{{ clock }}</span>
        <span>📶 🔋</span>
      </div>

      <!-- ════════ 五个 tab 模块 C1-C5 ════════ -->

      <!-- C1 分身工坊 -->
      <div class="view tabview" :class="{ on: tab === 'c1' }">
        <div class="topbar">
          <div class="iconbtn" @click="go('chat')">‹</div>
          <div class="title">分身工坊</div>
          <div class="iconbtn"></div>
        </div>
        <div class="scroll">
          <FigureSection :go="go" />
          <PersonaSection :go="go" :toast="showToast" :stopRecording="recorderStopRecording" />
          <VoiceSection />
          <div class="seg">🎙️ 声音复刻</div>
          <div class="card" style="padding:10px 14px;">
            <div style="display:flex;align-items:center;gap:8px;">
              <div class="rt" style="flex:1;">
                <div class="t1">用爸妈熟悉的声音</div>
                <div class="t2">把你的嗓音复刻成专属音色</div>
              </div>
              <div class="wc-badge v1" style="font-size:10px;font-weight:700;padding:3px 9px;border-radius:8px;background:rgba(139,108,240,.12);color:var(--p1);white-space:nowrap;">V1 即将支持复刻</div>
            </div>
          </div>

          <!-- 试看确认卡 -->
          <div class="seg">👀 试看确认</div>
          <TrialConfirmCard
            :confirmed="family.confirmed"
            :sample="trialSample"
            @confirm="onConfirm"
            @play="onPlaySample"
          />
          <div style="height:16px;"></div>
        </div>
      </div>

      <!-- C2 收件箱 -->
      <div class="view tabview" :class="{ on: tab === 'c2' }">
        <div class="topbar">
          <div class="title" style="margin-left:4px;">
            收件箱
            <span v-if="unreadCount > 0" style="font-size:11px;background:var(--red);color:#fff;padding:1px 7px;border-radius:8px;font-weight:700;">{{ unreadCount }}</span>
          </div>
          <div class="iconbtn" @click="loadInbox" title="刷新">↻</div>
        </div>
        <InboxSection :items="inbox" :loading="inboxLoading" @open="openReply" />
      </div>

      <!-- C3 回信详情 -->
      <div class="view tabview" :class="{ on: tab === 'c3' }">
        <div class="topbar">
          <div class="iconbtn" @click="backToInbox">‹</div>
          <div class="title">{{ activeMsg ? '回信' : '回信' }}</div>
          <div class="iconbtn"></div>
        </div>
        <div class="scroll" style="display:flex;flex-direction:column;">
          <ReplyDetail
            v-if="activeMsg"
            :key="activeMsg.id"
            :msg="activeMsg"
            :toast="showToast"
            @updated="onReplyUpdated"
          />
          <div v-else style="font-size:12px;color:var(--ink-faint);text-align:center;padding:40px 0;">
            从收件箱选一条消息进行回信
          </div>
        </div>
      </div>

      <!-- C4 话术库 -->
      <div class="view tabview" :class="{ on: tab === 'c4' }">
        <div class="topbar">
          <div class="title" style="margin-left:4px;">话术库</div>
          <div class="iconbtn"></div>
        </div>
        <div class="scroll">
          <SpeakBatchCard :toast="showToast" :onGenerated="onBatchGenerated" />
          <VideoProviderSection
            :toast="showToast"
            :refreshSpeakLib="refreshSpeakLib"
            :refreshQuickChips="refreshQuickChips"
          />
          <SpeakLibSection
            ref="speakLibRef"
            :toast="showToast"
            :refreshQuickChips="refreshQuickChips"
            :playVideo="playVideoFromLib"
          />
          <div style="height:16px;"></div>
        </div>
      </div>

      <!-- C5 家庭与成本 -->
      <div class="view tabview" :class="{ on: tab === 'c5' }">
        <div class="topbar">
          <div class="title" style="margin-left:4px;">家庭与成本</div>
          <div class="iconbtn" @click="loadFamily" title="刷新">↻</div>
        </div>
        <FamilyCostSection
          :family="family"
          :usage="usage"
          :provider="settingsStore.videoProvider"
          :loading="familyLoading"
          :toast="showToast"
          @refresh="loadFamily"
        />
      </div>

      <!-- ════════ 对话/试看播放视图（非 tab，从 C1/C4 进入）════════ -->
      <div class="view" :class="{ on: tab === 'chat' }">
        <div class="topbar">
          <div class="iconbtn" @click="go('c1')">‹</div>
          <div class="title">小忆 · <span>{{ chatStore.stateText() }}</span></div>
          <div class="iconbtn" @click="go('c1')">⚙️</div>
        </div>
        <AvatarStage ref="avatarStageRef" />
        <ChatPanel
          ref="chatPanelRef"
          :sendMessage="handleSendMessage"
          :recording="recording"
          :toggleMic="handleToggleMic"
          :asrProvider="recorderAsrProvider"
          :toast="showToast"
          :playLibEntry="handlePlayLibEntry"
          :go="go"
        />
      </div>

      <!-- 形象生成/上传（从 C1 FigureSection 进入）-->
      <div class="view" :class="{ on: tab === 'avatar' }">
        <div class="topbar">
          <div class="iconbtn" @click="go('c1')">‹</div>
          <div class="title">选择数字人形象</div>
          <div class="iconbtn"></div>
        </div>
        <div class="scroll">
          <div class="seg">当前形象</div>
          <div class="card" style="padding:12px 14px;">
            <div style="display:flex;gap:12px;align-items:center;">
              <img
                :src="avatarStore.figureSrc"
                style="width:60px;height:80px;border-radius:12px;object-fit:cover;background:linear-gradient(170deg,#cbb0ec,#f0cfdf);"
                alt=""
              >
              <div style="flex:1;min-width:0;">
                <div style="font-size:13px;font-weight:700;color:#4a3f70;">{{ avatarStore.avatarState }}</div>
                <div style="font-size:10.5px;color:var(--ink-faint);margin-top:3px;line-height:1.5;">生成后自动做人脸检测，缓存口型坐标，对话时复用</div>
              </div>
            </div>
          </div>

          <div class="seg">上传我的照片做形象</div>
          <input type="file" ref="photoFileRef" accept="image/*" style="display:none;" @change="onPhotoChange">
          <button class="btn" ref="uploadPhotoBtnRef" @click="photoFileRef.click()">📷 上传照片（对口型视频用这张脸）</button>
          <div class="card" style="margin-top:10px;padding:11px 14px;">
            <div style="font-size:11px;color:var(--ink-faint);line-height:1.6;">照片要求：单人、正面、五官清晰、无遮挡，jpg/png 均可，最短边 ≥ 400 像素。</div>
          </div>

          <div class="seg">提示词生成新形象</div>
          <div class="chips" style="margin-bottom:8px;">
            <div
              v-for="tpl in figureTpls"
              :key="tpl.label"
              class="chip"
              :class="{ on: figurePrompt === tpl.prompt }"
              @click="figurePrompt = tpl.prompt"
            >{{ tpl.label }}</div>
          </div>
          <textarea class="prompt-box" v-model="figurePrompt"></textarea>
          <button class="btn" :disabled="generatingFigure" @click="onGenFigure">
            {{ generatingFigure ? '✨ 生成中…请耐心等待' : '✨ 生成形象（约 30-60 秒）' }}
          </button>
          <button class="btn ghost" @click="onResetFigure">🗑️ 重置形象（清缓存，下次重新生成）</button>
          <div style="height:16px;"></div>
        </div>
      </div>

      <!-- 性格选择（从 C1 PersonaSection 进入）-->
      <div class="view" :class="{ on: tab === 'persona' }">
        <div class="topbar">
          <div class="iconbtn" @click="go('c1')">‹</div>
          <div class="title">选择性格</div>
          <div class="iconbtn"></div>
        </div>
        <div class="scroll">
          <div class="seg">预设性格</div>
          <div
            v-for="(p, key) in PERSONAS"
            :key="key"
            class="persona"
            :class="{ on: settingsStore.persona === key && !settingsStore.personaCustom.trim() }"
            @click="onSelectPersona(key)"
          >
            <span class="em">{{ p.em }}</span>
            <div>
              <div class="nm">{{ p.nm }}</div>
              <div class="ds">{{ p.ds }}</div>
            </div>
          </div>
          <div class="seg">自定义（作为 system prompt 注入）</div>
          <textarea
            class="prompt-box"
            v-model="settingsStore.personaCustom"
            placeholder="在这里写你想要的语气、口头禅、关心的话题…（留空则用上方预设）"
          ></textarea>
          <button class="btn" @click="savePersona">保存性格</button>
        </div>
      </div>

      <!-- ════════ 底部 tab 栏 ════════ -->
      <nav class="child-tabbar" v-if="isTab">
        <div class="ct-item" :class="{ on: tab === 'c1' }" @click="go('c1')">
          <span class="ct-i">🛠</span><span class="ct-l">工坊</span>
        </div>
        <div class="ct-item" :class="{ on: tab === 'c2' }" @click="go('c2')">
          <span class="ct-i">📥</span><span class="ct-l">收件箱</span>
          <span v-if="unreadCount > 0" class="ct-dot">{{ unreadCount }}</span>
        </div>
        <div class="ct-item" :class="{ on: tab === 'c4' }" @click="go('c4')">
          <span class="ct-i">🎬</span><span class="ct-l">话术库</span>
        </div>
        <div class="ct-item" :class="{ on: tab === 'c5' }" @click="go('c5')">
          <span class="ct-i">👨‍👩‍👧</span><span class="ct-l">家庭</span>
        </div>
      </nav>

      <Toast ref="toastRef" />
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import AvatarStage from '../../components/AvatarStage.vue';
import ChatPanel from '../../components/ChatPanel.vue';
import Toast from '../../components/Toast.vue';

import FigureSection from '../../components/settings/FigureSection.vue';
import PersonaSection from '../../components/settings/PersonaSection.vue';
import VoiceSection from '../../components/settings/VoiceSection.vue';
import VideoProviderSection from '../../components/settings/VideoProviderSection.vue';
import SpeakLibSection from '../../components/settings/SpeakLibSection.vue';

import InboxSection from '../../components/child/InboxSection.vue';
import ReplyDetail from '../../components/child/ReplyDetail.vue';
import FamilyCostSection from '../../components/child/FamilyCostSection.vue';
import TrialConfirmCard from '../../components/child/TrialConfirmCard.vue';
import SpeakBatchCard from '../../components/child/SpeakBatchCard.vue';

import { useChatStore } from '../../stores/chat.js';
import { useSettingsStore, PERSONAS } from '../../stores/settings.js';
import { useAvatarStore } from '../../stores/avatar.js';
import { useRecorder } from '../../composables/useRecorder.js';
import { useChatStream } from '../../composables/useChatStream.js';
import { useAudioQueue } from '../../composables/useAudioQueue.js';
import {
  getHealth, getAvatarConfig, getVideoProvider, getSpeakCache,
  generateFigure, uploadFigure, resetFigure,
  getFamily, confirmFamily, listInbox,
} from '../../api/client.js';

const chatStore     = useChatStore();
const settingsStore = useSettingsStore();
const avatarStore   = useAvatarStore();
const { waitVideoEnd } = useAudioQueue();

// DOM refs
const toastRef          = ref(null);
const avatarStageRef    = ref(null);
const chatPanelRef      = ref(null);
const speakLibRef       = ref(null);
const photoFileRef      = ref(null);
const uploadPhotoBtnRef = ref(null);

// 当前 tab：c1-c5 + 非 tab 子视图（chat/avatar/persona）+ c3 回信详情
const tab = ref('c1');
const TAB_VIEWS = ['c1', 'c2', 'c3', 'c4', 'c5'];
const isTab = computed(() => TAB_VIEWS.includes(tab.value));

const clock = ref('9:41');

// 形象页
const figurePrompt     = ref('一位温柔治愈的年轻亚洲女性，正面肖像，清晰五官，柔和自然微笑，简洁柔光纯色背景，写实摄影风格，高质量');
const generatingFigure = ref(false);
const figureTpls = [
  { label: '👩 温柔女性', prompt: '一位温柔治愈的年轻亚洲女性，正面肖像，清晰五官，柔和自然微笑，简洁柔光纯色背景，写实摄影风格，高质量' },
  { label: '👨 阳光男性', prompt: '一位阳光干净的年轻亚洲男性，正面肖像，清晰五官，自然微笑，简洁柔光纯色背景，写实摄影风格，高质量' },
];

// ── C2/C5 数据 ──
const inbox        = ref([]);
const inboxLoading = ref(false);
const family       = ref({ confirmed: false, members: [] });
const usage        = ref({});
const familyLoading = ref(false);
const activeMsg    = ref(null);

const unreadCount = computed(() =>
  inbox.value.filter(m =>
    (m.type === 'help' || m.type === 'alert') &&
    !['delivered', 'voice_delivered', 'viewed'].includes(m.status || 'pending'),
  ).length,
);

// 试看样本：话术库当前形象任一条
const trialSample = computed(() => {
  const list = avatarStore.speakLibItems || [];
  return list.find(it => it.current && it.path) || list.find(it => it.path) || null;
});

function showToast(msg, ms) { toastRef.value?.show(msg, ms); }

function go(view) {
  tab.value = view;
  if (view === 'chat') refreshQuickChips();
  if (view === 'c2') loadInbox();
  if (view === 'c4') refreshSpeakLib();
  if (view === 'c5') loadFamily();
  if (view === 'c1') refreshSpeakLib(); // 试看样本依赖话术库
}

function refreshSpeakLib() {
  speakLibRef.value?.refreshSpeakLib?.();
  // speakLibRef 仅在 c4 mount 时存在；c1 试看也需要列表
  getSpeakCache().then(items => { avatarStore.speakLibItems = items; }).catch(() => {});
}

// ── C2 收件箱 ──
async function loadInbox() {
  inboxLoading.value = true;
  try {
    inbox.value = await listInbox();
  } catch (e) {
    showToast('收件箱加载失败：' + (e.message || e), 3500);
    console.error('[Inbox] 加载失败:', e);
  } finally {
    inboxLoading.value = false;
  }
}

function openReply(m) {
  activeMsg.value = m;
  tab.value = 'c3';
}

function backToInbox() {
  activeMsg.value = null;
  go('c2');
}

function onReplyUpdated({ id, status }) {
  const m = inbox.value.find(x => x.id === id);
  if (m) m.status = status;
}

// ── C5 家庭 ──
async function loadFamily() {
  familyLoading.value = true;
  try {
    const data = await getFamily();
    // 后端形状：{ family:{id,name,confirmed,members:[...]}, usage:{...} }
    // 兼容可能的扁平形状（data 直接是 family）
    const fam = data.family || data || { confirmed: false, members: [] };
    // confirmed 规范成严格布尔（后端可能回 0/1）——门控与邀请按钮直接吃这个值
    fam.confirmed = !!fam.confirmed;
    family.value = fam;
    usage.value = data.usage || fam.usage || {};
  } catch (e) {
    showToast('家庭信息加载失败：' + (e.message || e), 3500);
    console.error('[Family] 加载失败:', e);
  } finally {
    familyLoading.value = false;
  }
}

// 跨端/跨标签页同步：在 /parent 完成试看确认后切回本页（或本页重新可见/聚焦）时，
// 自动重拉家庭状态——避免依赖手动点 ↻ 才放开 C5 的邀请按钮。
// 只在页面真正可见时拉，省请求；不弹错误 toast（静默同步）。
async function syncFamilyOnReveal() {
  if (document.visibilityState === 'hidden') return;
  try {
    const data = await getFamily();
    const fam = data.family || data || { confirmed: false, members: [] };
    fam.confirmed = !!fam.confirmed;
    family.value = fam;
    usage.value = data.usage || fam.usage || {};
  } catch (_) {
    // 静默：可见性触发的后台同步失败不打扰用户，手动 ↻ 仍可重试
  }
}

// ── C1 试看确认 ──
async function onConfirm() {
  try {
    await confirmFamily();
    family.value = { ...family.value, confirmed: true };
    showToast('已确认！现在可去「家庭」页生成邀请链接', 3500);
  } catch (e) {
    showToast('确认失败：' + (e.message || e), 3500);
    console.error('[Confirm] 失败:', e);
  }
}

function onPlaySample(it) {
  if (!it || !it.path) { showToast('先去话术库生成一条视频'); return; }
  handlePlayLibEntry(it);
}

// ── C4 批量生成回调 ──
function onBatchGenerated() {
  refreshSpeakLib();
  refreshQuickChips();
}

// ────────────────────────────────────────────
// 录音（聊天用，ASR）
// ────────────────────────────────────────────
const { asrProvider: recorderAsrProvider, recording, initASR, toggleMic, stopRecording: recorderStopRecording } = useRecorder({
  onTranscript: (text, isFinal, source) => {
    if (!isFinal) {
      if (chatPanelRef.value) chatPanelRef.value.setInputText(text || '');
      return;
    }
    if (text && (source === 'webspeech' || settingsStore.autoSend)) {
      handleSendMessage(text);
    } else if (text) {
      if (chatPanelRef.value) chatPanelRef.value.setInputText(text);
      showToast('识别完成，可改字后点 ➤ 发送', 2600);
    }
  },
  onError: (msg) => {
    chatStore.setState('idle');
    showToast(msg, 4500);
  },
  toast: showToast,
});

function handleToggleMic(busy) {
  if (!recording.value && recorderAsrProvider.value === 'webspeech') {
    chatStore.setState('listen');
  }
  toggleMic(busy);
}

// ── 舞台 ──
function showStatic() { avatarStageRef.value?.showStatic(); }
function showVideo(url) { avatarStageRef.value?.showVideo(url); }

// ── 聊天流 ──
const videoElProxy = ref(null);
const { sendMessage } = useChatStream({
  videoEl: videoElProxy,
  toast: showToast,
  showStatic,
  showVideo,
});

async function handleSendMessage(text) {
  if (avatarStageRef.value) {
    videoElProxy.value = avatarStageRef.value.figureVideoEl?.value || null;
  }
  await sendMessage(text);
  if (
    settingsStore.continuousMode &&
    recorderAsrProvider.value !== 'webspeech' &&
    !recording.value
  ) {
    setTimeout(() => {
      if (!chatStore.busy && !recording.value && tab.value === 'chat') {
        handleToggleMic(false);
      }
    }, 500);
  }
}

// ── 话术库 chips ──
async function refreshQuickChips() {
  try {
    const items = await getSpeakCache();
    avatarStore.quickChips = items.filter(
      it => it.current && (it.provider || 'emo') === settingsStore.videoProvider,
    );
  } catch (_) {}
}

function handlePlayLibEntry(it) {
  if (chatStore.busy) { showToast('小忆正在忙，稍候再点'); return; }
  if (tab.value !== 'chat') tab.value = 'chat';
  chatStore.addBubble('ai', it.text);
  chatStore.setState('speak');
  showVideo(it.path);
  const v = avatarStageRef.value?.figureVideoEl?.value;
  if (v) {
    waitVideoEnd(v).then(() => {
      chatStore.setState('idle');
      showStatic();
    });
  }
}

function playVideoFromLib(path) {
  tab.value = 'chat';
  showVideo(path);
  const v = avatarStageRef.value?.figureVideoEl?.value;
  if (v) {
    const onEnd = () => { v.removeEventListener('ended', onEnd); v.removeEventListener('error', onEnd); showStatic(); };
    v.addEventListener('ended', onEnd);
    v.addEventListener('error', onEnd);
  }
}

// ── 形象：生成 / 上传 / 重置 ──
async function onGenFigure() {
  if (chatStore.busy) { showToast('小忆正在忙，请稍候再生成'); return; }
  chatStore.setInputEnabled(false);
  generatingFigure.value = true;
  avatarStore.avatarState = '正在生成形象 + 人脸检测…';
  try {
    const data = await generateFigure(figurePrompt.value.trim(), settingsStore.ratio);
    avatarStore.applyFigure(data);
    if (data.detectError) {
      avatarStore.avatarState = '✅ 写实形象已就绪；对口型暂不可用（' + data.detectError + '）';
      showToast('形象已生成。对口型视频需在阿里云开通「EMO 悦动人像」服务', 4200);
    } else {
      avatarStore.avatarState = '✅ 形象已就绪，可以回对话页聊天了';
      showToast('形象生成成功！');
    }
  } catch (e) {
    avatarStore.avatarState = '❌ 生成失败：' + (e.message || e);
    showToast('生成失败：' + (e.message || e), 3500);
    console.error('[Figure] 生成失败:', e);
  } finally {
    generatingFigure.value = false;
    chatStore.setInputEnabled(true);
  }
}

async function onPhotoChange(e) {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  await handleUploadPhoto(f);
}

async function handleUploadPhoto(file) {
  if (chatStore.busy) {
    showToast('⏳ 小忆正在忙（对话或对口型生成中），等这一轮结束再选照片', 4500);
    avatarStore.avatarState = '⏳ 正在忙（对话/生成中），稍后再上传照片';
    return;
  }

  let dataUrl;
  try {
    const img = new Image();
    const objUrl = URL.createObjectURL(file);
    await new Promise((ok, bad) => {
      img.onload = ok;
      img.onerror = () => bad(new Error('图片读取失败，请换一张试试'));
      img.src = objUrl;
    });
    URL.revokeObjectURL(objUrl);
    const w = img.naturalWidth, h = img.naturalHeight;
    if (Math.min(w, h) < 400) { showToast('照片太小：最短边需 ≥ 400 像素', 3500); return; }
    let scale = Math.min(1, 960 / Math.max(w, h));
    scale = Math.max(scale, Math.min(1, 400 / Math.min(w, h)));
    const cv = document.createElement('canvas');
    cv.width = Math.round(w * scale); cv.height = Math.round(h * scale);
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    dataUrl = cv.toDataURL('image/jpeg', 0.85);
  } catch (e) {
    showToast(e.message || '图片处理失败', 4000);
    avatarStore.avatarState = '❌ 照片读取失败：若是 iPhone HEIC 格式，请导出为 JPG 再传，或换一张';
    return;
  }

  chatStore.setInputEnabled(false);
  const btn = uploadPhotoBtnRef.value;
  if (btn) btn.disabled = true;
  const upStart = Date.now();
  const upTimer = setInterval(() => {
    if (btn) btn.textContent = `📷 上传中… 已 ${Math.round((Date.now() - upStart) / 1000)} 秒`;
  }, 1000);
  if (btn) btn.textContent = '📷 上传 + 人脸检测中…';
  avatarStore.avatarState = '正在上传照片 + 人脸检测…（本地几秒；在线版约 20-60 秒，请勿关页面）';

  try {
    const data = await uploadFigure(dataUrl, settingsStore.ratio);
    avatarStore.applyFigure(data);
    if (data.detectError) {
      avatarStore.avatarState = '⚠️ 照片已设为形象；对口型不可用（' + data.detectError + '）';
      showToast('人脸检测未通过，换一张正面清晰的照片可重试', 4200);
    } else {
      avatarStore.avatarState = '✅ 我的照片已就绪，生成的视频会用这张脸';
      showToast('照片上传成功！如果是男性形象，记得去「声音」换成男声', 4500);
    }
  } catch (e) {
    avatarStore.avatarState = '❌ 上传失败：' + (e.message || e);
    showToast('上传失败：' + (e.message || e), 3500);
    console.error('[Figure] 上传失败:', e);
  } finally {
    clearInterval(upTimer);
    chatStore.setInputEnabled(true);
    if (btn) { btn.disabled = false; btn.textContent = '📷 上传照片（对口型视频用这张脸）'; }
  }
}

async function onResetFigure() {
  if (chatStore.busy) { showToast('忙着呢，稍候再重置'); return; }
  if (!confirm('确定重置当前形象？下次需要重新生成')) return;
  try {
    await resetFigure();
    avatarStore.resetFigureState();
    showStatic();
    showToast('形象已重置');
  } catch (e) {
    showToast('重置失败：' + (e.message || e));
    console.error('[Figure] 重置失败:', e);
  }
}

// ── 性格 ──
function onSelectPersona(key) {
  settingsStore.persona = key;
  settingsStore.personaCustom = '';
}
function savePersona() {
  showToast('性格已保存，下一轮对话生效');
  go('c1');
}

// ── 初始化 ──
onMounted(async () => {
  const tickClock = () => {
    const d = new Date();
    clock.value = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  };
  tickClock();
  setInterval(tickClock, 30000);

  chatStore.setState('idle');
  showStatic();

  try {
    const h = await getHealth();
    if (h.asr && h.asr.provider) recorderAsrProvider.value = h.asr.provider;
  } catch (_) {}
  initASR();

  try {
    const data = await getVideoProvider();
    settingsStore.videoProvider = data.current || 'emo';
    settingsStore.videoProviders = data.providers;
  } catch (e) {
    console.error('[VideoProvider] 状态加载失败:', e);
  }

  try {
    const cfg = await getAvatarConfig();
    if (cfg.figure && (cfg.figure.localImage || cfg.figure.imageUrl)) {
      avatarStore.applyFigure(cfg.figure);
    }
  } catch (_) {}

  // 首屏拉取话术库 + 收件箱 + 家庭
  refreshSpeakLib();
  await Promise.allSettled([loadInbox(), loadFamily()]);
  await refreshQuickChips();

  chatStore.addBubble('ai', '你来啦～我一直在这儿等你呢，今天还好吗？');
  chatStore.messages.push({ role: 'assistant', content: '你来啦～我一直在这儿等你呢，今天还好吗？' });

  // 跨端/跨标签页回到本页时静默重拉家庭状态（试看确认状态实时同步，无需手动 ↻）
  document.addEventListener('visibilitychange', syncFamilyOnReveal);
  window.addEventListener('focus', syncFamilyOnReveal);
});

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', syncFamilyOnReveal);
  window.removeEventListener('focus', syncFamilyOnReveal);
});
</script>

<style scoped>
/* tab 视图给底栏留出空间 */
.tabview { padding-bottom: 66px; }

/* 底部 tab 栏 */
.child-tabbar {
  position: absolute;
  left: 0; right: 0; bottom: 0;
  height: 58px;
  display: flex;
  align-items: stretch;
  background: rgba(255, 255, 255, .82);
  backdrop-filter: blur(14px);
  border-top: 1px solid rgba(140, 120, 210, .14);
  z-index: 60;
  padding: 4px 6px 6px;
}
.ct-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  cursor: pointer;
  position: relative;
  color: var(--ink-faint);
  border-radius: 12px;
  transition: .15s;
}
.ct-item.on { color: var(--p1); background: rgba(139, 108, 240, .08); }
.ct-i { font-size: 19px; line-height: 1; filter: grayscale(.2); }
.ct-item.on .ct-i { filter: none; }
.ct-l { font-size: 10px; font-weight: 700; }
.ct-dot {
  position: absolute;
  top: 4px; right: 50%;
  transform: translateX(18px);
  min-width: 15px; height: 15px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--red, #e05656);
  color: #fff;
  font-size: 9px; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
}
</style>

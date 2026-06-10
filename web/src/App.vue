<template>
  <div class="phone">
    <div class="screen">
      <div class="notch"></div>
      <div class="statusbar">
        <span>{{ clock }}</span>
        <span>📶 🔋</span>
      </div>

      <!-- ① 欢迎页 -->
      <div class="view welcome" :class="{ on: currentView === 'welcome' }">
        <div class="lgo">🌙</div>
        <h1>小忆数字人</h1>
        <div class="slo">一个会听你说话、会对口型回应的<br>写实陪伴形象 · 治愈系</div>
        <div class="feats">
          <div class="ft"><div class="fi">🧠</div><div class="fn">qwen3-max</div></div>
          <div class="ft"><div class="fi">🔊</div><div class="fn">龙婉女声</div></div>
          <div class="ft"><div class="fi">🎭</div><div class="fn">EMO 对口型</div></div>
        </div>
        <button class="btn" @click="go('chat')">进入对话 →</button>
        <button class="btn ghost" @click="go('avatar')">⚙️ 先去设置形象</button>
      </div>

      <!-- ② 对话页 -->
      <div class="view" :class="{ on: currentView === 'chat' }">
        <div class="topbar">
          <div class="iconbtn" @click="go('welcome')">‹</div>
          <div class="title">小忆 · <span>{{ chatStore.stateText() }}</span></div>
          <div class="iconbtn" @click="go('settings')">⚙️</div>
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

      <!-- ③ 设置页 -->
      <div class="view" :class="{ on: currentView === 'settings' }">
        <div class="topbar">
          <div class="iconbtn" @click="go('chat')">‹</div>
          <div class="title">数字人设置</div>
          <div class="iconbtn" @click="go('chat')">✓</div>
        </div>
        <div class="scroll">
          <SettingsDrawer
            ref="settingsDrawerRef"
            :go="go"
            :toast="showToast"
            :refreshQuickChips="refreshQuickChips"
            :playVideo="playVideoFromLib"
            :stopRecording="recorderStopRecording"
          />
        </div>
      </div>

      <!-- ④ 形象选择/生成 -->
      <div class="view" :class="{ on: currentView === 'avatar' }">
        <div class="topbar">
          <div class="iconbtn" @click="go('chat')">‹</div>
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
            <div style="font-size:11px;color:var(--ink-faint);line-height:1.6;">照片要求：单人、正面、五官清晰、无遮挡，jpg/png 均可，最短边 ≥ 400 像素。上传后会自动做人脸检测，通过后生成的视频就是照片里的你。</div>
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
          <div class="card" style="margin-top:10px;padding:11px 14px;">
            <div style="font-size:11px;color:var(--ink-faint);line-height:1.6;">提示：形象生成后会下载到本地永久缓存，下次打开直接复用、不重复生成；想换形象点「重置」再生成。</div>
          </div>
        </div>
      </div>

      <!-- ⑤ 性格选择 -->
      <div class="view" :class="{ on: currentView === 'persona' }">
        <div class="topbar">
          <div class="iconbtn" @click="go('settings')">‹</div>
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

      <Toast ref="toastRef" />
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import AvatarStage from './components/AvatarStage.vue';
import ChatPanel from './components/ChatPanel.vue';
import SettingsDrawer from './components/SettingsDrawer.vue';
import Toast from './components/Toast.vue';

import { useChatStore } from './stores/chat.js';
import { useSettingsStore, PERSONAS } from './stores/settings.js';
import { useAvatarStore } from './stores/avatar.js';
import { useRecorder } from './composables/useRecorder.js';
import { useChatStream } from './composables/useChatStream.js';
import { useAudioQueue } from './composables/useAudioQueue.js';
import {
  getHealth, getAvatarConfig, getVideoProvider, getSpeakCache,
  generateFigure, uploadFigure, resetFigure,
} from './api/client.js';

const chatStore     = useChatStore();
const settingsStore = useSettingsStore();
const avatarStore   = useAvatarStore();
const { waitVideoEnd } = useAudioQueue();

// DOM refs
const toastRef          = ref(null);
const avatarStageRef    = ref(null);
const settingsDrawerRef = ref(null);
const chatPanelRef      = ref(null);
const photoFileRef      = ref(null);
const uploadPhotoBtnRef = ref(null);

// 视图（局部 ref，需要 .value）
const currentView = ref('welcome');

// 时钟（局部 ref）
const clock = ref('9:41');

// 形象页（局部 ref）
const figurePrompt     = ref('一位温柔治愈的年轻亚洲女性，正面肖像，清晰五官，柔和自然微笑，简洁柔光纯色背景，写实摄影风格，高质量');
const generatingFigure = ref(false);

const figureTpls = [
  { label: '👩 温柔女性', prompt: '一位温柔治愈的年轻亚洲女性，正面肖像，清晰五官，柔和自然微笑，简洁柔光纯色背景，写实摄影风格，高质量' },
  { label: '👨 阳光男性', prompt: '一位阳光干净的年轻亚洲男性，正面肖像，清晰五官，自然微笑，简洁柔光纯色背景，写实摄影风格，高质量' },
];

// Toast
function showToast(msg, ms) {
  toastRef.value?.show(msg, ms);
}

// 视图切换
function go(view) {
  currentView.value = view;
  if (view === 'settings') {
    settingsDrawerRef.value?.refreshSpeakLib();
  }
  if (view === 'chat') {
    refreshQuickChips();
  }
}

// ────────────────────────────────────────────
// 录音
// ────────────────────────────────────────────
const { asrProvider: recorderAsrProvider, recording, initASR, toggleMic, stopRecording: recorderStopRecording } = useRecorder({
  onTranscript: (text, isFinal, source) => {
    if (!isFinal) {
      // webspeech 实时填字
      if (chatPanelRef.value) chatPanelRef.value.setInputText(text || '');
      return;
    }
    // 旧版语义：webspeech 说完无条件发送；autoSend 开关只作用于 whisper 路径
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

// ────────────────────────────────────────────
// 舞台显示控制
// ────────────────────────────────────────────
function showStatic() {
  avatarStageRef.value?.showStatic();
}

function showVideo(url) {
  avatarStageRef.value?.showVideo(url);
}

// ────────────────────────────────────────────
// 聊天流（视频 el 通过 ref 懒获取）
// ────────────────────────────────────────────
// 用一个 reactive ref 对象桥接，useChatStream 需要 ref 包装
const videoElProxy = ref(null);

function getVideoElRef() {
  // 每次发消息前更新
  if (avatarStageRef.value) {
    videoElProxy.value = avatarStageRef.value.figureVideoEl?.value || null;
  }
  return videoElProxy;
}

const { sendMessage } = useChatStream({
  videoEl: videoElProxy,
  toast: showToast,
  showStatic,
  showVideo,
});

async function handleSendMessage(text) {
  // 更新 videoEl
  if (avatarStageRef.value) {
    videoElProxy.value = avatarStageRef.value.figureVideoEl?.value || null;
  }
  await sendMessage(text);
  // 持续对话：回复完自动开麦
  if (
    settingsStore.continuousMode &&
    recorderAsrProvider.value !== 'webspeech' &&
    !recording.value
  ) {
    setTimeout(() => {
      if (!chatStore.busy && !recording.value && currentView.value === 'chat') {
        handleToggleMic(false);
      }
    }, 500);
  }
}

// ────────────────────────────────────────────
// 话术库 chips
// ────────────────────────────────────────────
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
  if (currentView.value !== 'chat') go('chat');
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
  go('chat');
  showVideo(path);
  const v = avatarStageRef.value?.figureVideoEl?.value;
  if (v) {
    const onEnd = () => { v.removeEventListener('ended', onEnd); v.removeEventListener('error', onEnd); showStatic(); };
    v.addEventListener('ended', onEnd);
    v.addEventListener('error', onEnd);
  }
}

// ────────────────────────────────────────────
// 形象：生成 / 上传 / 重置
// ────────────────────────────────────────────
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
      showToast('照片上传成功！如果是男性形象，记得去「设置 → 音色」换成男声', 4500);
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

// ────────────────────────────────────────────
// 性格
// ────────────────────────────────────────────
function onSelectPersona(key) {
  settingsStore.persona = key;
  settingsStore.personaCustom = '';
}

function savePersona() {
  showToast('性格已保存，下一轮对话生效');
  go('settings');
}

// ────────────────────────────────────────────
// 初始化
// ────────────────────────────────────────────
onMounted(async () => {
  // 时钟
  const tickClock = () => {
    const d = new Date();
    clock.value = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  };
  tickClock();
  setInterval(tickClock, 30000);

  // 初始状态
  chatStore.setState('idle');
  showStatic();

  // 获取 ASR provider
  try {
    const h = await getHealth();
    if (h.asr && h.asr.provider) recorderAsrProvider.value = h.asr.provider;
  } catch (_) {}
  initASR();

  // 拉取视频 provider
  try {
    const data = await getVideoProvider();
    settingsStore.videoProvider = data.current || 'emo';
    settingsStore.videoProviders = data.providers;
  } catch (e) {
    console.error('[VideoProvider] 状态加载失败:', e);
  }

  // 拉取已缓存形象
  try {
    const cfg = await getAvatarConfig();
    if (cfg.figure && (cfg.figure.localImage || cfg.figure.imageUrl)) {
      avatarStore.applyFigure(cfg.figure);
    }
    await refreshQuickChips();
  } catch (_) {}

  // 开场白
  chatStore.addBubble('ai', '你来啦～我一直在这儿等你呢，今天还好吗？');
  chatStore.messages.push({ role: 'assistant', content: '你来啦～我一直在这儿等你呢，今天还好吗？' });
});
</script>

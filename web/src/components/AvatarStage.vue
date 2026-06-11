<template>
  <!-- 舞台：静态图/视频/状态徽章/波形/生成遮罩 -->
  <div class="stage" :class="[stageClass, { s2v: isS2V }]" ref="stageEl">
    <span class="moon">🌙</span>
    <span class="star" style="left:20%;top:30px;width:4px;height:4px"></span>
    <span class="star" style="left:74%;top:22px;width:3px;height:3px;animation-delay:1s"></span>
    <span class="star" style="left:86%;top:70px;width:5px;height:5px;animation-delay:.5s"></span>
    <span class="avatar-tag">小忆</span>
    <div class="statepill" :class="pillClass">{{ chatStore.stateLabel() }}</div>

    <!-- 静态形象图 -->
    <img
      class="figure-img"
      :class="{ on: showImg }"
      :src="avatarStore.figureSrc"
      ref="figureImgEl"
      alt="数字人形象"
    >
    <!-- 对口型视频 -->
    <video
      class="figure-video"
      :class="{ on: showingVideo }"
      ref="figureVideoEl"
      playsinline
    ></video>
    <!-- 占位 -->
    <div class="placeholder" :class="{ hide: hidePlaceholder }">
      <div class="face">👩🏻</div>
    </div>

    <!-- 全身模式字幕：正在说的话悬浮人物下方，透明渐变蒙版垫底 -->
    <div v-if="captionOn" class="stage-caption on">{{ avatarStore.caption }}</div>

    <div class="mic-zone">
      <!-- 字幕显示期间隐藏声波条，避免和文字叠在一起 -->
      <div class="wave" :class="{ on: showWave && !captionOn }">
        <i></i><i></i><i></i><i></i><i></i>
      </div>
    </div>

    <!-- 生成中遮罩 -->
    <div class="gen-mask" :class="{ on: chatStore.uiState === 'gen' }">
      <div class="gen-ring"></div>
      <div class="gt">{{ isS2V ? '形象正在生成全身视频…' : '形象正在对口型…' }}</div>
      <div class="gs">{{ genSubText }}</div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useChatStore } from '../stores/chat.js';
import { useAvatarStore } from '../stores/avatar.js';
import { useSettingsStore } from '../stores/settings.js';

const chatStore   = useChatStore();
const avatarStore = useAvatarStore();
const settingsStore = useSettingsStore();

// 全身 provider（wan2.2-s2v）：舞台拉高、人物 contain 完整入镜、启用字幕蒙版
const isS2V = computed(() => settingsStore.videoProvider === 'wans2v');
const captionOn = computed(() => isS2V.value && !!avatarStore.caption);

// 视频元素（暴露给父组件）
const figureVideoEl = ref(null);
const figureImgEl   = ref(null);

// 视频是否正在显示
const showingVideo = ref(false);

const stageClass = computed(() => 's-' + chatStore.uiState);

const pillClass = computed(() => {
  const s = chatStore.uiState;
  return s === 'idle' ? '' : s;
});

const showWave = computed(() => chatStore.uiState === 'listen' || chatStore.uiState === 'speak');

// 是否显示静态图
const showImg = computed(() => {
  if (showingVideo.value) return false;
  return avatarStore.figureReady && !!avatarStore.figureSrc;
});

// 是否隐藏占位
const hidePlaceholder = computed(() => {
  return showingVideo.value || (avatarStore.figureReady && !!avatarStore.figureSrc);
});

// gen-mask 进度文字（默认文案按当前 provider）
function defaultGenSub() {
  return isS2V.value
    ? '万相全身视频生成中 · 官方约 5-10 分钟（短句更快）'
    : 'EMO 生成视频中 · 约需十几秒到一两分钟';
}
const genSubText = ref(defaultGenSub());
function onGenProgress(e) {
  genSubText.value = e.detail;
}
onMounted(() => {
  document.addEventListener('gen-progress', onGenProgress);
});
onUnmounted(() => {
  document.removeEventListener('gen-progress', onGenProgress);
});

// 当状态回到 idle/think 或切换 provider 时重置 genSubText
watch(() => chatStore.uiState, (s) => {
  if (s === 'idle' || s === 'think') {
    genSubText.value = defaultGenSub();
  }
});
watch(isS2V, () => { genSubText.value = defaultGenSub(); });

// 对外提供 showStatic / showVideo 方法
function showStatic() {
  showingVideo.value = false;
  avatarStore.caption = '';   // 回到静态待机 → 收起舞台字幕
  if (figureVideoEl.value) {
    figureVideoEl.value.pause();
  }
}

function showVideo(url) {
  showingVideo.value = true;
  const v = figureVideoEl.value;
  if (!v) return;
  v.src = url;
  v.muted = false;
  const p = v.play();
  if (p) p.catch(() => {});
}

defineExpose({ figureVideoEl, showStatic, showVideo });
</script>

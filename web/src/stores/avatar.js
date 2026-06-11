/**
 * avatar store —— figure（形象）、speakLib（话术库）、quickChips
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';

export const useAvatarStore = defineStore('avatar', () => {
  // 形象相关
  const figureReady  = ref(false);
  const figureSrc    = ref('');      // 显示用 URL（localImage?v=version 或 imageUrl）
  const figureName   = ref('当前：小忆（默认美女）'); // 设置页展示文字
  const avatarState  = ref('尚未生成 · 用下方提示词生成'); // 形象页状态文字
  const figureSource = ref('');      // 'genfigure' | 'upload'
  const figureVersion = ref(null);   // version 时间戳（用于 cache busting 和 figVer 比对）

  // 话术库列表（设置页展示）
  const speakLibItems = ref([]);
  // 聊天页快捷 chips（当前形象 + provider 过滤后的话术库条目）
  const quickChips = ref([]);
  // 舞台字幕：全身 provider（wans2v）播放时正在说的话，悬浮人物下方（AvatarStage 渲染）
  const caption = ref('');

  function applyFigure(fig) {
    // fig: {localImage?, imageUrl, version?, source?}
    const src = fig.localImage
      ? fig.localImage + '?v=' + (fig.version || '')
      : fig.imageUrl;
    figureReady.value  = true;
    figureSrc.value    = src;
    figureVersion.value = fig.version || null;
    figureSource.value  = fig.source || 'genfigure';
    figureName.value   = fig.source === 'upload' ? '当前：我的照片' : '当前：小忆（已生成）';
  }

  function resetFigureState() {
    figureReady.value  = false;
    figureSrc.value    = '';
    figureVersion.value = null;
    figureSource.value  = '';
    figureName.value   = '当前：小忆（默认美女）';
    avatarState.value  = '已重置 · 用下方提示词重新生成';
  }

  return {
    figureReady, figureSrc, figureName, avatarState,
    figureSource, figureVersion,
    speakLibItems, quickChips,
    applyFigure, resetFigureState,
  };
});

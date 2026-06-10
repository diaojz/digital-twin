<template>
  <!-- 形象图片 -->
  <div class="seg">🖼️ 形象图片</div>
  <div class="card">
    <div class="row" style="cursor:pointer;" @click="go('avatar')">
      <div class="ri">🖼️</div>
      <div class="rt">
        <div class="t1">{{ avatarStore.figureName }}</div>
        <div class="t2">写实形象 · 生成后本地缓存</div>
      </div>
      <div class="pick">管理 ›</div>
    </div>
  </div>
</template>

<script setup>
import { useAvatarStore } from '../../stores/avatar.js';

const avatarStore = useAvatarStore();
const props = defineProps({
  go: { type: Function, required: true },
});
</script>

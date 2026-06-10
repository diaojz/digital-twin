<template>
  <div class="toast" :class="{ on: visible }">{{ message }}</div>
</template>

<script setup>
import { ref } from 'vue';

const visible = ref(false);
const message = ref('');
let timer = null;

function show(msg, ms = 2600) {
  message.value = msg;
  visible.value = true;
  clearTimeout(timer);
  timer = setTimeout(() => { visible.value = false; }, ms);
}

defineExpose({ show });
</script>

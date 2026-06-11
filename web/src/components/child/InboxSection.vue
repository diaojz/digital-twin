<template>
  <!-- C2 收件箱 —— 四色左边条列表 -->
  <div class="inbox-list">
    <div v-if="loading && items.length === 0" style="font-size:12px;color:var(--ink-faint);text-align:center;padding:24px 0;">
      加载中…
    </div>
    <div v-else-if="items.length === 0" style="font-size:12px;color:var(--ink-faint);text-align:center;padding:24px 0;line-height:1.6;">
      还没有求助或告警<br>日常闲聊不会出现在这里
    </div>

    <div
      v-for="m in items"
      :key="m.id"
      class="inbox-item"
      :class="itemClass(m)"
      style="cursor:pointer;"
      @click="$emit('open', m)"
    >
      <div class="ii-top">
        <div class="ii-icon">{{ typeIcon(m) }}</div>
        <div class="ii-title">{{ titleOf(m) }}</div>
        <div class="ii-time">{{ timeOf(m) }}</div>
        <div class="ii-badge" :class="badgeClass(m)">{{ badgeText(m) }}</div>
        <div
          v-if="m.reminded && isPending(m)"
          class="ii-badge"
          style="background:rgba(230,151,90,.18);color:#8a4800;margin-left:4px;white-space:nowrap;"
        >🔔 已提醒</div>
      </div>
      <div
        class="ii-text"
        :style="m.type === 'alert' ? 'font-size:12.5px;color:#9a2020;font-weight:600;' : ''"
      >{{ m.original_text || m.originalText || '' }}</div>

      <!-- AI 已先回（折叠摘要）-->
      <div
        v-if="aiReplyOf(m)"
        class="ii-ai-reply"
      >
        <div class="ii-ai-label">AI 已先回 · 可纠正</div>
        {{ summarize(aiReplyOf(m)) }}
      </div>
    </div>
  </div>

  <div class="inbox-footer">日常闲聊不会出现在这里，只有求助和告警</div>
</template>

<script setup>
defineProps({
  items:   { type: Array,   default: () => [] },
  loading: { type: Boolean, default: false },
});
defineEmits(['open']);

const TYPE_ICON = { alert: '🚨', help: '🛠', leave_word: '💜' };
const TYPE_TITLE = { alert: '健康告警', help: '求助', leave_word: '留言' };

function typeIcon(m)  { return TYPE_ICON[m.type] || '💬'; }
function titleOf(m)   {
  if (m.type === 'alert') return '健康告警';
  if (m.type === 'leave_word') return '留言';
  return '求助'; // help
}

function isPending(m) { return (m.status || 'pending') === 'pending'; }
function isReplied(m) {
  const s = m.status || 'pending';
  return s === 'delivered' || s === 'voice_delivered' || s === 'viewed';
}

/** 左边条颜色：alert 红 / help 待回 橙 / 已回 绿 / leave_word 紫 */
function itemClass(m) {
  if (m.type === 'alert') return 'alert';
  if (m.type === 'leave_word') return 'leave';
  // help：未回橙、已回绿
  return isReplied(m) ? 'done' : 'help';
}

function badgeClass(m) {
  if (m.type === 'alert') return 'urgent';
  if (m.type === 'leave_word') return '';
  return isReplied(m) ? 'replied' : 'need';
}
function badgeText(m) {
  if (m.type === 'alert') return '紧急';
  if (m.type === 'leave_word') return '留言';
  if (!isReplied(m)) return '待回信';
  if ((m.status || '') === 'viewed') return '✓ 已看';
  if ((m.status || '') === 'voice_delivered') return '✓ 语音送达';
  return '✓ 已回信';
}

function aiReplyOf(m) { return m.ai_reply || m.aiReply || ''; }

function summarize(t) {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  return s.length > 40 ? s.slice(0, 40) + '…' : s;
}

function timeOf(m) {
  const ts = m.created_at || m.createdAt;
  if (!ts) return '';
  const d = new Date(typeof ts === 'number' ? ts : Date.parse(ts));
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return sameDay ? `${hh}:${mm}` : `${d.getMonth() + 1}/${d.getDate()}`;
}
</script>

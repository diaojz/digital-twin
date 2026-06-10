/**
 * useRecorder —— 录音 + VAD + 双 ASR 路径
 * 封装旧版 toggleMic / toggleMicWhisper / startVAD / stopVAD / autoStopRecording
 */
import { ref } from 'vue';

export function useRecorder({ onTranscript, onError, toast }) {
  // 当前 ASR provider（由 /api/health 注入，默认 webspeech）
  const asrProvider = ref('webspeech');
  const recording = ref(false);

  // webspeech 内部引用
  let recog = null;
  let lastHeard = '';   // webspeech 最后一次识别到的文本（onend 时据此发送）
  let asrError = null;

  // whisper / dashscope 内部引用
  let mediaRecorder = null;
  let mediaStream = null;
  let audioChunks = [];

  // VAD
  let vadCtx = null;
  let vadRAF = null;

  // ────────────────────────────────────────────
  // WebSpeech 初始化
  // ────────────────────────────────────────────
  function initASR() {
    if (asrProvider.value !== 'webspeech') return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    recog = new SR();
    recog.lang = 'zh-CN';
    recog.interimResults = true;
    recog.continuous = false;

    recog.onresult = e => {
      let interim = '', finalText = '';
      for (let i = 0; i < e.results.length; i++) {
        const tr = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += tr; else interim += tr;
      }
      // 实时回调（interim 或 final），并缓存最后听到的内容——onend 时靠它发送
      lastHeard = finalText || interim;
      onTranscript(lastHeard, false);
    };

    recog.onend = () => {
      recording.value = false;
      const finalTxt = lastHeard.trim();
      lastHeard = '';
      if (asrError) { asrError = null; return; }
      // webspeech 在 onend 才能确定识别结束。旧版语义：说完无条件发送（autoSend 开关只管 whisper 路径）
      onTranscript(finalTxt, true, 'webspeech');
    };

    recog.onerror = e => {
      asrError = (e && e.error) || 'unknown';
      recording.value = false;
      const MSG = {
        network: '连不上语音识别服务😣 Web Speech 依赖谷歌后端，大陆网络常连不上。建议用文字输入，或改用本地 Whisper。',
        'not-allowed': '麦克风权限被拒，请点地址栏左侧 🔒 允许麦克风后重试',
        'service-not-allowed': '系统/浏览器禁用了语音识别，建议用文字输入',
        'no-speech': '没听到说话声，靠近麦克风再说一次',
        'audio-capture': '没找到可用麦克风，检查一下设备',
        aborted: null,
      };
      const m = Object.prototype.hasOwnProperty.call(MSG, asrError) ? MSG[asrError] : ('语音识别出错：' + asrError);
      if (m) onError(m);
    };
  }

  // ────────────────────────────────────────────
  // 对外接口：toggleMic
  // ────────────────────────────────────────────
  function toggleMic(busy) {
    if (asrProvider.value !== 'webspeech') {
      return toggleMicWhisper(busy);
    }
    if (!recog) {
      onError('此浏览器不支持语音输入，请用文字');
      return;
    }
    if (busy && !recording.value) return;
    if (recording.value) {
      recog.stop();
      return;
    }
    try {
      asrError = null;
      recording.value = true;
      recog.start();
    } catch (e) {
      recording.value = false;
    }
  }

  // ────────────────────────────────────────────
  // Whisper / dashscope 模式
  // ────────────────────────────────────────────
  async function toggleMicWhisper(busy) {
    if (recording.value) {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
      return;
    }
    if (busy) return;

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      onError('麦克风权限被拒或无可用设备，请允许麦克风后重试');
      return;
    }

    audioChunks = [];
    mediaRecorder = new MediaRecorder(mediaStream);
    mediaRecorder.ondataavailable = e => {
      if (e.data && e.data.size) audioChunks.push(e.data);
    };
    mediaRecorder.onstop = async () => {
      stopVAD();
      mediaStream.getTracks().forEach(t => t.stop());
      recording.value = false;

      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      if (!blob.size) {
        onError('没录到声音，再说一次');
        return;
      }

      // 上传到后端 /api/asr 识别
      try {
        const fd = new FormData();
        fd.append('audio', blob, 'rec.webm');
        const r = await fetch('/api/asr', { method: 'POST', body: fd });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || '识别失败');
        const txt = (data.text || '').trim();
        if (txt) {
          onTranscript(txt, true, 'whisper');
        } else {
          onError('没识别到内容，靠近麦克风再说一次');
        }
      } catch (e) {
        onError('语音识别失败：' + (e.message || e));
      }
    };

    mediaRecorder.start();
    recording.value = true;
    startVAD(mediaStream);
    toast('开始说话…讲完停一下会自动发送（也可点麦克风手动结束）', 2600);
  }

  // ────────────────────────────────────────────
  // VAD 静音检测
  // ────────────────────────────────────────────
  function startVAD(stream) {
    try {
      vadCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = vadCtx.createMediaStreamSource(stream);
      const analyser = vadCtx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      let hasSpoken = false, silenceStart = 0;
      const SILENCE_MS = 1400, THRESHOLD = 14, NO_SPEECH_MS = 8000;
      const startedAt = performance.now();
      const tick = () => {
        if (!recording.value) { stopVAD(); return; }
        analyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const avg = sum / data.length;
        const now = performance.now();
        if (avg > THRESHOLD) {
          hasSpoken = true; silenceStart = 0;
        } else if (hasSpoken) {
          if (!silenceStart) silenceStart = now;
          else if (now - silenceStart > SILENCE_MS) { autoStopRecording(); return; }
        }
        if (!hasSpoken && now - startedAt > NO_SPEECH_MS) { autoStopRecording(); return; }
        if (now - startedAt > 30000) { autoStopRecording(); return; }
        vadRAF = requestAnimationFrame(tick);
      };
      vadRAF = requestAnimationFrame(tick);
    } catch (e) { /* VAD 不可用不影响手动点结束 */ }
  }

  function autoStopRecording() {
    stopVAD();
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  }

  function stopVAD() {
    if (vadRAF) { cancelAnimationFrame(vadRAF); vadRAF = null; }
    if (vadCtx) { try { vadCtx.close(); } catch (_) {} vadCtx = null; }
  }

  // 停止录音（外部调用，如关闭「持续对话」时）
  function stopRecording() {
    if (recording.value && mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    if (recog) {
      try { recog.stop(); } catch (_) {}
    }
    stopVAD();
    recording.value = false;
  }

  return {
    asrProvider,
    recording,
    initASR,
    toggleMic,
    stopRecording,
  };
}

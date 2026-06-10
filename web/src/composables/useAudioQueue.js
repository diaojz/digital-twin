/**
 * TTS 音频播放 + 对口型视频等待
 * 两个函数都是 Promise，和旧版 playAudio / waitVideoEnd 语义一致
 */
export function useAudioQueue() {
  /**
   * 播放音频 URL，resolve on ended or error
   */
  function playAudio(url) {
    return new Promise(res => {
      const a = new Audio(url);
      a.onended = res;
      a.onerror = res;
      a.play().catch(res);
    });
  }

  /**
   * 等待 <video> 播完，resolve on ended or error
   * @param {HTMLVideoElement} videoEl
   */
  function waitVideoEnd(videoEl) {
    return new Promise(res => {
      const done = () => {
        videoEl.removeEventListener('ended', done);
        videoEl.removeEventListener('error', done);
        res();
      };
      videoEl.addEventListener('ended', done);
      videoEl.addEventListener('error', done);
    });
  }

  return { playAudio, waitVideoEnd };
}

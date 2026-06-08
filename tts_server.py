"""
数字分身助手 - Kokoro TTS 服务（阶段 1）

用法：
  # 必须用 Python 3.12，不能用系统 Python（3.14 装不上 mlx-audio）
  uv venv --python 3.12 .venv-tts
  uv pip install --python .venv-tts mlx-audio "misaki[zh]" fastapi uvicorn

  # 启动服务（保持终端开着）
  .venv-tts/bin/python tts_server.py

  # 默认监听 http://127.0.0.1:8000
  # Node server.js 通过 TTS_SERVICE_URL 自动找到这里

架构说明：
  模型只加载一次（在 startup 事件中），后续每次请求共享同一个模型实例。
  这样避免了每次请求都重新加载 400MB+ 模型的巨大延迟。
  单句合成约 0.1-0.3s（M2 Max 实测）。

中文音色选项：
  zf_xiaoxiao  - 女声（推荐，自然流畅）
  zm_yunxi     - 男声
  zf_xiaoyi    - 女声（另一种风格）
"""

import io
import struct
import numpy as np
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel


# ── 全局模型实例（只加载一次）────────────────────────────────
_model = None
_zh_g2p = None  # 中文 G2P（字母转音素，misaki[zh] 提供）


@asynccontextmanager
async def lifespan(app: FastAPI):
    """在服务启动时加载模型，服务停止时清理"""
    global _model, _zh_g2p

    print("[TTS] 正在加载 Kokoro-82M 模型，首次启动约需 10-30 秒...")
    try:
        from mlx_audio.tts.utils import load_model
        _model = load_model("mlx-community/Kokoro-82M-bf16")
        print("[TTS] Kokoro 模型加载成功")
    except ImportError as e:
        print(f"[TTS] 警告：无法导入 mlx-audio：{e}")
        print("[TTS] 请确认：.venv-tts/bin/pip install mlx-audio")
        _model = None

    try:
        from misaki import zh as misaki_zh
        _zh_g2p = misaki_zh
        print("[TTS] misaki[zh] 中文 G2P 加载成功")
    except ImportError as e:
        print(f"[TTS] 警告：无法导入 misaki[zh]：{e}")
        print("[TTS] 请确认：.venv-tts/bin/pip install 'misaki[zh]'")
        _zh_g2p = None

    yield  # 服务运行期间

    # 服务停止时（可选清理）
    print("[TTS] 服务停止")


app = FastAPI(title="Kokoro TTS 服务", lifespan=lifespan)


class TTSRequest(BaseModel):
    text: str
    voice: Optional[str] = "zf_xiaoxiao"  # 中文女声默认


@app.post("/tts")
async def synthesize(req: TTSRequest):
    """
    合成语音。
    请求体：{ "text": "你好世界", "voice": "zf_xiaoxiao" }
    响应：audio/wav（24kHz / 16bit PCM / 单声道）
    """
    if not req.text or not req.text.strip():
        raise HTTPException(status_code=400, detail="text 不能为空")

    if _model is None:
        raise HTTPException(
            status_code=503,
            detail="Kokoro 模型未加载，请检查启动日志"
        )

    try:
        print(f"[TTS] 合成: \"{req.text[:40]}...\" voice={req.voice}")

        # 拼接所有分段的音频
        # mlx-audio 的 generate() 返回一个 generator，每个 seg 是一个音频段
        audio_segments = []
        for seg in _model.generate(
            req.text,
            voice=req.voice,
            lang_code="z",  # 'z' = 中文
        ):
            if hasattr(seg, 'audio') and seg.audio is not None:
                audio_segments.append(seg.audio)

        if not audio_segments:
            raise HTTPException(status_code=500, detail="合成结果为空")

        # 拼接所有段
        audio_array = np.concatenate(audio_segments, axis=-1)

        # 转为 float32，确保数值范围在 [-1, 1]
        audio_float = audio_array.astype(np.float32)
        audio_float = np.clip(audio_float, -1.0, 1.0)

        # 转 16bit PCM
        audio_int16 = (audio_float * 32767).astype(np.int16)
        sample_rate = 24000  # Kokoro 输出固定 24kHz

        # 封装成 WAV 格式
        wav_bytes = _to_wav(audio_int16, sample_rate)

        print(f"[TTS] 完成，wav 大小: {len(wav_bytes)} bytes")
        return Response(content=wav_bytes, media_type="audio/wav")

    except HTTPException:
        raise
    except Exception as e:
        print(f"[TTS] 合成出错: {e}")
        raise HTTPException(status_code=500, detail=str(e))


def _to_wav(audio_int16: np.ndarray, sample_rate: int) -> bytes:
    """把 numpy int16 数组封装成标准 WAV 文件的 bytes"""
    num_samples = len(audio_int16)
    num_channels = 1
    bits_per_sample = 16
    byte_rate = sample_rate * num_channels * bits_per_sample // 8
    block_align = num_channels * bits_per_sample // 8
    data_size = num_samples * block_align

    buf = io.BytesIO()

    # WAV 文件头（RIFF/WAVE/fmt /data）
    buf.write(b'RIFF')
    buf.write(struct.pack('<I', 36 + data_size))  # 文件总大小 - 8
    buf.write(b'WAVE')
    buf.write(b'fmt ')
    buf.write(struct.pack('<I', 16))              # fmt chunk 大小（PCM = 16）
    buf.write(struct.pack('<H', 1))               # 音频格式（1 = PCM）
    buf.write(struct.pack('<H', num_channels))    # 声道数
    buf.write(struct.pack('<I', sample_rate))     # 采样率
    buf.write(struct.pack('<I', byte_rate))       # 字节率
    buf.write(struct.pack('<H', block_align))     # 块对齐
    buf.write(struct.pack('<H', bits_per_sample)) # 每采样位数
    buf.write(b'data')
    buf.write(struct.pack('<I', data_size))       # data chunk 大小
    buf.write(audio_int16.tobytes())              # 音频数据

    return buf.getvalue()


@app.get("/health")
async def health():
    """健康检查"""
    return {
        "status": "ok",
        "model_loaded": _model is not None,
        "zh_g2p_loaded": _zh_g2p is not None,
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)

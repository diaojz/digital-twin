"""
数字分身助手 - ASR 服务（阶段 2：mlx-whisper 本地语音识别）

用法：
    .venv-asr/bin/python asr_server.py

依赖安装（必须 Python 3.12，系统 Python 3.14 装不上 mlx 系列）：
    uv venv --python 3.12 .venv-asr
    uv pip install --python .venv-asr mlx-whisper fastapi uvicorn python-multipart

API：
    POST /asr
        请求：multipart/form-data，字段 audio（音频文件，支持 webm/wav/mp3/m4a）
        响应：{ "text": "识别出的文字" }

    GET /health
        响应：{ "status": "ok", "model": "..." }

为什么选 mlx-whisper：
    Apple Silicon 专属加速，RTF 50-118x（实时率），是 Mac 上做本地 ASR 的首选。
    比 faster-whisper 快 5-10 倍（在 Apple Silicon 上）。

模型选择（通过环境变量 ASR_MODEL 配置）：
    - mlx-community/whisper-large-v3-turbo  ← 默认，中文效果最好（约 1.5GB）
    - mlx-community/whisper-medium          ← 小一点（约 900MB），速度更快
    - mlx-community/whisper-small           ← 最小（约 300MB），快但稍差
"""

import os
import tempfile
import logging
from pathlib import Path

import uvicorn
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import JSONResponse

# 读取模型配置（与 server.js 中的 ASR_MODEL 对应）
MODEL_REPO = os.getenv("ASR_MODEL", "mlx-community/whisper-large-v3-turbo")
PORT = int(os.getenv("ASR_PORT", "8001"))

logging.basicConfig(level=logging.INFO, format="[ASR] %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title="数字分身 ASR 服务", version="0.1.0")

# 全局模型引用（延迟加载：第一次调用 /asr 时才加载，避免启动慢）
_model_loaded = False

def ensure_model():
    """首次调用时加载 mlx-whisper（之后常驻内存）"""
    global _model_loaded
    if _model_loaded:
        return
    logger.info(f"正在加载 mlx-whisper 模型 {MODEL_REPO}，首次启动约需 10-30 秒...")
    try:
        import mlx_whisper  # noqa: F401  验证可导入即可
        _model_loaded = True
        logger.info("mlx-whisper 模型加载成功")
    except ImportError:
        raise RuntimeError(
            "mlx-whisper 未安装，请运行：\n"
            "  uv pip install --python .venv-asr mlx-whisper"
        )


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_REPO, "loaded": _model_loaded}


@app.post("/asr")
async def transcribe(audio: UploadFile = File(...)):
    """
    接收前端上传的音频文件，用 mlx-whisper 转写成文字。
    支持 webm / wav / mp3 / m4a 等常见格式（底层用 ffmpeg 解码）。
    """
    # 懒加载模型
    try:
        ensure_model()
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))

    import mlx_whisper

    # 把上传的音频写到临时文件，mlx-whisper 需要文件路径
    suffix = Path(audio.filename or "audio.webm").suffix or ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp_path = tmp.name
        content = await audio.read()
        tmp.write(content)

    logger.info(f"收到音频: {audio.filename}, size={len(content)} bytes, 临时文件: {tmp_path}")

    try:
        # mlx-whisper 调用，language=zh 强制中文（避免识别成日文）
        result = mlx_whisper.transcribe(
            tmp_path,
            path_or_hf_repo=MODEL_REPO,
            language="zh",
            # verbose=False 减少日志噪音
            verbose=False,
        )
        text = (result.get("text") or "").strip()
        logger.info(f"识别结果: \"{text}\"")
        return JSONResponse({"text": text})
    except Exception as e:
        logger.error(f"转写失败: {e}")
        raise HTTPException(status_code=500, detail=f"转写失败: {str(e)}")
    finally:
        # 清理临时文件
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


if __name__ == "__main__":
    logger.info(f"数字分身 ASR 服务启动中，端口 {PORT}")
    logger.info(f"模型: {MODEL_REPO}")
    logger.info("提示：第一次收到请求时才加载模型（懒加载），请稍等片刻")
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")

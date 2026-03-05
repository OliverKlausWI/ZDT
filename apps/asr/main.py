from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import JSONResponse
from faster_whisper import WhisperModel
import tempfile
import os

app = FastAPI(title="ASR Service")

# Für CPU: "base" oder "small" ist realistisch. GPU: compute_type="float16".
MODEL_SIZE = os.environ.get("WHISPER_MODEL", "base")
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")  # "cuda" falls vorhanden
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE", "int8")  # cpu-friendly

model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)

@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_SIZE, "device": DEVICE, "compute": COMPUTE_TYPE}

@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    if not file:
        raise HTTPException(status_code=400, detail="missing file")

    # Wir speichern hochgeladenes Audio temporär (faster-whisper kann viele Formate direkt)
    suffix = os.path.splitext(file.filename or "")[1] or ".webm"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        data = await file.read()
        tmp.write(data)
        tmp_path = tmp.name

    try:
        segments, info = model.transcribe(
            tmp_path,
            language="de",
            vad_filter=True,
            beam_size=1
        )

        text = "".join([seg.text for seg in segments]).strip()
        return JSONResponse({"text": text, "language": info.language, "duration": info.duration})
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"ASR failed: {e}")
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass
import os
import tempfile
import subprocess
from fastapi import FastAPI, UploadFile, File
from fastapi.responses import JSONResponse
import uvicorn
from faster_whisper import WhisperModel

MODEL_SIZE = os.getenv("MODEL_SIZE", "base")
DEVICE = os.getenv("DEVICE", "cpu")
COMPUTE_TYPE = os.getenv("COMPUTE_TYPE", "int8")

app = FastAPI()
model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)

def to_wav_16k_mono(src_path: str, dst_path: str):
    # ffmpeg convert to 16k mono wav
    subprocess.check_call([
        "ffmpeg", "-y",
        "-i", src_path,
        "-ac", "1",
        "-ar", "16000",
        "-f", "wav",
        dst_path
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    try:
        with tempfile.TemporaryDirectory() as td:
            src = os.path.join(td, file.filename or "audio.webm")
            wav = os.path.join(td, "audio.wav")

            data = await file.read()
            with open(src, "wb") as f:
                f.write(data)

            to_wav_16k_mono(src, wav)

            segments, info = model.transcribe(wav, vad_filter=True)
            text = "".join([s.text for s in segments]).strip()

            return JSONResponse({
                "text": text,
                "language": info.language,
                "duration": info.duration
            })
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

if __name__ == "__main__":
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run(app, host=host, port=port)

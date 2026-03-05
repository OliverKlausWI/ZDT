FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py /app/app.py

ENV HOST=0.0.0.0
ENV PORT=8000
ENV MODEL_SIZE=base
ENV DEVICE=cpu
ENV COMPUTE_TYPE=int8

CMD ["python", "app.py"]

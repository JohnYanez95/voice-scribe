FROM nvidia/cuda:13.3.0-runtime-ubuntu24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        python3 \
        python3-venv \
        ffmpeg && \
    rm -rf /var/lib/apt/lists/*

RUN mkdir -p /cache /tmp/voice-scribe && \
    chmod 777 /cache /tmp/voice-scribe

WORKDIR /app

RUN python3 -m venv /app/.venv
ENV PATH="/app/.venv/bin:$PATH"

COPY pyproject.toml .
RUN pip install --no-cache-dir .

COPY app/ app/

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

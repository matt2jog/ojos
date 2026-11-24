FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PORT=8080 HOME=/tmp
WORKDIR /srv/ojos

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY agentic_system/assistant/requirements.txt /tmp/ojos-requirements.txt
RUN pip install --no-cache-dir -r /tmp/ojos-requirements.txt
COPY agentic_system/assistant/ /srv/ojos/agentic_system/assistant/

USER 65532:65532
EXPOSE 8080
CMD ["python", "-m", "agentic_system.assistant.cloud"]

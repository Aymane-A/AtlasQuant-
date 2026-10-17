# AtlasQuant AI — volatility model service (FastAPI). Build context is ./ai-service :
#   docker build -f docker/ai-service.Dockerfile -t atlasquant-ai ai-service
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app

COPY requirements-serve.txt ./
RUN pip install -r requirements-serve.txt

# Only what serving needs: app/ (API), src/ (feature builder imported by app/predict.py), models/ (artifact).
COPY app ./app
COPY src ./src
COPY models ./models

RUN useradd --system --uid 10001 --no-create-home aq && chown -R aq /app
USER aq

EXPOSE 8000
# AI_SERVICE_KEY is required at runtime (the service refuses to start without it).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4).status==200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

"""FastAPI service. Run from the ai-service folder:

    uvicorn app.main:app --host 127.0.0.1 --port 8000

AI_SERVICE_KEY is REQUIRED: the service refuses to start without it and /predict
answers 503 if it is missing. For local development only, set AI_ALLOW_INSECURE=1
to run with no key (a warning is logged).
"""
import logging
import os
import secrets
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import Depends, FastAPI, Header, HTTPException

from app.predict import PredictionError, load_artifact, predict
from app.schemas import PredictRequest, PredictResponse

log = logging.getLogger("atlasquant.ai")


def _insecure_allowed() -> bool:
    return os.environ.get("AI_ALLOW_INSECURE", "").strip().lower() in ("1", "true", "yes")


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not os.environ.get("AI_SERVICE_KEY"):
        if not _insecure_allowed():
            raise RuntimeError(
                "AI_SERVICE_KEY is not set. Set a strong key, or AI_ALLOW_INSECURE=1 for local development only."
            )
        log.warning("AI_SERVICE_KEY is not set and AI_ALLOW_INSECURE=1: /predict is open. Local development only.")
    app.state.artifact = load_artifact()   # fails fast with a clear message if the model file is missing
    yield


app = FastAPI(title="AtlasQuant AI service", version="1.0.0", lifespan=lifespan)


def require_key(x_api_key: Optional[str] = Header(default=None)) -> None:
    expected = os.environ.get("AI_SERVICE_KEY")
    if not expected:
        if _insecure_allowed():
            return
        # fail closed: a missing key must never mean "open"
        raise HTTPException(status_code=503, detail="service not configured: AI_SERVICE_KEY is missing")
    if not (x_api_key and secrets.compare_digest(x_api_key, expected)):
        raise HTTPException(status_code=401, detail="invalid or missing API key")


@app.get("/health")
def health():
    artifact = getattr(app.state, "artifact", None)
    if artifact is None:
        raise HTTPException(status_code=503, detail="model not loaded")
    return {"status": "ok", "model_version": artifact["model_version"],
            "trained_through": artifact["trained_through"]}


@app.post("/predict", response_model=PredictResponse, dependencies=[Depends(require_key)])
def predict_endpoint(req: PredictRequest):
    artifact = getattr(app.state, "artifact", None)
    if artifact is None:
        raise HTTPException(status_code=503, detail="model not loaded")
    try:
        return predict(artifact, [c.model_dump() for c in req.candles])
    except PredictionError as e:
        raise HTTPException(status_code=422, detail=str(e))
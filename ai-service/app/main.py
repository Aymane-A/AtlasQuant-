"""FastAPI service. Run from the ai-service folder:

    uvicorn app.main:app --host 127.0.0.1 --port 8000

Set AI_SERVICE_KEY to require the X-API-Key header (do this outside local development).
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


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.artifact = load_artifact()   # fails fast with a clear message if the model file is missing
    if not os.environ.get("AI_SERVICE_KEY"):
        log.warning("AI_SERVICE_KEY is not set: /predict is open. Fine for local development only.")
    yield


app = FastAPI(title="AtlasQuant AI service", version="1.0.0", lifespan=lifespan)


def require_key(x_api_key: Optional[str] = Header(default=None)) -> None:
    expected = os.environ.get("AI_SERVICE_KEY")
    if expected and not (x_api_key and secrets.compare_digest(x_api_key, expected)):
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
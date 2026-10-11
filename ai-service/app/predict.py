"""Inference only (no training code): features from closed candles + linear HAR-LAD forecast.

Pure Python / pandas on purpose, so it can be tested without FastAPI.
Features come from the SAME function used in training (src/build_features.build).
Run uvicorn from the ai-service folder so that `src` and `app` are importable.
"""
import json
import math
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from src.build_features import build

ARTIFACT_PATH = Path(__file__).resolve().parents[1] / "models" / "har_lad_v1.json"
FEATURES = ["RV_d", "RV_w", "RV_m"]
MIN_CANDLES = 721
FLOOR = 1e-6
HORIZON_HOURS = 24
REQUIRED_KEYS = ["model_version", "protocol", "intercept", "coef", "baseline_har_rv", "risk_thresholds",
                 "percentiles", "interval_ratio", "oos_mae_hourly_std", "data_start", "trained_through"]
DISCLAIMER = ("Research indicator based on historical data. It can be wrong and is not financial advice. "
              "It does not predict price direction.")


class PredictionError(ValueError):
    """Bad or insufficient input: the API returns HTTP 422."""


def load_artifact(path: Path = ARTIFACT_PATH) -> dict:
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"Model file not found: {path}. Run `python src/train_product.py` first.")
    artifact = json.loads(path.read_text())
    missing = [k for k in REQUIRED_KEYS if k not in artifact]
    if missing or len(artifact["percentiles"]) != 101:
        raise ValueError(f"Invalid model file, missing or malformed: {missing or 'percentiles'}")
    return artifact


def compute_features(candles: list) -> tuple:
    """Returns ({RV_d, RV_w, RV_m}, last_candle_open_time) using the training feature code."""
    if len(candles) < MIN_CANDLES:
        raise PredictionError(f"need at least {MIN_CANDLES} hourly candles, got {len(candles)}")
    df = pd.DataFrame(candles)
    needed = ["timestamp", "high", "low", "close", "volume"]
    absent = [c for c in needed if c not in df.columns]
    if absent:
        raise PredictionError(f"missing fields: {absent}")
    df = df[needed].copy()
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
    for c in needed[1:]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    if df.isna().any().any():
        raise PredictionError("candles contain missing or non-numeric values")
    df = df.sort_values("timestamp").reset_index(drop=True)
    ts = df["timestamp"]
    if ts.duplicated().any():
        raise PredictionError("duplicate candle timestamps")
    if not ((ts.dt.minute == 0) & (ts.dt.second == 0) & (ts.dt.microsecond == 0)).all():
        raise PredictionError("candle timestamps must be aligned to the hour (UTC)")

    feats = build(df)
    last = feats.iloc[-1]
    values = {c: float(last[c]) for c in FEATURES}
    if not all(np.isfinite(v) for v in values.values()):
        raise PredictionError("not enough valid recent data (gaps or zero-volume candles) to compute the features")
    return values, feats.index[-1]


def _linear(model: dict, values: dict) -> float:
    return model["intercept"] + sum(model["coef"][k] * values[k] for k in FEATURES)


def predict(artifact: dict, candles: list, now: datetime = None) -> dict:
    now = pd.Timestamp(now or datetime.now(timezone.utc))
    values, last_open = compute_features(candles)
    closed_at = last_open + pd.Timedelta(hours=1)
    if closed_at > now:
        raise PredictionError("the last candle is not closed yet; send closed candles only")

    f = max(_linear(artifact, values), FLOOR)
    har_rv = max(_linear(artifact["baseline_har_rv"], values), FLOOR)

    pct = artifact["percentiles"]
    rank = int(np.clip(np.searchsorted(pct, f, side="right") - 1, 0, 100))
    thr = artifact["risk_thresholds"]
    level = "low" if f <= thr["low_max"] else "medium" if f <= thr["medium_max"] else "high"
    ratio = artifact["interval_ratio"]

    return {
        "model_version": artifact["model_version"],
        "protocol": artifact["protocol"],
        "as_of": last_open.isoformat(),
        "candle_closed_at": closed_at.isoformat(),
        "data_age_hours": round(max((now - closed_at).total_seconds() / 3600, 0.0), 2),
        "horizon_hours": HORIZON_HOURS,
        "forecast": {
            "hourly_std": f,
            "move_24h_pct_1sigma": f * math.sqrt(HORIZON_HOURS) * 100,
            "range_90": {"low": f * ratio["q05"], "high": f * ratio["q95"]},
        },
        "risk": {
            "level": level,
            "historical_percentile": rank,
            "out_of_historical_range": bool(f < pct[0] or f > pct[-1]),
            "note": f"Relative to this model's own history ({artifact['data_start'][:10]} to {artifact['trained_through'][:10]}).",
        },
        "inputs": values,
        "monitoring": {"persistence": values["RV_d"], "har_rv": har_rv},
        "model_info": {"trained_through": artifact["trained_through"],
                       "oos_mae_hourly_std": artifact["oos_mae_hourly_std"]},
        "disclaimer": DISCLAIMER,
    }
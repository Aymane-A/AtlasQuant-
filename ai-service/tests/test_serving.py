import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))

from app.predict import MIN_CANDLES, PredictionError, compute_features, predict  # noqa: E402
from src.build_features import build  # noqa: E402

CLEAN = ROOT / "data" / "processed" / "BTCUSDT_1h_clean.csv"


def _artifact():
    return {
        "model_version": "test", "protocol": "v1.6",
        "trained_through": "2026-09-29T23:00:00+00:00", "data_start": "2020-01-31T00:00:00+00:00",
        "intercept": 0.0003, "coef": {"RV_d": 0.3, "RV_w": 0.4, "RV_m": 0.2},
        "baseline_har_rv": {"intercept": 0.0002, "coef": {"RV_d": 0.3, "RV_w": 0.4, "RV_m": 0.25}},
        "risk_thresholds": {"low_max": 0.0045, "medium_max": 0.0075},
        "percentiles": list(np.linspace(0.002, 0.012, 101)),
        "interval_ratio": {"q05": 0.6, "q50": 0.95, "q95": 1.7},
        "oos_mae_hourly_std": 0.0015,
    }


def _candles(n=800, vol=0.004, hours_ago=3, seed=0):
    """n closed hourly candles; the last one closed `hours_ago` hours before the real now."""
    rng = np.random.default_rng(seed)
    last_open = pd.Timestamp(datetime.now(timezone.utc)).floor("h") - pd.Timedelta(hours=hours_ago + 1)
    idx = pd.date_range(end=last_open, periods=n, freq="h")
    close = 60000 * np.exp(np.cumsum(rng.normal(0, vol, n)))
    return [{"timestamp": t.isoformat(), "open": c, "high": c * 1.002, "low": c * 0.998,
             "close": c, "volume": 100.0 + i % 7} for i, (t, c) in enumerate(zip(idx, close))]


def test_predict_returns_consistent_output():
    out = predict(_artifact(), _candles())
    f = out["forecast"]
    assert f["hourly_std"] > 0
    assert f["range_90"]["low"] < f["hourly_std"] < f["range_90"]["high"]
    assert out["risk"]["level"] in ("low", "medium", "high")
    assert 0 <= out["risk"]["historical_percentile"] <= 100
    assert out["horizon_hours"] == 24 and out["data_age_hours"] >= 0
    assert abs(f["move_24h_pct_1sigma"] - f["hourly_std"] * np.sqrt(24) * 100) < 1e-12


def test_risk_level_increases_with_volatility():
    levels = [predict(_artifact(), _candles(vol=v))["risk"]["level"] for v in (0.0015, 0.006, 0.02)]
    assert levels[0] == "low" and levels[-1] == "high"


def test_rejects_too_few_candles():
    with pytest.raises(PredictionError, match="at least"):
        predict(_artifact(), _candles(n=MIN_CANDLES - 1))


def test_rejects_unclosed_last_candle():
    candles = _candles(hours_ago=-1)  # last candle opens in the current hour: not closed yet
    with pytest.raises(PredictionError, match="not closed"):
        predict(_artifact(), candles)


def test_rejects_duplicates_and_unaligned_timestamps():
    dup = _candles()
    dup[-1] = dict(dup[-2])
    with pytest.raises(PredictionError, match="duplicate"):
        predict(_artifact(), dup)
    shifted = _candles()
    shifted[10]["timestamp"] = (pd.Timestamp(shifted[10]["timestamp"]) + pd.Timedelta(minutes=7)).isoformat()
    with pytest.raises(PredictionError, match="aligned"):
        predict(_artifact(), shifted)


def test_small_old_gap_is_tolerated_but_recent_gap_is_rejected():
    old_gap = _candles()
    del old_gap[300:303]
    assert predict(_artifact(), old_gap)["forecast"]["hourly_std"] > 0
    recent_gap = _candles()
    del recent_gap[-5]
    with pytest.raises(PredictionError, match="not enough valid"):
        predict(_artifact(), recent_gap)


def test_zero_volume_candle_in_last_24h_is_rejected():
    candles = _candles()
    candles[-10]["volume"] = 0.0          # zero-volume candle = invalid candle (PROTOCOL section 8)
    with pytest.raises(PredictionError, match="not enough valid"):
        predict(_artifact(), candles)


def test_168h_window_validity_threshold_boundary():
    """RV_w needs >= 160 valid returns of 168. Each missing candle invalidates 2 returns:
    4 missing candles (8 invalid) is accepted, 5 missing candles (10 invalid) is rejected."""
    ok = _candles()
    for pos in (-130, -110, -90, -70):    # all inside the last 168h, outside the last 24h
        ok[pos] = None
    ok = [c for c in ok if c is not None]
    assert predict(_artifact(), ok)["forecast"]["hourly_std"] > 0

    bad = _candles()
    for pos in (-130, -110, -90, -70, -50):
        bad[pos] = None
    bad = [c for c in bad if c is not None]
    with pytest.raises(PredictionError, match="not enough valid"):
        predict(_artifact(), bad)


@pytest.mark.skipif(not CLEAN.exists(), reason="clean candle file not available")
def test_training_serving_parity():
    """The features served for a timestamp must equal the features used in training."""
    df = pd.read_csv(CLEAN, parse_dates=["timestamp"])
    full = build(df)
    t = pd.Timestamp("2025-03-14 06:00", tz="UTC")
    window = df[df["timestamp"] <= t].tail(800)
    values, last_open = compute_features(window.to_dict("records"))
    assert last_open == t
    for name in ("RV_d", "RV_w", "RV_m"):
        assert np.isclose(values[name], full.loc[t, name], rtol=1e-10), name


def test_api_predict_auth_and_validation(monkeypatch):
    pytest.importorskip("fastapi")
    pytest.importorskip("httpx")
    from fastapi.testclient import TestClient
    from app.main import app

    app.state.artifact = _artifact()      # no lifespan in this client: set the model by hand
    client = TestClient(app)
    body = {"symbol": "BTCUSDT", "timeframe": "1h", "candles": _candles()}

    monkeypatch.delenv("AI_SERVICE_KEY", raising=False)
    assert client.get("/health").status_code == 200
    r = client.post("/predict", json=body)
    assert r.status_code == 200 and r.json()["risk"]["level"] in ("low", "medium", "high")

    monkeypatch.setenv("AI_SERVICE_KEY", "secret")
    assert client.post("/predict", json=body).status_code == 401
    assert client.post("/predict", json=body, headers={"X-API-Key": "wrong"}).status_code == 401
    assert client.post("/predict", json=body, headers={"X-API-Key": "secret"}).status_code == 200

    short = dict(body, candles=body["candles"][:10])
    assert client.post("/predict", json=short, headers={"X-API-Key": "secret"}).status_code == 422
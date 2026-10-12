import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))

import evaluate_live  # noqa: E402
import paper_log  # noqa: E402
from src.build_features import build  # noqa: E402


def _artifact():
    return {
        "model_version": "test", "protocol": "v1.7",
        "trained_through": "2026-09-29T23:00:00+00:00", "data_start": "2020-01-31T00:00:00+00:00",
        "intercept": 0.0003, "coef": {"RV_d": 0.3, "RV_w": 0.4, "RV_m": 0.2},
        "baseline_har_rv": {"intercept": 0.0002, "coef": {"RV_d": 0.3, "RV_w": 0.4, "RV_m": 0.25}},
        "risk_thresholds": {"low_max": 0.0045, "medium_max": 0.0075},
        "percentiles": list(np.linspace(0.002, 0.012, 101)),
        "interval_ratio": {"q05": 0.6, "q50": 0.95, "q95": 1.7},
        "oos_mae_hourly_std": 0.0015,
    }


def _candles(n, last_open, seed=0, vol=0.004):
    rng = np.random.default_rng(seed)
    idx = pd.date_range(end=last_open, periods=n, freq="h", tz="UTC")
    close = 60000 * np.exp(np.cumsum(rng.normal(0, vol, n)))
    return [{"timestamp": t.isoformat(), "open": c, "high": c * 1.002, "low": c * 0.998,
             "close": c, "volume": 100.0 + i % 7} for i, (t, c) in enumerate(zip(idx, close))]


def test_log_once_backfills_and_is_idempotent():
    now = datetime(2026, 10, 11, 22, 30, tzinfo=timezone.utc)
    with tempfile.TemporaryDirectory() as tmp:
        live = Path(tmp)
        c1 = _candles(900, pd.Timestamp("2026-10-11 21:00", tz="UTC"))
        assert paper_log.log_once(_artifact(), "abc", c1, now, live) == 1 + paper_log.BACKFILL_HOURS
        fc = pd.read_csv(live / "forecasts.csv")
        assert (fc["source"] == "live").sum() == 1 and (fc["source"] == "backfill").sum() == 24
        assert fc["as_of"].is_unique
        # same hour again: nothing new
        assert paper_log.log_once(_artifact(), "abc", c1, now, live) == 0
        # one hour later: exactly one new live row, candle store has unique timestamps
        c2 = _candles(901, pd.Timestamp("2026-10-11 22:00", tz="UTC"))
        # keep identical history so that stored candles are consistent
        c2 = c1 + [c2[-1]]
        assert paper_log.log_once(_artifact(), "abc", c2, datetime(2026, 10, 11, 23, 30, tzinfo=timezone.utc), live) == 1
        store = pd.read_csv(live / "candles.csv")
        assert store["timestamp"].is_unique and len(store) == 901


def _synthetic_live(days):
    """Candles for 100 days + forecasts for the first `days` days (forecast = HAR-like on training features)."""
    rng = np.random.default_rng(1)
    n = 100 * 24
    idx = pd.date_range("2026-06-01", periods=n, freq="h", tz="UTC")
    close = 60000 * np.exp(np.cumsum(rng.normal(0, 0.004, n)))
    candles = pd.DataFrame({"timestamp": idx, "open": close, "high": close * 1.002, "low": close * 0.998,
                            "close": close, "volume": 100.0})
    feats = build(candles[["timestamp", "high", "low", "close", "volume"]])
    start = idx[800]
    sel = feats.loc[(feats.index >= start) & (feats.index < start + pd.Timedelta(days=days))].dropna(
        subset=["RV_d", "RV_w", "RV_m"])
    f = 0.3 * sel["RV_d"] + 0.4 * sel["RV_w"] + 0.3 * sel["RV_m"]
    fc = pd.DataFrame({
        "as_of": sel.index.map(lambda t: t.isoformat()), "source": "live", "model_sha256": "abc",
        "forecast_hourly_std": f.to_numpy(), "range_low": (f * 0.6).to_numpy(), "range_high": (f * 1.7).to_numpy(),
        "persistence": sel["RV_d"].to_numpy(), "har_rv": sel["RV_w"].to_numpy(),
    })
    return fc, candles, feats


def test_evaluate_interim_then_verdict_and_realized_matches_training_definition():
    fc, candles, feats = _synthetic_live(days=70)
    res = evaluate_live.evaluate(fc, candles)
    assert res["availability_live"] == 1.0 and res["rows_evaluated"] > 1000
    assert res["verdict"] == "PASS" or res["verdict"].startswith("FAIL")
    assert set(res["conditions"]) == {"1_beats_persistence", "2_not_worse_than_1.02x_har_rv",
                                      "3_coverage_80_95", "4_availability_95"}

    short_fc, candles, _ = _synthetic_live(days=30)
    short = evaluate_live.evaluate(short_fc, candles)
    assert short["verdict"].startswith("INTERIM")

    # realized value == the training target for that hour
    row = fc.iloc[300]
    expected = feats.loc[pd.Timestamp(row["as_of"]), "RV_next24"]
    sub = fc.iloc[300:301]
    r = evaluate_live.evaluate(pd.concat([fc.iloc[:1], sub]), candles)
    assert r["rows_evaluated"] == 2
    assert np.isclose(r["mae_persistence"] * 2,
                      abs(expected - row["persistence"]) + abs(feats.loc[pd.Timestamp(fc.iloc[0]["as_of"]), "RV_next24"] - fc.iloc[0]["persistence"]))


def test_availability_drops_when_hours_are_missing():
    fc, candles, _ = _synthetic_live(days=70)
    fc = fc.drop(fc.index[100:250])          # 150 missing hours out of ~1680 (>5%)
    res = evaluate_live.evaluate(fc, candles)
    assert res["availability_live"] < 0.95
    assert res["conditions"]["4_availability_95"] is False


def test_crlf_hash_is_treated_as_same_model():
    fc, candles, _ = _synthetic_live(days=30)
    fc.loc[fc.index[:5], "model_sha256"] = "a6efc42f99f5"
    fc.loc[fc.index[5:], "model_sha256"] = "7d5796e6d449"
    assert evaluate_live.evaluate(fc, candles)["model_hashes"] == ["7d5796e6d449"]

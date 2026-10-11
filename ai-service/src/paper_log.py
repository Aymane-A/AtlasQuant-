"""Hourly paper-monitoring logger (PROTOCOL.md v1.7, section 13).

    python src/paper_log.py

Scheduled every hour at minute 5. Needs internet (Binance public API) but NO running server:
it calls the same predict() function as the API with the frozen model file.
Writes to data/live/: candles.csv, forecasts.csv, run_log.csv.
"""
import csv
import hashlib
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import requests

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))   # so `app` and `src` are importable when run as a script

from app.predict import ARTIFACT_PATH, MIN_CANDLES, PredictionError, load_artifact, predict  # noqa: E402

LIVE = ROOT / "data" / "live"
BASES = ["https://api.binance.com", "https://data-api.binance.vision"]
BACKFILL_HOURS = 24
FIELDS = ["as_of", "source", "logged_at_utc", "model_version", "model_sha256", "RV_d", "RV_w", "RV_m",
          "forecast_hourly_std", "range_low", "range_high", "risk_level", "historical_percentile",
          "persistence", "har_rv"]


def fetch_candles() -> list:
    """Latest closed BTCUSDT 1h candles (about 1000)."""
    for base in BASES:
        try:
            r = requests.get(f"{base}/api/v3/klines",
                             params={"symbol": "BTCUSDT", "interval": "1h", "limit": 1000}, timeout=30)
            r.raise_for_status()
            now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
            return [{
                "timestamp": datetime.fromtimestamp(k[0] / 1000, timezone.utc).isoformat(),
                "open": float(k[1]), "high": float(k[2]), "low": float(k[3]),
                "close": float(k[4]), "volume": float(k[5]),
            } for k in r.json() if k[6] < now_ms]            # closed candles only
        except Exception as e:  # noqa: BLE001
            last_error = f"{base}: {e}"
    raise RuntimeError(f"could not fetch candles ({last_error})")


def artifact_sha() -> str:
    return hashlib.sha256(ARTIFACT_PATH.read_bytes()).hexdigest()[:12]


def _row(out: dict, source: str, sha: str, logged_at: str) -> dict:
    f = out["forecast"]
    return {
        "as_of": out["as_of"], "source": source, "logged_at_utc": logged_at,
        "model_version": out["model_version"], "model_sha256": sha,
        "RV_d": out["inputs"]["RV_d"], "RV_w": out["inputs"]["RV_w"], "RV_m": out["inputs"]["RV_m"],
        "forecast_hourly_std": f["hourly_std"], "range_low": f["range_90"]["low"], "range_high": f["range_90"]["high"],
        "risk_level": out["risk"]["level"], "historical_percentile": out["risk"]["historical_percentile"],
        "persistence": out["monitoring"]["persistence"], "har_rv": out["monitoring"]["har_rv"],
    }


def _append(path: Path, fields: list, rows: list) -> None:
    new_file = not path.exists()
    with open(path, "a", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        if new_file:
            w.writeheader()
        w.writerows(rows)


def log_once(artifact: dict, sha: str, candles: list, now: datetime, live_dir: Path = LIVE) -> int:
    """Store candles, log the latest forecast and backfill missing hours. Returns the number of new rows."""
    live_dir.mkdir(parents=True, exist_ok=True)
    candles_csv, forecasts_csv = live_dir / "candles.csv", live_dir / "forecasts.csv"

    store = pd.DataFrame(candles)[["timestamp", "open", "high", "low", "close", "volume"]]
    store["timestamp"] = pd.to_datetime(store["timestamp"], utc=True)
    if candles_csv.exists():
        old = pd.read_csv(candles_csv)
        old["timestamp"] = pd.to_datetime(old["timestamp"], utc=True)
        store = pd.concat([old, store])
    store.drop_duplicates("timestamp", keep="last").sort_values("timestamp").to_csv(candles_csv, index=False)

    existing = set(pd.read_csv(forecasts_csv)["as_of"]) if forecasts_csv.exists() else set()
    logged_at = now.isoformat()
    rows = []

    live_out = predict(artifact, candles, now=now)
    if live_out["as_of"] not in existing:
        rows.append(_row(live_out, "live", sha, logged_at))
        existing.add(live_out["as_of"])

    last_open = pd.Timestamp(live_out["as_of"])
    stamps = [pd.Timestamp(c["timestamp"]) for c in candles]
    for h in range(1, BACKFILL_HOURS + 1):
        ts = last_open - pd.Timedelta(hours=h)
        if ts.isoformat() in existing:
            continue
        subset = [c for c, t in zip(candles, stamps) if t <= ts]
        if len(subset) < MIN_CANDLES:
            continue
        try:
            out = predict(artifact, subset, now=now)
        except PredictionError:
            continue
        if out["as_of"] != ts.isoformat():      # the candle of that hour is missing
            continue
        rows.append(_row(out, "backfill", sha, logged_at))
        existing.add(out["as_of"])

    rows.sort(key=lambda r: r["as_of"])
    if rows:
        _append(forecasts_csv, FIELDS, rows)
    return len(rows)


def main() -> None:
    now = datetime.now(timezone.utc)
    LIVE.mkdir(parents=True, exist_ok=True)
    try:
        artifact = load_artifact()
        n = log_once(artifact, artifact_sha(), fetch_candles(), now)
        status, message = "ok", f"{n} new rows"
    except Exception as e:  # noqa: BLE001
        status, message = "error", f"{type(e).__name__}: {e}"
    _append(LIVE / "run_log.csv", ["logged_at_utc", "status", "message"],
            [{"logged_at_utc": now.isoformat(), "status": status, "message": message}])
    print(f"{now:%Y-%m-%d %H:%M} UTC  {status}: {message}")
    sys.exit(0 if status == "ok" else 1)


if __name__ == "__main__":
    main()
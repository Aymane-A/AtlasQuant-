"""Manual test: fetch the latest closed BTCUSDT 1h candles from Binance and call the local service.

1) In one terminal (from ai-service):  uvicorn app.main:app --host 127.0.0.1 --port 8000
2) In another terminal:                python src/try_predict.py
Set AI_SERVICE_KEY in the environment if the service requires it.
"""
import json
import os
import sys
import time
from datetime import datetime, timezone

import requests

BASES = ["https://api.binance.com", "https://data-api.binance.vision"]
SERVICE = os.environ.get("AI_SERVICE_URL", "http://127.0.0.1:8000")


def fetch_rows():
    for base in BASES:
        try:
            r = requests.get(f"{base}/api/v3/klines",
                             params={"symbol": "BTCUSDT", "interval": "1h", "limit": 1000}, timeout=30)
            r.raise_for_status()
            return r.json()
        except Exception as e:  # noqa: BLE001
            print(f"{base} failed: {e}")
    sys.exit("Could not fetch candles from Binance.")


def main() -> None:
    now_ms = int(time.time() * 1000)
    candles = [{
        "timestamp": datetime.fromtimestamp(r[0] / 1000, timezone.utc).isoformat(),
        "open": float(r[1]), "high": float(r[2]), "low": float(r[3]),
        "close": float(r[4]), "volume": float(r[5]),
    } for r in fetch_rows() if r[6] < now_ms]          # keep CLOSED candles only
    print(f"{len(candles)} closed candles, last open time {candles[-1]['timestamp']}")

    headers = {"X-API-Key": os.environ["AI_SERVICE_KEY"]} if os.environ.get("AI_SERVICE_KEY") else {}
    resp = requests.post(f"{SERVICE}/predict", headers=headers, timeout=30,
                         json={"symbol": "BTCUSDT", "timeframe": "1h", "candles": candles})
    print(resp.status_code)
    print(json.dumps(resp.json(), indent=2))


if __name__ == "__main__":
    main()
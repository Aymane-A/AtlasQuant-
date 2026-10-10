"""Validate raw BTC/USDT 1h candles and write a cleaned dataset.

Checks: duplicates, sort order, missing candles (gaps), OHLC sanity, zero volume.
Missing candles are REPORTED, never filled.

Run from the ai-service folder:
    python src/validate_data.py
"""
import json
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw" / "BTCUSDT_1h_raw.csv"
PROCESSED = ROOT / "data" / "processed" / "BTCUSDT_1h_clean.csv"
REPORT = ROOT / "data" / "processed" / "validation_report.json"


def main() -> None:
    if not RAW.exists():
        sys.exit(f"Missing {RAW}. Run src/download_data.py first.")

    df = pd.read_csv(RAW)
    report: dict = {"raw_rows": int(len(df))}

    # Timestamps: milliseconds since epoch, UTC
    df["timestamp"] = pd.to_datetime(df["open_time"], unit="ms", utc=True)
    num_cols = ["open", "high", "low", "close", "volume"]
    df[num_cols] = df[num_cols].apply(pd.to_numeric, errors="coerce")

    # Order and duplicates
    report["was_sorted"] = bool(df["timestamp"].is_monotonic_increasing)
    df = df.sort_values("timestamp")
    dup = int(df["timestamp"].duplicated().sum())
    report["duplicate_timestamps"] = dup
    df = df.drop_duplicates(subset="timestamp", keep="first")

    # Missing values
    report["rows_with_nan"] = int(df[num_cols].isna().any(axis=1).sum())
    df = df.dropna(subset=num_cols)

    # Gaps (candles missing between consecutive timestamps)
    prev_ts = df["timestamp"].shift(1)
    delta = df["timestamp"] - prev_ts
    gap_rows = delta.notna() & (delta != pd.Timedelta(hours=1))
    gaps = []
    for ts, prev, d in zip(df.loc[gap_rows, "timestamp"], prev_ts[gap_rows], delta[gap_rows]):
        gaps.append({
            "after": prev.isoformat(),
            "next": ts.isoformat(),
            "missing_candles": int(d / pd.Timedelta(hours=1)) - 1,
        })
    report["gap_count"] = len(gaps)
    report["missing_candles_total"] = int(sum(g["missing_candles"] for g in gaps))
    report["gaps"] = gaps[:50]  # first 50 only, to keep the report readable

    # OHLC sanity
    bad_ohlc = (
        (df["high"] < df["low"])
        | (df["high"] < df[["open", "close"]].max(axis=1))
        | (df["low"] > df[["open", "close"]].min(axis=1))
        | (df[["open", "high", "low", "close"]] <= 0).any(axis=1)
    )
    report["bad_ohlc_rows"] = int(bad_ohlc.sum())
    report["zero_volume_rows"] = int((df["volume"] == 0).sum())

    # Range
    report["first_timestamp_utc"] = df["timestamp"].iloc[0].isoformat()
    report["last_timestamp_utc"] = df["timestamp"].iloc[-1].isoformat()
    report["clean_rows"] = int(len(df))

    PROCESSED.parent.mkdir(parents=True, exist_ok=True)
    out = df[["timestamp"] + num_cols].reset_index(drop=True)
    out["timestamp"] = out["timestamp"].dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    out.to_csv(PROCESSED, index=False)
    REPORT.write_text(json.dumps(report, indent=2))

    print(json.dumps({k: v for k, v in report.items() if k != "gaps"}, indent=2))
    print(f"\nClean data: {PROCESSED}\nReport:     {REPORT}")

    if report["bad_ohlc_rows"] or report["rows_with_nan"]:
        print("\nWARNING: bad OHLC or NaN rows found. Investigate before modelling (Gate 0).")
    if report["gap_count"]:
        print("NOTE: gaps exist. Do not fill them silently. Decide in PROTOCOL.md how rolling windows treat them.")


if __name__ == "__main__":
    main()
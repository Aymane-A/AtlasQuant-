"""Build past-only features and the 24h-ahead realized-volatility target.

Follows PROTOCOL.md v1.1 (sections 2 and 8). No annualization, std ddof=1.

Run from the ai-service folder:
    python src/build_features.py
"""
import math
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
CLEAN = ROOT / "data" / "processed" / "BTCUSDT_1h_clean.csv"
OUT = ROOT / "data" / "processed" / "features_1h.csv"

W_D, W_W, W_M = 24, 168, 720
MIN_FRAC = 0.95  # long windows need >= 95% valid returns


def build(df: pd.DataFrame) -> pd.DataFrame:
    """df: columns timestamp (UTC), open, high, low, close, volume."""
    df = df.set_index("timestamp").asfreq("h")  # missing candles become NaN rows (NOT filled)

    # Rule 2: invalid candle = missing or volume == 0
    invalid = df["close"].isna() | (df["volume"] == 0)
    close = df["close"].where(~invalid)

    # Rule 3: r_t = ln(P_t / P_(t-1)); NaN if candle t or t-1 invalid
    r = np.log(close / close.shift(1))

    # Past-only features (value at t uses data up to and including t)
    rv24 = r.rolling(W_D, min_periods=W_D).std(ddof=1)
    out = pd.DataFrame(index=df.index)
    out["RV_d"] = rv24
    out["RV_w"] = r.rolling(W_W, min_periods=math.ceil(MIN_FRAC * W_W)).std(ddof=1)
    out["RV_m"] = r.rolling(W_M, min_periods=math.ceil(MIN_FRAC * W_M)).std(ddof=1)

    hl = np.log(df["high"] / df["low"]).where(~invalid)
    out["range_24h"] = hl.rolling(W_D, min_periods=W_D).mean()

    vol = df["volume"].where(~invalid)
    v_now = vol.rolling(W_D, min_periods=W_D).sum()
    v_prev = v_now.shift(W_D)
    out["vol_change_24h"] = np.log(v_now / v_prev)

    # LABEL ONLY: std of r_(t+1)..r_(t+24) = rv24 evaluated at t+24
    out["RV_next24"] = rv24.shift(-W_D)
    return out


def main() -> None:
    df = pd.read_csv(CLEAN, parse_dates=["timestamp"])
    out = build(df)

    n_grid = len(out)
    feats = out.replace([np.inf, -np.inf], np.nan).dropna()
    print(f"Hourly grid rows:       {n_grid}")
    print(f"Rows kept:              {len(feats)}")
    print(f"Rows dropped (rule 4/5): {n_grid - len(feats)} "
          f"({(n_grid - len(feats)) / n_grid:.2%})")

    # Hand-check one row: recompute the target directly from raw closes
    sample_ts = feats.index[len(feats) // 2]
    d = df.set_index("timestamp")["close"]
    seg = d.loc[sample_ts: sample_ts + pd.Timedelta(hours=24)]
    manual = np.log(seg / seg.shift(1)).dropna().std(ddof=1)
    print(f"Hand-check {sample_ts}: pipeline={feats.loc[sample_ts, 'RV_next24']:.8f} "
          f"manual={manual:.8f}")
    assert abs(feats.loc[sample_ts, "RV_next24"] - manual) < 1e-12, "Target mismatch!"

    feats.to_csv(OUT)
    print(f"Saved {OUT}")


if __name__ == "__main__":
    main()
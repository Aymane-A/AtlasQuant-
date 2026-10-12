"""Live paper-monitoring evaluation (PROTOCOL.md v1.7 section 13; Gate 3 conditions of v1.6 section 12).

    python src/evaluate_live.py

No verdict before 56 days: earlier output is INTERIM and informational only.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))

from baselines import qlike  # noqa: E402
from gate1 import block_bootstrap_ci  # noqa: E402
from src.build_features import build  # noqa: E402

LIVE = ROOT / "data" / "live"
RESULTS = ROOT / "results"

MIN_DAYS = 56
MAX_RATIO_VS_HAR = 1.02
COVERAGE_RANGE = (0.80, 0.95)
MIN_AVAILABILITY = 0.95
MIN_ROWS_FOR_CI = 200
# v1.8.1: same model file, hashed with CRLF line endings by the first PC run
EQUIVALENT_HASHES = {"a6efc42f99f5": "7d5796e6d449"}


def evaluate(fc: pd.DataFrame, candles: pd.DataFrame) -> dict:
    fc = fc.copy()
    fc["as_of"] = pd.to_datetime(fc["as_of"], utc=True)
    fc = fc.drop_duplicates("as_of").sort_values("as_of").reset_index(drop=True)
    candles = candles.copy()
    candles["timestamp"] = pd.to_datetime(candles["timestamp"], utc=True)

    realized = build(candles[["timestamp", "high", "low", "close", "volume"]])["RV_next24"]
    fc["realized"] = realized.reindex(pd.DatetimeIndex(fc["as_of"])).to_numpy()

    first, last = fc["as_of"].min(), fc["as_of"].max()
    expected_hours = int((last - first) / pd.Timedelta(hours=1)) + 1
    live_hours = int(fc.loc[fc["source"] == "live", "as_of"].nunique())
    availability = live_hours / expected_hours

    done = fc.dropna(subset=["realized"])
    res = {
        "first_as_of": first.isoformat(), "last_as_of": last.isoformat(),
        "rows_logged": int(len(fc)), "rows_live": live_hours,
        "rows_backfill": int((fc["source"] == "backfill").sum()),
        "rows_without_realized_yet_or_invalid": int(len(fc) - len(done)),
        "availability_live": availability,
        "model_hashes": sorted({EQUIVALENT_HASHES.get(h, h) for h in fc["model_sha256"].astype(str)}) if "model_sha256" in fc else [],
    }
    if len(done) == 0:
        res["status"] = "no realized values yet (the first targets need 25 hours)"
        return res

    y = done["realized"].to_numpy()
    f = done["forecast_hourly_std"].to_numpy()
    p = done["persistence"].to_numpy()
    h = done["har_rv"].to_numpy()
    mae = lambda a: float(np.mean(np.abs(y - a)))  # noqa: E731
    m_f, m_p, m_h = mae(f), mae(p), mae(h)
    coverage = float(np.mean((y >= done["range_low"].to_numpy()) & (y <= done["range_high"].to_numpy())))
    span_days = (done["as_of"].max() - first).total_seconds() / 86400

    res.update({
        "rows_evaluated": int(len(done)), "span_days": span_days,
        "mae_har_lad": m_f, "mae_persistence": m_p, "mae_har_rv": m_h,
        "improvement_vs_persistence": (m_p - m_f) / m_p, "ratio_vs_har_rv": m_f / m_h,
        "coverage_range_90": coverage, "bias": float(f.mean() / y.mean() - 1),
        "qlike_har_lad": qlike(y, f), "qlike_har_rv": qlike(y, h),
        "share_forecast_below_realized": float(np.mean(f < y)),
    })
    if len(done) >= MIN_ROWS_FOR_CI:
        for name, base in (("persistence", p), ("har_rv", h)):
            base_err = np.abs(y - base)
            d = base_err - np.abs(y - f)
            lo, hi = block_bootstrap_ci(d, base_err, 24)
            res[f"improvement_vs_{name}_ci95_block24h"] = [lo, hi]

    conditions = {
        "1_beats_persistence": bool(m_f < m_p),
        "2_not_worse_than_1.02x_har_rv": bool(m_f <= MAX_RATIO_VS_HAR * m_h),
        "3_coverage_80_95": bool(COVERAGE_RANGE[0] <= coverage <= COVERAGE_RANGE[1]),
        "4_availability_95": bool(availability >= MIN_AVAILABILITY),
    }
    res["conditions"] = conditions
    if span_days < MIN_DAYS:
        res["verdict"] = f"INTERIM ({span_days:.1f} of {MIN_DAYS} days; no verdict yet, do not stop early)"
    else:
        failed = [k for k, v in conditions.items() if not v]
        res["verdict"] = "PASS" if not failed else "FAIL: " + ", ".join(failed)
    return res


def main() -> None:
    fc_path, candles_path = LIVE / "forecasts.csv", LIVE / "candles.csv"
    if not fc_path.exists() or not candles_path.exists():
        sys.exit("No live data yet: run src/paper_log.py first (data/live/forecasts.csv and candles.csv).")
    res = evaluate(pd.read_csv(fc_path), pd.read_csv(candles_path))

    print(f"logged {res['rows_logged']} hours ({res['first_as_of'][:16]} to {res['last_as_of'][:16]}): "
          f"{res['rows_live']} live, {res['rows_backfill']} backfill; availability (live) = {res['availability_live']:.1%}")
    if len(res["model_hashes"]) > 1:
        print(f"WARNING: several model files seen {res['model_hashes']}: the monitoring must restart under a new version.")
    if "status" in res:
        print(res["status"])
    else:
        print(f"evaluated {res['rows_evaluated']} hours over {res['span_days']:.1f} days "
              f"({res['rows_without_realized_yet_or_invalid']} not evaluable yet)")
        print(f"MAE  har_lad={res['mae_har_lad']:.6f}  persistence={res['mae_persistence']:.6f}  har_rv={res['mae_har_rv']:.6f}")
        print(f"har_lad vs persistence: {res['improvement_vs_persistence']:+.1%}   har_lad / har_rv MAE ratio: {res['ratio_vs_har_rv']:.3f}")
        for k in ("improvement_vs_persistence_ci95_block24h", "improvement_vs_har_rv_ci95_block24h"):
            if k in res:
                lo, hi = res[k]
                print(f"  {k}: [{lo:+.1%}, {hi:+.1%}]")
        print(f"range_90 coverage = {res['coverage_range_90']:.1%} | bias = {res['bias']:+.1%} | "
              f"QLIKE har_lad={res['qlike_har_lad']:.3f} har_rv={res['qlike_har_rv']:.3f}")
        for k, v in res["conditions"].items():
            print(f"  condition {k}: {'OK' if v else 'NO'}")
        print(f"\n=== {res['verdict']} ===")
    RESULTS.mkdir(exist_ok=True)
    (RESULTS / "live_eval_latest.json").write_text(json.dumps(res, indent=2))


if __name__ == "__main__":
    main()
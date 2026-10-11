"""One-shot final test (PROTOCOL.md v1.4, section 10).

    python src/final_test.py

Safeguards: runs only once, only if Gate 1 = PASS, and only if PROTOCOL.md, src/ and tests/
are committed in git. Do not edit these rules after seeing the result.
"""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LinearRegression

from baselines import FLOOR, TARGET, forecasts, mae, qlike, rmse
from diagnostics import HAR3, lad_forecast
from gate1 import BLOCK_LENGTHS, MIN_IMPROVEMENT, block_bootstrap_ci
from train_volatility import FEATURES, make_model
from walk_forward import EMBARGO, FINAL_TEST, load_features

ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "results"


def split_final(df: pd.DataFrame):
    """Train: t + 24h < final start (includes validation). Test: rows inside the final period."""
    fs = pd.Timestamp(FINAL_TEST[0], tz="UTC")
    fe = pd.Timestamp(FINAL_TEST[1], tz="UTC")
    train = df[df.index + EMBARGO < fs]
    test = df[(df.index >= fs) & (df.index < fe)]
    return train, test


def git_state():
    """Returns (is_clean, head_hash). is_clean is None if git cannot be queried."""
    try:
        st = subprocess.run(["git", "status", "--porcelain", "--", "PROTOCOL.md", "src", "tests"],
                            cwd=ROOT, capture_output=True, text=True, check=True)
        head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True)
    except Exception:  # noqa: BLE001
        return None, "unknown"
    lines = [ln for ln in st.stdout.splitlines() if "__pycache__" not in ln]
    return (len(lines) == 0), head.stdout.strip()


def main() -> None:
    pred_path = RESULTS / "final_test_predictions.csv"
    if pred_path.exists():
        sys.exit("Final test already ran. It is one-shot: a re-run is not allowed.")

    g1_path = RESULTS / "gate1_result.json"
    if not g1_path.exists() or json.loads(g1_path.read_text()).get("verdict") != "PASS":
        sys.exit("Gate 1 is not PASS (or gate1_result.json is missing). The final test must not run.")

    clean, head = git_state()
    if clean is not True:
        sys.exit("PROTOCOL.md / src / tests are not fully committed (or git is unavailable). "
                 "Commit protocol v1.4 and the code first, then run again.")

    params = json.loads((RESULTS / "chosen_params.json").read_text())["params"]
    df = load_features()
    train, test = split_final(df)
    fs = pd.Timestamp(FINAL_TEST[0], tz="UTC")
    assert (train.index + EMBARGO < fs).all() and test.index.min() >= fs, "split leaks"
    print(f"git commit: {head}")
    print(f"train rows: {len(train)} (up to {train.index.max():%Y-%m-%d %H:%M})")
    print(f"final test rows: {len(test)} ({test.index.min():%Y-%m-%d} to {test.index.max():%Y-%m-%d})")

    fc = forecasts(train, test)  # persistence, rolling_168h, har_rv
    har_x = LinearRegression().fit(train[FEATURES], train[TARGET])
    cand = make_model(params).fit(train[FEATURES], train[TARGET])
    preds = pd.DataFrame({
        "y": test[TARGET].to_numpy(),
        **fc,
        "candidate": np.maximum(cand.predict(test[FEATURES]), FLOOR),
        "har_x": np.maximum(har_x.predict(test[FEATURES]), FLOOR),
        "har_lad": lad_forecast(train, test, HAR3).to_numpy(),
        "har_x_lad": lad_forecast(train, test, FEATURES).to_numpy(),
    }, index=test.index)
    preds.index.name = "timestamp"
    RESULTS.mkdir(exist_ok=True)
    preds.to_csv(pred_path)

    y = preds["y"].to_numpy()
    har_mae = mae(y, preds["har_rv"].to_numpy())
    rows = []
    for m in ["persistence", "rolling_168h", "har_rv", "candidate", "har_x", "har_lad", "har_x_lad"]:
        f = preds[m].to_numpy()
        rows.append({"model": m, "MAE": mae(y, f), "MAE_vs_har_rv": (har_mae - mae(y, f)) / har_mae,
                     "RMSE": rmse(y, f), "QLIKE": qlike(y, f),
                     "bias": f.mean() / y.mean() - 1, "share f<y": float((f < y).mean())})
    table = pd.DataFrame(rows)
    pd.set_option("display.width", 160)
    print("\n" + table.to_string(index=False, float_format=lambda v: f"{v:.6f}"))

    # Pre-registered confirmation: candidate vs HAR-RV
    base_err = np.abs(y - preds["har_rv"].to_numpy())
    d = base_err - np.abs(y - preds["candidate"].to_numpy())
    improvement = float(d.sum() / base_err.sum())
    cis = {b: block_bootstrap_ci(d, base_err, b) for b in BLOCK_LENGTHS}
    ci_ok = all(lo > 0 for lo, _ in cis.values())
    if improvement >= MIN_IMPROVEMENT and ci_ok:
        verdict = "CONFIRMED"
    elif improvement >= MIN_IMPROVEMENT:
        verdict = "INCONCLUSIVE"
    else:
        verdict = "NOT CONFIRMED"

    print(f"\nCONFIRMATION (pre-registered): candidate vs HAR-RV, MAE improvement = {improvement:+.2%} "
          f"(need >= {MIN_IMPROVEMENT:.0%})")
    for b, (lo, hi) in cis.items():
        print(f"  block {b:>2}h  95% CI = [{lo:+.2%}, {hi:+.2%}]  "
              f"{'lower bound > 0' if lo > 0 else 'lower bound NOT > 0'}")
    print("Models other than candidate/HAR-RV/persistence/rolling are EXPLORATORY: do not use them to pick a model.")
    print(f"\n=== FINAL TEST VERDICT: {verdict} ===")

    table.to_csv(RESULTS / "final_test_table.csv", index=False)
    (RESULTS / "final_test_result.json").write_text(json.dumps({
        "verdict": verdict, "protocol": "v1.4", "git_commit": head,
        "n_train": len(train), "n_test": len(test), "improvement_vs_har_rv": improvement,
        "bootstrap_ci_95": {str(b): list(ci) for b, ci in cis.items()},
        "params": params,
    }, indent=2))
    print(f"Saved {pred_path}, final_test_table.csv, final_test_result.json")


if __name__ == "__main__":
    main()
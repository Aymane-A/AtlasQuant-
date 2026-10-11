"""Gate 1 verdict (PROTOCOL.md sections 6 and 9). Reads results/predictions_folds.csv.

    python src/gate1.py

Thresholds are the pre-registered ones; do not change them after seeing results.
"""
import json
import subprocess
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "results"

MIN_FOLDS_WON = 4          # of 5
MIN_IMPROVEMENT = 0.05     # pooled relative MAE improvement over best baseline
BLOCK_LENGTHS = (24, 48, 72)
N_BOOT = 2000
SEED = 12345
BASELINES = ["persistence", "rolling_168h", "har_rv"]


def block_bootstrap_ci(d: np.ndarray, base: np.ndarray, block: int):
    """Moving-block bootstrap of ratio = sum(d) / sum(base); d = base_error - candidate_error."""
    n = len(d)
    k = int(np.ceil(n / block))
    rng = np.random.default_rng(SEED)
    starts = rng.integers(0, n - block + 1, size=(N_BOOT, k))
    cd = np.concatenate([[0.0], np.cumsum(d)])
    cb = np.concatenate([[0.0], np.cumsum(base)])
    sum_d = (cd[starts + block] - cd[starts]).sum(axis=1)
    sum_b = (cb[starts + block] - cb[starts]).sum(axis=1)
    lo, hi = np.percentile(sum_d / sum_b, [2.5, 97.5])
    return float(lo), float(hi)


def git_hash() -> str:
    try:
        out = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True)
        return out.stdout.strip() or "unknown"
    except Exception:  # noqa: BLE001
        return "unknown"


def main() -> None:
    preds = pd.read_csv(RESULTS / "predictions_folds.csv", index_col="timestamp", parse_dates=True).sort_index()
    ae = lambda col: (preds["y"] - preds[col]).abs()  # noqa: E731

    # Condition 1: per-fold MAE vs persistence AND HAR-RV
    fold_rows, won = [], 0
    for fold, g in preds.groupby("fold"):
        m = {c: float((g["y"] - g[c]).abs().mean()) for c in BASELINES + ["har_x", "candidate"]}
        beats = m["candidate"] < m["persistence"] and m["candidate"] < m["har_rv"]
        won += int(beats)
        fold_rows.append({"fold": fold, **{k: round(v, 6) for k, v in m.items()}, "candidate_beats_both": beats})
    folds = pd.DataFrame(fold_rows)
    n_folds = len(folds)
    cond1 = won >= MIN_FOLDS_WON

    # Condition 2: pooled relative improvement vs best baseline (lowest pooled MAE of the three)
    pooled = {c: float(ae(c).mean()) for c in BASELINES + ["har_x", "candidate"]}
    best_name = min(BASELINES, key=lambda c: pooled[c])
    improvement = (pooled[best_name] - pooled["candidate"]) / pooled[best_name]
    cond2 = improvement >= MIN_IMPROVEMENT

    # Condition 3: block-bootstrap CI of the improvement
    base_err = ae(best_name).to_numpy()
    d = base_err - ae("candidate").to_numpy()
    cis = {b: block_bootstrap_ci(d, base_err, b) for b in BLOCK_LENGTHS}
    ci_ok = all(lo > 0 for lo, _ in cis.values())

    if cond1 and cond2 and ci_ok:
        verdict = "PASS"
    elif cond1 and cond2:
        verdict = "INCONCLUSIVE"
    else:
        verdict = "FAIL"

    pd.set_option("display.width", 140)
    print(folds.to_string(index=False))
    print(f"\nCondition 1: candidate beats persistence AND HAR-RV in {won}/{n_folds} folds "
          f"(need >= {MIN_FOLDS_WON}): {'OK' if cond1 else 'NO'}")
    print(f"Pooled MAE: " + ", ".join(f"{k}={v:.6f}" for k, v in pooled.items()))
    print(f"Condition 2: best baseline = {best_name}; improvement = {improvement:+.2%} "
          f"(need >= {MIN_IMPROVEMENT:.0%}): {'OK' if cond2 else 'NO'}")
    for b, (lo, hi) in cis.items():
        print(f"Condition 3: block {b:>2}h  95% CI of improvement = [{lo:+.2%}, {hi:+.2%}]  "
              f"{'lower bound > 0' if lo > 0 else 'lower bound NOT > 0'}")
    if not (cond1 and cond2) and improvement > 0 and cis[24][0] > 0:
        print("Note: a small improvement may exist, but it is below the pre-registered threshold.")

    har_x_imp = (pooled[best_name] - pooled["har_x"]) / pooled[best_name]
    cand_vs_harx = (pooled["har_x"] - pooled["candidate"]) / pooled["har_x"]
    print(f"\nDiagnostic (not part of the gate): HAR-X vs best baseline = {har_x_imp:+.2%}; "
          f"candidate vs HAR-X = {cand_vs_harx:+.2%}")
    print(f"\n=== GATE 1 VERDICT: {verdict} ===")

    (RESULTS / "gate1_result.json").write_text(json.dumps({
        "verdict": verdict, "protocol": "v1.3", "git_commit": git_hash(),
        "folds_won": won, "n_folds": n_folds, "best_baseline": best_name,
        "pooled_mae": pooled, "improvement": improvement,
        "bootstrap_ci_95": {str(b): list(ci) for b, ci in cis.items()},
        "n_boot": N_BOOT, "seed": SEED,
    }, indent=2))
    print(f"Saved {RESULTS / 'gate1_result.json'}")


if __name__ == "__main__":
    main()
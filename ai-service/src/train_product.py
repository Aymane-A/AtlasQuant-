"""Fit the product model "har-lad-v1" (PROTOCOL.md v1.6, section 12) and write models/har_lad_v1.json.

    python src/train_product.py

- har_lad: L1 (LAD) linear regression of RV_next24 on RV_d, RV_w, RV_m, fitted on ALL rows.
- baseline_har_rv: the OLS version, stored only so the backend can log it for live comparison.
- Risk thresholds and percentiles come from the in-sample forecast distribution.
- Interval ratios (q05, q50, q95 of y / f) and the OOS MAE come from the 5 walk-forward folds.
"""
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from baselines import FLOOR, TARGET
from diagnostics import HAR3, lad_forecast
from verify_lad import irls_with_info
from walk_forward import FOLDS, load_features, split_fold

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "models" / "har_lad_v1.json"
MODEL_VERSION = "har-lad-v1"
PRODUCT_IRLS_ITERS = 5000   # evaluation used 200; see PROTOCOL change log 1.6.1


def git_hash() -> str:
    try:
        out = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True)
        return out.stdout.strip() or "unknown"
    except Exception:  # noqa: BLE001
        return "unknown"


def main() -> None:
    df = load_features()
    X, y = df[HAR3].to_numpy(), df[TARGET].to_numpy()

    beta, irls_iters, irls_converged = irls_with_info(X, y, iters=PRODUCT_IRLS_ITERS)
    if not irls_converged:
        print(f"WARNING: IRLS did not reach tol 1e-12 in {PRODUCT_IRLS_ITERS} iterations (see verify_lad.py)")
    fitted = np.maximum(beta[0] + X @ beta[1:], FLOOR)
    percentiles = np.percentile(fitted, np.arange(0, 101))
    low_max, medium_max = np.percentile(fitted, [100 / 3, 200 / 3])

    # Baseline HAR-RV (OLS), for live monitoring only
    A = np.column_stack([np.ones(len(y)), X])
    ols = np.linalg.lstsq(A, y, rcond=None)[0]

    # Out-of-sample calibration from the 5 folds
    ratios, abs_err, per_fold = [], [], {}
    for name, ts, te in FOLDS:
        train, test = split_fold(df, ts, te)
        f = lad_forecast(train, test, HAR3).to_numpy()
        yt = test[TARGET].to_numpy()
        ratios.append(yt / f)
        abs_err.append(np.abs(yt - f))
        per_fold[name] = (yt, f)
    ratio = np.concatenate(ratios)
    q05, q50, q95 = np.percentile(ratio, [5, 50, 95])
    oos_mae = float(np.concatenate(abs_err).mean())

    print("fold coverage of [q05, q95] range (info only):")
    for name, (yt, f) in per_fold.items():
        inside = np.mean((yt >= f * q05) & (yt <= f * q95))
        print(f"  {name}: {inside:.1%}")

    artifact = {
        "model_version": MODEL_VERSION,
        "protocol": "v1.6",
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
        "git_commit": git_hash(),
        "features": HAR3,
        "fit_method": f"LAD (L1) via IRLS, max {PRODUCT_IRLS_ITERS} iterations, tol 1e-12; checked against the exact LP solution in src/verify_lad.py",
        "irls_iterations": int(irls_iters),
        "irls_converged": bool(irls_converged),
        "train_mae_hourly_std": float(np.mean(np.abs(y - (beta[0] + X @ beta[1:])))),
        "intercept": float(beta[0]),
        "coef": {k: float(v) for k, v in zip(HAR3, beta[1:])},
        "baseline_har_rv": {"intercept": float(ols[0]), "coef": {k: float(v) for k, v in zip(HAR3, ols[1:])}},
        "risk_thresholds": {"low_max": float(low_max), "medium_max": float(medium_max)},
        "percentiles": [float(v) for v in percentiles],
        "interval_ratio": {"q05": float(q05), "q50": float(q50), "q95": float(q95)},
        "oos_mae_hourly_std": oos_mae,
        "data_start": df.index.min().isoformat(),
        "trained_through": df.index.max().isoformat(),
        "n_train_rows": int(len(df)),
    }
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(artifact, indent=2))

    print(f"\nHAR-LAD: intercept={beta[0]:.6f}  " + "  ".join(f"{k}={v:.4f}" for k, v in zip(HAR3, beta[1:])))
    print(f"risk thresholds (hourly std): low <= {low_max:.5f} < medium <= {medium_max:.5f} < high")
    print(f"interval ratios y/f: q05={q05:.3f} q50={q50:.3f} q95={q95:.3f} | OOS MAE (5 folds) = {oos_mae:.6f}")
    print(f"Saved {OUT}")


if __name__ == "__main__":
    main()
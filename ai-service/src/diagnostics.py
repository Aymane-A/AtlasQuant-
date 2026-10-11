"""POST-HOC diagnostics on the 5 walk-forward folds (run after Gate 1).

These numbers explain the Gate 1 result. They do NOT change the verdict and
must NOT be used to modify or re-tune the candidate.

Adds two L1 (median / least-absolute-deviation, fitted by IRLS) linear models, because the
candidate is trained with an absolute-error loss while HAR-RV is trained with
squared error (mean). Part of a MAE gap can come from that loss mismatch alone.

    python src/diagnostics.py      (takes a few seconds)
"""
from pathlib import Path

import numpy as np
import pandas as pd

from baselines import FLOOR, TARGET, mae, qlike, rmse
from train_volatility import FEATURES
from walk_forward import FOLDS, load_features, split_fold

RESULTS = Path(__file__).resolve().parents[1] / "results"
HAR3 = ["RV_d", "RV_w", "RV_m"]


def lad_fit(X: np.ndarray, y: np.ndarray, iters: int = 200) -> np.ndarray:
    """Least-absolute-deviation regression via iteratively reweighted least squares."""
    A = np.column_stack([np.ones(len(y)), X])
    beta = np.linalg.lstsq(A, y, rcond=None)[0]
    for _ in range(iters):
        r = y - A @ beta
        sw = np.sqrt(1.0 / np.maximum(np.abs(r), 1e-7))
        new = np.linalg.lstsq(A * sw[:, None], y * sw, rcond=None)[0]
        done = np.max(np.abs(new - beta)) < 1e-12
        beta = new
        if done:
            break
    return beta


def lad_forecast(train, test, cols):
    beta = lad_fit(train[cols].to_numpy(), train[TARGET].to_numpy())
    pred = beta[0] + test[cols].to_numpy() @ beta[1:]
    return pd.Series(np.maximum(pred, FLOOR), index=test.index)


def main() -> None:
    preds = pd.read_csv(RESULTS / "predictions_folds.csv", index_col="timestamp", parse_dates=True).sort_index()
    df = load_features()

    lad3, lad5 = [], []
    for name, ts, te in FOLDS:
        train, test = split_fold(df, ts, te)
        lad3.append(lad_forecast(train, test, HAR3))
        lad5.append(lad_forecast(train, test, FEATURES))
        print(f"{name} done")
    preds["har_lad"] = pd.concat(lad3)
    preds["har_x_lad"] = pd.concat(lad5)

    models = ["persistence", "rolling_168h", "har_rv", "har_x", "har_lad", "har_x_lad", "candidate"]
    y = preds["y"].to_numpy()
    base = mae(y, preds["har_rv"].to_numpy())
    rows = []
    for m in models:
        f = preds[m].to_numpy()
        rows.append({
            "model": m, "MAE": mae(y, f), "MAE_vs_har_rv": (base - mae(y, f)) / base,
            "RMSE": rmse(y, f), "QLIKE": qlike(y, f),
            "bias (mean f / mean y - 1)": f.mean() / y.mean() - 1,
            "share f < y": float((f < y).mean()),
        })
    res = pd.DataFrame(rows)
    res.to_csv(RESULTS / "diagnostics_posthoc.csv", index=False)
    pd.set_option("display.width", 160)
    print("\nPOOLED over the 5 folds (post-hoc, exploratory):")
    print(res.to_string(index=False, float_format=lambda v: f"{v:.6f}"))

    print("\nPer-fold MAE: candidate vs har_x_lad (L1 linear, same 5 features)")
    for fold, g in preds.groupby("fold"):
        a = mae(g["y"].to_numpy(), g["candidate"].to_numpy())
        b = mae(g["y"].to_numpy(), g["har_x_lad"].to_numpy())
        print(f"  {fold}: candidate={a:.6f}  har_x_lad={b:.6f}  {'candidate better' if a < b else 'har_x_lad better'}")
    print(f"\nSaved {RESULTS / 'diagnostics_posthoc.csv'}")


if __name__ == "__main__":
    main()
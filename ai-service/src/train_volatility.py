"""Volatility candidate (PROTOCOL.md v1.3, section 9).

Two steps, each meant to be run ONCE:
    python src/train_volatility.py tune       # 10 fixed trials, validation period only
    python src/train_volatility.py evaluate   # frozen params, 5 walk-forward folds

Outputs (in results/): tuning_validation.csv, chosen_params.json, predictions_folds.csv
Then run: python src/gate1.py
"""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import LinearRegression

from baselines import FLOOR, TARGET, forecasts, mae, qlike, rmse
from walk_forward import EMBARGO, FOLDS, HORIZON, VALIDATION, load_features, split_fold

ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "results"
FEATURES = ["RV_d", "RV_w", "RV_m", "range_24h", "vol_change_24h"]

# (learning_rate, max_iter, max_depth, min_samples_leaf, l2_regularization): same list as PROTOCOL section 9
TRIAL_TUPLES = [
    (0.05, 200, 3, 100, 0.0),
    (0.05, 200, 3, 500, 0.0),
    (0.05, 400, 3, 100, 0.0),
    (0.03, 300, 4, 200, 0.0),
    (0.03, 300, 4, 500, 0.0),
    (0.10, 100, 3, 200, 0.0),
    (0.05, 300, 5, 300, 0.0),
    (0.02, 500, 3, 200, 0.0),
    (0.05, 200, 2, 200, 0.0),
    (0.03, 400, 6, 500, 1.0),
]
KEYS = ["learning_rate", "max_iter", "max_depth", "min_samples_leaf", "l2_regularization"]
TRIALS = [dict(zip(KEYS, t)) for t in TRIAL_TUPLES]


def make_model(params: dict) -> HistGradientBoostingRegressor:
    # early_stopping=False: sklearn's internal early-stopping split is random (would shuffle time order)
    return HistGradientBoostingRegressor(
        loss="absolute_error", early_stopping=False, random_state=42, **params
    )


def split_validation(df: pd.DataFrame):
    """Train: t + 24h < validation start. Validation rows: label window must end before the
    final-test period (t + 24h < validation end), so the final test stays untouched."""
    vs = pd.Timestamp(VALIDATION[0], tz="UTC")
    ve = pd.Timestamp(VALIDATION[1], tz="UTC")
    train = df[df.index + EMBARGO < vs]
    val = df[(df.index >= vs) & (df.index + HORIZON < ve)]
    return train, val


def git_hash() -> str:
    try:
        out = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True)
        return out.stdout.strip() or "unknown"
    except Exception:  # noqa: BLE001
        return "unknown"


def tune() -> None:
    tuning_csv = RESULTS / "tuning_validation.csv"
    if tuning_csv.exists():
        sys.exit("Tuning already ran. Re-tuning needs a NEW protocol version (and deleting this file on purpose).")
    RESULTS.mkdir(exist_ok=True)

    df = load_features()
    train, val = split_validation(df)
    print(f"train rows: {len(train)} | validation rows: {len(val)} "
          f"({val.index.min():%Y-%m-%d} to {val.index.max():%Y-%m-%d})")

    rows = []
    for i, params in enumerate(TRIALS, start=1):
        model = make_model(params).fit(train[FEATURES], train[TARGET])
        pred = np.maximum(model.predict(val[FEATURES]), FLOOR)
        rows.append({"trial": i, **params, "val_MAE": mae(val[TARGET].to_numpy(), pred)})
        print(f"trial {i:>2}: val MAE = {rows[-1]['val_MAE']:.6f}  {params}")

    res = pd.DataFrame(rows)
    res.to_csv(tuning_csv, index=False)
    best = res.loc[res["val_MAE"].idxmin()]
    chosen = {k: (int(best[k]) if k in ("max_iter", "max_depth", "min_samples_leaf") else float(best[k]))
              for k in KEYS}
    (RESULTS / "chosen_params.json").write_text(json.dumps({
        "params": chosen, "trial": int(best["trial"]), "val_MAE": float(best["val_MAE"]),
        "protocol": "v1.3", "git_commit": git_hash(),
    }, indent=2))

    ref = forecasts(train, val)
    print("\nReference on validation (context only):")
    for name, f in ref.items():
        print(f"  {name:<13} MAE = {mae(val[TARGET].to_numpy(), f):.6f}")
    print(f"\nChosen trial {int(best['trial'])}: {chosen}\nSaved results/chosen_params.json (FROZEN).")


def evaluate() -> None:
    chosen_path = RESULTS / "chosen_params.json"
    pred_path = RESULTS / "predictions_folds.csv"
    if not chosen_path.exists():
        sys.exit("Run `python src/train_volatility.py tune` first.")
    if pred_path.exists():
        sys.exit("Fold evaluation already ran. A re-run needs a NEW protocol version (delete the file on purpose).")

    params = json.loads(chosen_path.read_text())["params"]
    df = load_features()
    parts = []
    for name, ts, te in FOLDS:
        train, test = split_fold(df, ts, te)
        fc = forecasts(train, test)  # persistence, rolling_168h, har_rv
        har_x = LinearRegression().fit(train[FEATURES], train[TARGET])
        cand = make_model(params).fit(train[FEATURES], train[TARGET])
        out = pd.DataFrame({
            "fold": name,
            "y": test[TARGET].to_numpy(),
            **fc,
            "har_x": np.maximum(har_x.predict(test[FEATURES]), FLOOR),
            "candidate": np.maximum(cand.predict(test[FEATURES]), FLOOR),
        }, index=test.index)
        parts.append(out)
        print(f"{name}: train {len(train)} | test {len(test)}")

    preds = pd.concat(parts).sort_index()
    preds.index.name = "timestamp"
    preds.to_csv(pred_path)

    models = ["persistence", "rolling_168h", "har_rv", "har_x", "candidate"]
    rows = []
    for fold, g in list(preds.groupby("fold")) + [("POOLED", preds)]:
        for m in models:
            rows.append({"fold": fold, "model": m, "MAE": mae(g["y"].to_numpy(), g[m].to_numpy()),
                         "RMSE": rmse(g["y"].to_numpy(), g[m].to_numpy()),
                         "QLIKE": qlike(g["y"].to_numpy(), g[m].to_numpy())})
    res = pd.DataFrame(rows)
    res.to_csv(RESULTS / "candidate_folds.csv", index=False)
    pd.set_option("display.width", 140)
    print("\n" + res.to_string(index=False, float_format=lambda v: f"{v:.6f}"))
    print(f"\nSaved {pred_path}\nNext: python src/gate1.py")


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in ("tune", "evaluate"):
        sys.exit("Usage: python src/train_volatility.py [tune|evaluate]")
    tune() if sys.argv[1] == "tune" else evaluate()
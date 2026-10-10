"""Baselines for the 24h realized-volatility forecast (PROTOCOL.md section 4).

- persistence : forecast = RV_d (last 24h std)
- rolling     : forecast = RV_w (last 168h std)
- har_rv      : LinearRegression of RV_next24 on RV_d, RV_w, RV_m, fit on train only

Metrics: MAE (primary), RMSE, QLIKE on variances:
    QLIKE = mean(r - ln(r) - 1),  r = y^2 / f^2   (forecasts floored at 1e-6)

Run from the ai-service folder:
    python src/baselines.py
"""
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LinearRegression

from walk_forward import FOLDS, load_features, split_fold

TARGET = "RV_next24"
HAR_COLS = ["RV_d", "RV_w", "RV_m"]
FLOOR = 1e-6
RESULTS = Path(__file__).resolve().parents[1] / "results"


def mae(y, f):
    return float(np.mean(np.abs(y - f)))


def rmse(y, f):
    return float(np.sqrt(np.mean((y - f) ** 2)))


def qlike(y, f):
    f = np.maximum(f, FLOOR)
    y = np.maximum(y, FLOOR)
    ratio = (y ** 2) / (f ** 2)
    return float(np.mean(ratio - np.log(ratio) - 1))


def forecasts(train: pd.DataFrame, test: pd.DataFrame) -> dict:
    har = LinearRegression().fit(train[HAR_COLS], train[TARGET])
    return {
        "persistence": test["RV_d"].to_numpy(),
        "rolling_168h": test["RV_w"].to_numpy(),
        "har_rv": np.maximum(har.predict(test[HAR_COLS]), FLOOR),
    }


def main() -> None:
    df = load_features()
    rows, pooled_y, pooled_f = [], [], {}
    for name, ts, te in FOLDS:
        train, test = split_fold(df, ts, te)
        y = test[TARGET].to_numpy()
        pooled_y.append(y)
        for model, f in forecasts(train, test).items():
            pooled_f.setdefault(model, []).append(f)
            rows.append({
                "fold": name, "model": model, "n_train": len(train), "n_test": len(test),
                "MAE": mae(y, f), "RMSE": rmse(y, f), "QLIKE": qlike(y, f),
            })

    y_all = np.concatenate(pooled_y)
    for model, parts in pooled_f.items():
        f_all = np.concatenate(parts)
        rows.append({
            "fold": "POOLED", "model": model, "n_train": np.nan, "n_test": len(y_all),
            "MAE": mae(y_all, f_all), "RMSE": rmse(y_all, f_all), "QLIKE": qlike(y_all, f_all),
        })

    res = pd.DataFrame(rows)
    RESULTS.mkdir(exist_ok=True)
    res.to_csv(RESULTS / "baselines_folds.csv", index=False)
    pd.set_option("display.width", 140)
    print(res.to_string(index=False, float_format=lambda v: f"{v:.6f}"))
    print(f"\nSaved {RESULTS / 'baselines_folds.csv'}")


if __name__ == "__main__":
    main()
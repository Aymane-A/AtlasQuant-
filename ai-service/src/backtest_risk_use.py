"""Risk-management backtest (PROTOCOL.md v1.5, section 11).

    python src/backtest_risk_use.py

Simulation only: long-only BTC, exposure = min(1, target_vol / forecast), one decision per day.
Runs once, and only if PROTOCOL.md, src/ and tests/ are committed in git.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LinearRegression

from baselines import FLOOR, TARGET, forecasts
from diagnostics import HAR3, lad_forecast
from final_test import git_state
from train_volatility import FEATURES, make_model, split_validation
from walk_forward import FOLDS, load_features, split_fold

ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "results"
CLEAN = ROOT / "data" / "processed" / "BTCUSDT_1h_clean.csv"

CAP = 1.0
COST_MAIN = 0.0015                 # 10 bps fee + 5 bps slippage per unit of turnover
COST_SENS = (0.0005, 0.0030)
PPY = 365                          # decisions (days) per year
BLOCK_DAYS = 10
N_BOOT = 2000
SEED = 12345
DD_TOL = 0.01                      # 1 percentage point
MODELS = ["persistence", "rolling_168h", "har_rv", "har_x", "har_lad", "har_x_lad", "candidate"]


def masked_close() -> pd.Series:
    """Hourly close grid; missing or zero-volume candles are NaN (same rule as build_features.py)."""
    df = pd.read_csv(CLEAN, parse_dates=["timestamp"]).set_index("timestamp").asfreq("h")
    invalid = df["close"].isna() | (df["volume"] == 0)
    return df["close"].where(~invalid)


def forecast_frame(train: pd.DataFrame, test: pd.DataFrame, params: dict) -> pd.DataFrame:
    frame = pd.DataFrame(forecasts(train, test), index=test.index)
    har_x = LinearRegression().fit(train[FEATURES], train[TARGET])
    frame["har_x"] = np.maximum(har_x.predict(test[FEATURES]), FLOOR)
    frame["har_lad"] = lad_forecast(train, test, HAR3).to_numpy()
    frame["har_x_lad"] = lad_forecast(train, test, FEATURES).to_numpy()
    cand = make_model(params).fit(train[FEATURES], train[TARGET])
    frame["candidate"] = np.maximum(cand.predict(test[FEATURES]), FLOOR)
    return frame


def decision_blocks(frame: pd.DataFrame, target_vol: float, close: pd.Series) -> pd.DataFrame:
    """One row per day (candle opening 00:00 UTC): BTC return over the next 24h and the exposure of each model."""
    sub = frame[frame.index.hour == 0]
    out = pd.DataFrame(index=sub.index)
    out["R"] = (close.shift(-24) / close - 1).reindex(sub.index)
    for m in MODELS:
        out[m] = np.minimum(CAP, target_vol / np.maximum(sub[m].to_numpy(), FLOOR))
    out["buy_and_hold"] = 1.0
    return out.dropna()


def build_blocks(periods, close, params) -> pd.DataFrame:
    parts = []
    for name, train, test in periods:
        target_vol = float(train["RV_d"].median())
        parts.append(decision_blocks(forecast_frame(train, test, params), target_vol, close))
        print(f"{name}: train {len(train)} | test {len(test)} | target_vol {target_vol:.5f}")
    return pd.concat(parts).sort_index()


def strategy_returns(R: np.ndarray, w: np.ndarray, cost: float):
    w_prev = np.concatenate([[0.0], w[:-1]])
    turnover = np.abs(w - w_prev)
    return w * R - cost * turnover, turnover


def metrics(ret: np.ndarray, w: np.ndarray, turnover: np.ndarray) -> dict:
    equity = np.concatenate([[1.0], np.cumprod(1 + ret)])
    max_dd = float(np.max(1 - equity / np.maximum.accumulate(equity)))
    mean, std = ret.mean(), ret.std(ddof=1)
    downside = np.sqrt(np.mean(np.minimum(ret, 0) ** 2))
    return {
        "ann_return": float(equity[-1] ** (PPY / len(ret)) - 1),
        "ann_vol": float(std * np.sqrt(PPY)),
        "sharpe": float(mean / std * np.sqrt(PPY)),
        "sortino": float(mean / downside * np.sqrt(PPY)) if downside > 0 else float("nan"),
        "max_drawdown": max_dd,
        "avg_exposure": float(w.mean()),
        "avg_turnover": float(turnover.mean()),
        "worst_day": float(ret.min()),
    }


def sharpe_diff_ci(a: np.ndarray, b: np.ndarray):
    n = len(a)
    k = int(np.ceil(n / BLOCK_DAYS))
    rng = np.random.default_rng(SEED)
    starts = rng.integers(0, n - BLOCK_DAYS + 1, size=(N_BOOT, k))

    def sharpe(x):
        cs = np.concatenate([[0.0], np.cumsum(x)])
        cs2 = np.concatenate([[0.0], np.cumsum(x ** 2)])
        s = (cs[starts + BLOCK_DAYS] - cs[starts]).sum(axis=1)
        s2 = (cs2[starts + BLOCK_DAYS] - cs2[starts]).sum(axis=1)
        m = s / (k * BLOCK_DAYS)
        v = s2 / (k * BLOCK_DAYS) - m ** 2
        return m / np.sqrt(v) * np.sqrt(PPY)

    lo, hi = np.percentile(sharpe(a) - sharpe(b), [2.5, 97.5])
    return float(lo), float(hi)


def table(blocks: pd.DataFrame):
    R = blocks["R"].to_numpy()
    rows, rets = [], {}
    for m in ["buy_and_hold"] + MODELS:
        w = blocks[m].to_numpy()
        ret, turn = strategy_returns(R, w, COST_MAIN)
        rets[m] = ret
        row = {"strategy": m, **metrics(ret, w, turn)}
        for c in COST_SENS:
            r2, _ = strategy_returns(R, w, c)
            row[f"sharpe@{int(c * 10000)}bps"] = float(r2.mean() / r2.std(ddof=1) * np.sqrt(PPY))
        rows.append(row)
    return pd.DataFrame(rows), rets


def main() -> None:
    decision_path = RESULTS / "risk_backtest_decision.json"
    if decision_path.exists():
        sys.exit("Risk backtest already ran. A re-run is only for a bug fix: delete the decision file on purpose "
                 "and log it in the PROTOCOL change log.")
    clean, head = git_state()
    if clean is not True:
        sys.exit("PROTOCOL.md / src / tests are not fully committed (or git is unavailable). Commit v1.5 and the code first.")

    params = json.loads((RESULTS / "chosen_params.json").read_text())["params"]
    df = load_features()
    close = masked_close()

    print("== 5 walk-forward folds (decision data) ==")
    fold_periods = [(name, *split_fold(df, ts, te)) for name, ts, te in FOLDS]
    blocks = build_blocks(fold_periods, close, params)
    res, rets = table(blocks)

    print("\n== validation period (secondary; candidate tuned here) ==")
    val_train, val_test = split_validation(df)
    val_blocks = build_blocks([("validation", val_train, val_test)], close, params)
    val_res, _ = table(val_blocks)

    pd.set_option("display.width", 200)
    fmt = lambda v: f"{v:.4f}"  # noqa: E731
    print(f"\nDECISION DATA: {len(blocks)} daily blocks, net of {COST_MAIN * 10000:.0f} bps per unit of turnover")
    print(res.to_string(index=False, float_format=fmt))
    print(f"\nSECONDARY (validation): {len(val_blocks)} daily blocks")
    print(val_res.to_string(index=False, float_format=fmt))

    # Rule A
    by = res.set_index("strategy")
    bh, har = by.loc["buy_and_hold"], by.loc["har_rv"]
    rule_a = bool(har["max_drawdown"] < bh["max_drawdown"] and har["sharpe"] >= bh["sharpe"])

    # Rule B
    qualified, ci_report = [], {}
    for m in MODELS:
        if m == "har_rv":
            continue
        lo, hi = sharpe_diff_ci(rets[m], rets["har_rv"])
        ok = lo > 0 and by.loc[m, "max_drawdown"] <= har["max_drawdown"] + DD_TOL
        ci_report[m] = {"sharpe_diff_ci95": [lo, hi], "qualifies": bool(ok)}
        if ok:
            qualified.append(m)
        print(f"Rule B  {m:<13} Sharpe diff vs HAR-RV 95% CI = [{lo:+.3f}, {hi:+.3f}]  "
              f"maxDD {by.loc[m, 'max_drawdown']:.3f} vs {har['max_drawdown']:.3f}  -> {'QUALIFIES' if ok else 'no'}")
    product = max(qualified, key=lambda m: by.loc[m, "sharpe"]) if qualified else "har_rv"

    print(f"\nRule A (HAR-RV sizing: lower max drawdown AND Sharpe >= buy-and-hold): "
          f"maxDD {har['max_drawdown']:.3f} vs {bh['max_drawdown']:.3f}, Sharpe {har['sharpe']:.2f} vs {bh['sharpe']:.2f} "
          f"-> {'USEFUL' if rule_a else 'NO DEMONSTRATED RISK BENEFIT'}")
    print(f"Rule B: product forecast = {product}")
    print("\n=== Simulation only; not a trading signal and not financial advice. ===")

    RESULTS.mkdir(exist_ok=True)
    res.to_csv(RESULTS / "risk_backtest_folds.csv", index=False)
    val_res.to_csv(RESULTS / "risk_backtest_validation.csv", index=False)
    decision_path.write_text(json.dumps({
        "protocol": "v1.5", "git_commit": head, "rule_a_useful": rule_a, "rule_b": ci_report,
        "product_forecast": product, "n_blocks": len(blocks), "cost_main": COST_MAIN,
    }, indent=2))
    print(f"Saved results/risk_backtest_folds.csv, risk_backtest_validation.csv, risk_backtest_decision.json")


if __name__ == "__main__":
    main()
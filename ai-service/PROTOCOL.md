# PROTOCOL.md: AtlasQuant volatility experiment (v1.3)

Written: 2026-10-11 (before any model result was seen)
v1.0 commit hash (pre-registration): `bdd5bdce706514f8a9fc87820e2866084e4467aa`
v1.1 commit hash: see `git log -- ai-service/PROTOCOL.md` (a file cannot contain its own hash)

> Rule: this file is changed only by a NEW dated version with a written reason.
> Never edit a decision after looking at results.

## 1. Market and data
- Market: BTC/USDT spot (Binance public API)
- Interval: 1h candles, timestamps in UTC (candle open time)
- Full range: 2020-01-01 00:00 UTC to 2026-09-30 23:00 UTC
- Raw data is never modified. Processed data is a separate file.
- Missing candles are reported, NOT filled (no forward-fill).

## 2. Target and features
- Hourly log return: r_t = ln(P_t / P_(t-1)), P = close
- Target: RV_next24(t) = std of r_(t+1) ... r_(t+24), ddof=1
- Annualization: NONE (raw hourly std everywhere)
- Rows without a full 24h future window are dropped
- Features (past-only, available at time t):
  - RV_d  = std of last 24 returns  (r_(t-23)..r_t)
  - RV_w  = std of last 168 returns
  - RV_m  = std of last 720 returns
  - extras (ML candidate only): high-low range (last 24h mean), volume change (24h vs previous 24h)
- Future returns appear ONLY in the label column.

## 3. Data split (fixed now)
- Initial train start: 2020-01-01
- Walk-forward: 5 expanding-window folds, each test block = 6 months
  - Fold 1 test: 2023-01-01 to 2023-06-30
  - Fold 2 test: 2023-07-01 to 2023-12-31
  - Fold 3 test: 2024-01-01 to 2024-06-30
  - Fold 4 test: 2024-07-01 to 2024-12-31
  - Fold 5 test: 2025-01-01 to 2025-06-30
- Validation (threshold/decision choices only): 2025-07-01 to 2026-03-31
- FINAL TEST (untouched until everything is locked): 2026-04-01 to 2026-09-30
- Embargo: 24h gap. Drop every training row with timestamp t such that t + 24h >= first timestamp of the evaluation window. Applies to all folds and the final test.
- A pytest must fail if any training label window overlaps an evaluation window.

## 4. Models
- Persistence: forecast = RV_d
- Rolling baseline: fixed past-only window (168h std)
- HAR-RV: linear regression of RV_next24 on RV_d, RV_w, RV_m, fit on training data only per fold
- ML candidate: HistGradientBoostingRegressor, fully specified in section 9.
- HAR-X (diagnostic only, not part of any gate): LinearRegression on the same 5 features as the candidate.

## 5. Metrics
- Primary: MAE on RV_next24
- Secondary: RMSE, QLIKE (or MAE on log RV)
- QLIKE is computed on variances: mean(r - ln(r) - 1) with r = y^2 / f^2; forecasts are floored at 1e-6.
- Report per-fold values and pooled relative improvement:
  improvement = (MAE_best_baseline - MAE_candidate) / MAE_best_baseline

## 6. Gate 1 (predeclared)
PASS only if ALL are true:
1. Candidate has lower MAE than BOTH persistence and HAR-RV in at least 4 of 5 folds
2. Pooled relative MAE improvement over the best baseline >= 5%
3. Paired block bootstrap (block length 24h, 2000 resamples; sensitivity check at 48h and 72h): 95% CI of the improvement excludes zero

If (1) and (2) hold but the CI includes zero: "inconclusive" (NOT pass).
If it fails: write "no demonstrated edge", keep HAR-RV as benchmark, do not add complexity to rescue the result.

## 7. Gate 3 (if the product is a risk indicator)
- Paper-test the live forecast for 8-12 weeks; log forecast and realized volatility 24h later
- Compare live MAE/QLIKE with backtest fold range, against persistence and HAR-RV running in parallel
- If a trading strategy is simulated: 100+ completed simulated trades, stop threshold 10% drawdown (stop and review)
- This protocol does not authorize live trading.

## 8. Data-quality rules (added in v1.1, from validation_report.json)
Validation found: 59,128 candles, 0 duplicates, 0 NaN, 0 bad OHLC, 15 gaps (32 missing candles,
max gap 5h, all between 2020-02 and 2023-03), 2 zero-volume candles.
Rules, fixed before any model result:
1. Missing candles are never filled. The hourly grid is rebuilt so gaps appear as NaN rows.
2. A candle is INVALID if it is missing or has volume == 0.
3. The return r_t is NaN if candle t or candle t-1 is invalid.
4. 24h windows (RV_d, target RV_next24, range, volume change) must be complete: any NaN inside the window drops the row.
5. Long windows (RV_w 168h, RV_m 720h): std over the available returns if at least 95% of the window is valid (>=160 of 168, >=684 of 720); otherwise the row is dropped.
6. Rows are dropped BEFORE splitting into folds. The embargo (section 3) still applies afterwards.
7. The number of dropped rows is reported in the experiment log.

## 9. Candidate model, tuning and Gate 1 operational rules (added in v1.3)
Decided before any candidate result was seen.

Candidate
- Model: sklearn HistGradientBoostingRegressor(loss="absolute_error", early_stopping=False, random_state=42).
  early_stopping is OFF because sklearn's internal early-stopping split is random (a shuffle of time-ordered rows).
- Features: RV_d, RV_w, RV_m, range_24h, vol_change_24h. Target: RV_next24 (raw, not log).

Tuning (validation period only, never on the folds or the final test)
- Exactly 10 trials, fixed list below, run ONCE. Selection rule: lowest MAE on validation.
- Validation training rows: t + 24h < 2025-07-01 (embargo). Validation rows: t >= 2025-07-01 and t + 24h < 2026-04-01,
  so no validation label window reaches into the final test period.
- Trials (learning_rate, max_iter, max_depth, min_samples_leaf, l2_regularization):
  1. 0.05, 200, 3, 100, 0.0
  2. 0.05, 200, 3, 500, 0.0
  3. 0.05, 400, 3, 100, 0.0
  4. 0.03, 300, 4, 200, 0.0
  5. 0.03, 300, 4, 500, 0.0
  6. 0.10, 100, 3, 200, 0.0
  7. 0.05, 300, 5, 300, 0.0
  8. 0.02, 500, 3, 200, 0.0
  9. 0.05, 200, 2, 200, 0.0
  10. 0.03, 400, 6, 500, 1.0
- After selection the parameters are FROZEN (results/chosen_params.json). Fold evaluation is run ONCE.
  Any re-run with different choices requires a new protocol version with a written reason.

Gate 1 operational definitions
- Folds: the 5 walk-forward folds of section 3 only. Candidate is refit on each fold's training window with frozen parameters.
- Condition 1 compares per-fold MAE against persistence and HAR-RV (as in section 6). rolling_168h is reported but not part of condition 1.
- "Best baseline" (condition 2) = the lowest pooled MAE among persistence, rolling_168h and HAR-RV over the 5 folds.
- Bootstrap: moving-block bootstrap on the pooled, time-ordered test rows (a block = 24 consecutive rows; 48 and 72 as sensitivity),
  2000 resamples, seed 12345. Statistic: relative MAE improvement over the best baseline. Interval: 95% percentile.
- Verdict:
  - PASS: conditions 1 and 2 hold AND the 95% CI lower bound > 0 for block lengths 24, 48 and 72.
  - INCONCLUSIVE: conditions 1 and 2 hold but the CI includes zero for at least one block length.
  - FAIL: condition 1 or condition 2 does not hold ("no demonstrated edge"; HAR-RV stays the product benchmark).
- If Gate 1 = PASS, the frozen candidate is evaluated ONCE on the final test period and the result is reported whatever it is.
- Order of work: commit this protocol and the code, then run tuning, then fold evaluation, then gate1. HAR-X is reported, never used to rescue a verdict.

## 10. Change log
| Version | Date | Change | Reason |
|---|---|---|---|
| 1.0 | 2026-10-11 | Initial protocol | n/a |
| 1.1 | 2026-10-11 | Added data-quality rules (section 8) | Gaps and zero-volume candles found in validation; decided before any feature or model result |
| 1.2 | 2026-10-11 | QLIKE definition and forecast floor | Not defined in v1.0; documented after the baseline run, before any candidate result |
| 1.3 | 2026-10-11 | Candidate model, tuning trials and Gate 1 operational rules (section 9) | Make the candidate and the gate fully specified before any candidate result |
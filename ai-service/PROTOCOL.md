# PROTOCOL.md: AtlasQuant volatility experiment (v1.8)

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

## 10. Final test: one-shot confirmation (added in v1.4)
Decided after Gate 1 = PASS and after the post-hoc diagnostics, BEFORE any final-test result was seen.

Setup
- Final test period: 2026-04-01 to 2026-09-30 (rows with a full 24h target; the last 24 candles have no target and are dropped).
- Training window: every row with t + 24h < 2026-04-01 (this includes the validation period; the embargo still applies).
- Candidate: HistGradientBoostingRegressor with the FROZEN parameters in results/chosen_params.json, refit once on that window. No re-tuning.
- Baselines are refit on the same window: persistence, rolling_168h, HAR-RV (OLS on RV_d, RV_w, RV_m).
- The final test is run ONCE (src/final_test.py refuses a second run). The result is reported whatever it is.
- final_test.py refuses to run unless Gate 1 = PASS and PROTOCOL.md, src/ and tests/ are committed in git.

Confirmation criterion (the only pre-registered decision)
- Reference model: HAR-RV (it was the best baseline in Gate 1).
- improvement = (MAE_HAR-RV - MAE_candidate) / MAE_HAR-RV on the final test rows.
- CONFIRMED: improvement >= 5% AND the 95% moving-block-bootstrap CI lower bound > 0 for block lengths 24, 48 and 72
  (2000 resamples, seed 12345, same function as Gate 1).
- INCONCLUSIVE: improvement >= 5% but the CI lower bound is not > 0 for at least one block length.
- NOT CONFIRMED: improvement < 5%.
- This confirms (or not) the candidate-versus-HAR-RV claim of Gate 1 in a period never used for any choice. It does NOT decide which model AtlasQuant ships.

Exploratory (descriptive only)
- Also reported on the final test: har_x, har_lad, har_x_lad (post-hoc models from the diagnostics), plus QLIKE, RMSE, bias (mean f / mean y - 1)
  and the share of hours with f < y.
- These are NOT used to select a model, to change the candidate, or to rescue a verdict. Picking the best of many models on the
  final test would burn it.

Model choice for the product
- Decided in a separate risk-management backtest with its own protocol (v1.5), using the walk-forward folds and the validation period only.
  The criteria there are risk metrics (drawdown, strategy volatility, turnover, costs), not MAE alone, because under-forecasting
  volatility (bias) is the harmful direction for position sizing.
- HAR-RV stays the product benchmark whatever the final test says.

## 11. Risk-management backtest (added in v1.5)
Decided after the final test CONFIRMED the candidate (see change log 1.4.1), BEFORE any risk-backtest result was seen.
Purpose: decide which volatility forecast AtlasQuant shows and whether a forecast-based sizing rule has any demonstrated risk
benefit. Research indicator only; not a trading signal, not financial advice.

Data used
- The 5 walk-forward folds (2023-01-01 to 2025-06-30) for ALL decisions. The validation period (2025-07-01 to 2026-03-30) is reported
  as a secondary check only (the candidate's parameters were tuned there, so its numbers are optimistic).
- The final test period and any later data are NOT used.
- Forecasts for each period come from models refit on that period's training window (same splits, embargo and frozen candidate
  parameters as before).

Strategy (simulation only)
- Long-only BTC/USDT spot, rest in cash at 0% return. No leverage, no shorting.
- One decision per day: candles that open at 00:00 UTC. The exposure chosen from the features at row t is held over the next 24 hourly
  returns r_(t+1)..r_(t+24) (the same window as the target). Days without a feature row are skipped (no return, previous exposure kept).
- Exposure w = min(1.0, target_vol / forecast), where forecast is the model's RV_next24 forecast (floored at 1e-6) and
  target_vol = median of RV_d over the period's training window (past-only).
- Benchmark: buy-and-hold (w = 1 on the same days).
- Models compared: persistence, rolling_168h, har_rv, har_x, har_lad, har_x_lad, candidate.
- Block return = w * (P_(t+24) / P_t - 1) - cost * |w - w_prev|, with w_prev = 0 at the very first block. Main cost = 15 bps per unit of
  turnover (10 fee + 5 slippage). Sensitivity (Sharpe only): 5 bps and 30 bps.

Metrics (pooled, chronological, over the 5 folds, net of costs)
- Annualized return and volatility (365 periods per year), Sharpe and Sortino (risk-free 0), max drawdown, average exposure,
  average daily turnover, worst day.

Decision rules (fixed)
- Rule A, is forecast-based sizing useful at all? Yes only if har_rv sizing has a LOWER max drawdown than buy-and-hold AND a Sharpe
  >= buy-and-hold. Otherwise: "no demonstrated risk benefit"; the forecast is shown only as an information indicator, with no sizing claim.
- Rule B, which forecast ships? Default = HAR-RV. Another model replaces it only if (1) the paired moving-block bootstrap
  (10-day blocks, 2000 resamples, seed 12345) of the Sharpe difference (model - HAR-RV) has a 95% lower bound > 0, AND (2) its max
  drawdown is <= HAR-RV's max drawdown + 1 percentage point. If several qualify, the highest Sharpe wins.
- Results are reported whatever they are. src/backtest_risk_use.py runs once and refuses a re-run (a re-run is allowed only to fix a
  bug, deleting the decision file on purpose and logging it in the change log).

## 12. Product indicator specification (added in v1.6)
Decided after the risk backtest (Rule A: no demonstrated risk benefit; Rule B: har_lad), before any product or live result.

What ships
- Model: "har-lad-v1" = linear regression of RV_next24 on RV_d, RV_w, RV_m fitted with an absolute-error (L1 / LAD) loss on ALL rows
  available at training time (2020-01-31 to 2026-09-29). Stored as JSON (coefficients, thresholds, calibration), no pickle.
- It is a volatility INFORMATION indicator. Rule A applies: the API and UI return NO exposure, position size, buy/sell or "protection" claim.
- No automatic retraining. Any refit creates a new model_version and a new entry in this protocol.

Outputs and definitions
- forecast.hourly_std: forecast of the std of the next 24 hourly log returns (floored at 1e-6). Not annualized.
- forecast.move_24h_pct_1sigma: hourly_std * sqrt(24) * 100 (a derived, approximate 1-sigma size of a 24h move; not a prediction of direction).
- forecast.range_90: [hourly_std * q05, hourly_std * q95], where q05 and q95 are quantiles of y / f over the 5 out-of-sample walk-forward folds.
- risk.level: low / medium / high = bottom / middle / top third of the in-sample forecast distribution over the training window (p33.3, p66.7).
  It is RELATIVE to the model's own history, not an absolute danger scale. risk.historical_percentile is the same information on a 0-100 scale.
- monitoring.persistence and monitoring.har_rv: baseline forecasts returned only so the backend can log them for live comparison.
- Mandatory wording wherever shown: research indicator based on historical data, can be wrong, not financial advice; show the "as_of" time and the range.

Inputs and validation (service side)
- At least 721 and at most 2000 closed hourly BTCUSDT candles (UTC, aligned to the hour, unique, ascending after sorting), fields timestamp, high, low, close, volume.
- Features are computed with the SAME code as training (src/build_features.build); a parity test must pass.
- Rejected with HTTP 422: not enough candles, duplicate or unaligned timestamps, last candle not closed yet, or features not computable
  (gaps or zero-volume candles inside the last 24 hours, or more than 5% invalid returns in the 168h / 720h windows).
- The service is called server-side only (Node/Express). If AI_SERVICE_KEY is set, requests need the X-API-Key header.

Failure behavior
- If the service is down, slow (timeout) or returns an error, the app shows "forecast unavailable". No forecast is computed in Node
  (a second implementation would risk training/serving skew). The rest of AtlasQuant keeps working.

Live monitoring (Gate 3 for an indicator; no trades are involved)
- The backend logs, for every successful forecast: as_of, model_version, inputs, forecast, range_90, risk level, monitoring baselines.
  24 hours later it logs the realized value RV_next24 computed from the closed candles.
- Duration: at least 8 weeks. Evaluation uses hourly forecasts with a moving-block bootstrap (24h blocks) for uncertainty.
- Pass conditions, fixed now: (1) har_lad MAE < persistence MAE; (2) har_lad MAE <= 1.02 x HAR-RV MAE; (3) share of realized values inside
  range_90 between 80% and 95%; (4) a successful forecast for at least 95% of hours.
- If any condition fails: mark the indicator "experimental" or hide it, and investigate; do not silently retrain or change thresholds.

## 13. Live paper-monitoring procedure (added in v1.7, runner changed in v1.8)
Implementation details of the Gate 3 plan in section 12. Decided BEFORE the first live forecast was logged.
v1.8 changes only WHERE the logger runs (GitHub Actions instead of a developer PC); no model, window, metric or threshold changed.

Runner
- src/paper_log.py runs every hour from a GitHub Actions workflow (.github/workflows/paper-log.yml, cron "5 * * * *", plus manual
  workflow_dispatch). It needs no server: it calls app.predict.predict with the frozen artifact models/har_lad_v1.json
  (the same function the API uses).
- GitHub cron is best-effort: a run can start late (minutes) or be skipped. This is accepted and measured by condition 4, never corrected afterwards.
- Each run fetches the last ~1000 Binance 1h candles (api.binance.com, fallback data-api.binance.vision), keeps CLOSED candles only,
  merges them into data/live/candles.csv (unique timestamps), and logs the forecast for the latest closed candle (source = "live").
- Missing hours inside the last 24 hours are filled with source = "backfill": same frozen model, using only data up to that hour.
  Backfilled rows count for accuracy but NEVER for availability.
- Every run is recorded in data/live/run_log.csv (ok or error), including failed runs. Logged fields (data/live/forecasts.csv):
  as_of, source, logged_at_utc, model_version, model_sha256 (first 12 hex chars), RV_d, RV_w, RV_m, forecast_hourly_std, range_low,
  range_high, risk_level, historical_percentile, persistence, har_rv.
- The workflow commits candles.csv, forecasts.csv and run_log.csv to the repository after every run; the git history is the audit trail
  (commit timestamps are GitHub's, not editable by the logger). Rows already logged are never rewritten or deleted.
- No retraining. If model_sha256 changes during monitoring, the monitoring restarts under a new model_version.

Evaluation (src/evaluate_live.py, Gate 3 conditions of section 12)
- Run locally after `git pull`. Realized value = RV_next24 computed from the stored candles with src.build_features.build
  (same rules as training: invalid candles, std ddof=1, no annualization). Hours whose target window is invalid or not yet complete
  are excluded from accuracy and counted.
- Accuracy uses all logged rows with a realized value (live + backfill; both counts are reported). Uncertainty: moving-block bootstrap, 24h blocks.
- Condition 4 (availability) = number of distinct "live" hours / number of hours between the first and the last logged hour.
  It measures this logger (GitHub Actions scheduling, network, Binance availability, data validity), not the Node service.
  Node-side logs, when they exist, add the service uptime as a separate figure.
- Duration: at least 56 days between the first logged hour and the last hour with a realized value. Before that, results are INTERIM
  and informational only: no verdict, no stopping early on good or bad interim numbers.
- Verdict after 56 days: PASS only if all four conditions of section 12 hold, otherwise FAIL (the failed conditions are listed).
- Any change to cadence, windows, runner or rules requires a new protocol version. Interruptions (workflow disabled by GitHub,
  Binance outage) are NOT repaired by hand-editing logs; they simply lower availability.

## 14. Change log
| Version | Date | Change | Reason |
|---|---|---|---|
| 1.0 | 2026-10-11 | Initial protocol | n/a |
| 1.1 | 2026-10-11 | Added data-quality rules (section 8) | Gaps and zero-volume candles found in validation; decided before any feature or model result |
| 1.2 | 2026-10-11 | QLIKE definition and forecast floor | Not defined in v1.0; documented after the baseline run, before any candidate result |
| 1.3 | 2026-10-11 | Candidate model, tuning trials and Gate 1 operational rules (section 9) | Make the candidate and the gate fully specified before any candidate result |
| 1.3.1 | 2026-10-11 | Record: v1.3 committed AFTER tune/evaluate/gate1 were run | Commit step was skipped; file content unchanged since writing, check file timestamps |
| 1.3.2 | 2026-10-11 | Post-hoc diagnostics (L1 HAR models, bias) added after Gate 1 | They do not change the verdict or the candidate; they inform the model choice for the product |
| 1.4 | 2026-10-11 | One-shot final test and confirmation criterion (section 10) | Specified after Gate 1 PASS, before any final-test result |
| 1.4.1 | 2026-10-11 | Record: final test ran from commit 7f3709e, CONFIRMED (candidate vs HAR-RV +9.98% MAE) | Outcome recorded; no rule was changed. Final test is now used |
| 1.5 | 2026-10-11 | Risk-management backtest and model-choice rules (section 11) | Specified before any risk-backtest result |
| 1.5.1 | 2026-10-11 | Record: risk backtest ran; Rule A = no demonstrated risk benefit; Rule B = har_lad (see results/risk_backtest_decision.json) | Outcome recorded; no rule was changed |
| 1.6 | 2026-10-11 | Product indicator specification (section 12) | Specified before any product or live result; Rule A means no sizing claims |
| 1.6.1 | 2026-10-11 | Product fit uses up to 5000 IRLS iterations and records convergence (artifact fields irls_iterations, irls_converged) | verify_lad.py showed the 200-iteration fit used in evaluation had not reached tol 1e-12 on all rows (MAE within ~1e-8 relative of the exact LP on subsamples). Same model family; no result or rule changed |
| 1.7 | 2026-10-11 | Live paper-monitoring procedure (section 13) | Implementation details of the Gate 3 plan; specified before the first live forecast was logged |
| 1.8 | 2026-10-12 | Runner moved from a developer PC (Task Scheduler) to GitHub Actions; logs committed by the workflow (section 13) | The PC cannot stay on 24/7 for 8 weeks; decided BEFORE the first live forecast was logged. No model, window, metric, threshold or condition changed |
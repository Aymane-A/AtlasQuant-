# Model 3 — Independent Anomaly Detection (research, informational only)

No trades, forecasts used for trading, risk changes, backend routes, schedulers, or imports from
HAR-LAD / regime_detection. Writes only to `ai-service/anomaly_detection_artifacts` (exclusive create,
never overwrite). Raw data is read-only. No new dependency (numpy, pandas, scipy, scikit-learn, threadpoolctl).

## What it computes (hourly, BTCUSDT 1h)
Features at hour t use data <= t only; missing/zero-volume candles stay NaN (no fill):
`ret` (log return), `range` (log high/low), `rv` (24h std of returns), `log_volume_ratio`
(volume vs past-168h median, shifted so the spike is not in its own baseline).

1. **Robust Z** — median/MAD over the PREVIOUS 720 hours (needs >= 360 valid). Score = max |z| over features.
2. **Isolation Forest** — refit every 720 hours on the previous 8760 hours; each block is scored by a model
   that never saw it. Score = -score_samples (higher = more unusual). Splits are scale-invariant, so no scaler.
3. **Severity** — Normal / Elevated / Extreme = train-only 99th / 99.9th percentile of each detector's score;
   combined severity = the higher of the two. Robust thresholds are fixed from the first 60% only.
4. **Report** — timestamp, scores, severities, top-2 contributing features (robust z; the forest itself is not decomposed).
Unscored reasons: `warmup`, `missing_features`, `constant_feature`.

## Protocol
Chronological 60/20/20 split. Thresholds are written to `preregistration.json` before validation/holdout are
evaluated; the holdout is evaluated once. No threshold tuning, no random splits.

## Commands (PowerShell, from `ai-service`)
```powershell
$env:OPENBLAS_NUM_THREADS='1'; $env:OMP_NUM_THREADS='1'
.venv/Scripts/python.exe -B -m src.anomaly_detection validate --run historical_v1
# only after reviewing summary.json:
.venv/Scripts/python.exe -B -m src.anomaly_detection freeze --run frozen_v1
.venv/Scripts/python.exe -B -m src.anomaly_detection shadow --detector C:/AtlasQuant-/ai-service/anomaly_detection_artifacts/frozen_v1/frozen --data <local_csv> --run shadow_v1
```
`shadow` reads a LOCAL CSV, records one report per closed hourly candle, makes no network call, creates no
scheduler, and never retrains. Tests: `tests/anomaly_detection`.

## Limitations
- No labeled anomalies: alarm rates and episodes are descriptive, not accuracy.
- A score is "unusual versus recent history", not a crash probability, forecast, or trading signal.
- The forward-volatility association is evaluation-only, uses overlapping windows, and is not predictive evidence.
- A prolonged crisis is absorbed by the rolling baseline after about 30 days.
- Single asset, one data source; frozen artifacts use pickle (load only files you created; hash + sklearn version checked).
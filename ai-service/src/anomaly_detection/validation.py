import hashlib
import platform
import numpy as np
import pandas as pd
import scipy
import sklearn
from pathlib import Path
from threadpoolctl import threadpool_limits
from .config import Config, FEATURES, ALARMS, safe_path
from .data import load_hourly
from .detectors import robust_z
from .features import build_features
from .pipeline import split_positions, thresholds_from_train, score_table, report_record
from .store import publish_json, publish_csv

LIMITATIONS = [
    'No independently labeled anomalies exist: results are descriptive, not accuracy or detection-rate claims',
    'Scores measure unusualness versus recent history; they are not crash probabilities, forecasts or signals',
    'Forward-volatility association is evaluation-only, uses overlapping windows, and is not predictive evidence',
    'Single asset and one hourly feed; heavy tails and regime changes shift alarm rates over time',
    'A true anomaly regime (e.g. a prolonged crisis) is absorbed by the rolling baseline after about 30 days',
]


def episodes(flags, gap):
    positions = np.flatnonzero(np.asarray(flags))
    if positions.size == 0:
        return []
    groups, start, last = [], positions[0], positions[0]
    for p in positions[1:]:
        if p - last > gap:
            groups.append((start, last))
            start = p
        last = p
    groups.append((start, last))
    return groups


def forward_rv(ret, hours):
    """Volatilité réalisée des `hours` heures APRÈS t. Utilisée pour l'ÉVALUATION seulement."""
    return ret.rolling(hours, min_periods=hours).std(ddof=1).shift(-hours)


def evaluate(table, fwd, cfg):
    out = {'rows': int(len(table)), 'start': str(table.index[0]), 'end': str(table.index[-1]),
           'status_counts': table.status.value_counts().to_dict()}
    for name, col in (('robust', 'robust_severity'), ('iforest', 'iforest_severity'), ('combined', 'severity')):
        sev = table[col]
        n = int((sev != 'Unscored').sum())
        eps = episodes(sev.isin(ALARMS), cfg.episode_gap_hours)
        lengths = [e - s + 1 for s, e in eps]
        out[name] = {'scored_rows': n,
                     'elevated_or_higher_rate': float(sev.isin(ALARMS).sum() / n) if n else None,
                     'extreme_rate': float((sev == 'Extreme').sum() / n) if n else None,
                     'episodes': len(eps), 'mean_episode_hours': float(np.mean(lengths)) if lengths else None,
                     'max_episode_hours': int(max(lengths)) if lengths else None}
    both = (table.robust_severity != 'Unscored') & (table.iforest_severity != 'Unscored')
    a, b = table.robust_severity[both].isin(ALARMS), table.iforest_severity[both].isin(ALARMS)
    union = int((a | b).sum())
    out['agreement_jaccard'] = float((a & b).sum() / union) if union else None
    zc = ['z_' + c for c in FEATURES]
    alarm_z = table.loc[table.severity.isin(ALARMS), zc].abs().dropna(how='all')
    out['top_feature_counts'] = ({k[2:]: int(v) for k, v in alarm_z.idxmax(axis=1).value_counts().items()}
                                 if len(alarm_z) else {})
    starts = [table.index[s] for s, _ in episodes(table.severity == 'Extreme', cfg.episode_gap_hours)]
    base = fwd.reindex(table.index).dropna()
    at = fwd.reindex(starts).dropna()
    out['event_study'] = {'extreme_episodes': len(starts), 'episodes_with_forward_window': int(len(at)),
                          'median_forward_rv_ratio': (float(at.median() / base.median())
                                                      if len(at) >= 5 and len(base) else None),
                          'note': 'Descriptive association only; ratio of next-24h realized volatility after an '
                                  'Extreme episode start to the split median'}
    return out


def alarm_records(table, split):
    rows = table[table.severity.isin(ALARMS)]
    return [{**report_record(table, ts), 'split': split} for ts in rows.index]


@threadpool_limits.wrap(limits=1)
def run(data, output, cfg=Config()):
    output = safe_path(output)
    output.mkdir(parents=True, exist_ok=False)
    ohlcv = load_hourly(data)
    features = build_features(ohlcv, cfg)
    n = len(features)
    if n < cfg.min_total_rows:
        raise ValueError('Insufficient history for chronological validation')
    a, b = split_positions(n)
    _, _, rscore = robust_z(features, cfg)
    thresholds = thresholds_from_train(rscore.iloc[:a], cfg)  # ✅ seuils figés sur l'entraînement SEULEMENT
    publish_json(output / 'preregistration.json', {
        'config': cfg.dict(), 'features': list(FEATURES), 'cadence': '1H',
        'dataset': str(data), 'dataset_sha256': hashlib.sha256(Path(data).read_bytes()).hexdigest(),
        'split': {'train': [str(features.index[0]), str(features.index[a - 1]), a],
                  'validation': [str(features.index[a]), str(features.index[b - 1]), b - a],
                  'holdout': [str(features.index[b]), str(features.index[-1]), n - b]},
        'robust_thresholds_from_train_only': thresholds,
        'severity': 'Normal < Elevated (train 99th pct) < Extreme (train 99.9th pct); combined = higher of both',
        'isolation_forest': 'walk-forward refit; each block scored by a model fitted only on earlier hours',
        'versions': {'python': platform.python_version(), 'numpy': np.__version__, 'pandas': pd.__version__,
                     'scipy': scipy.__version__, 'sklearn': sklearn.__version__}})
    table = score_table(features, cfg, a, thresholds)
    fwd = forward_rv(features['ret'], cfg.rv_hours)
    results = {'train': evaluate(table.iloc[:a], fwd, cfg)}
    results['validation'] = evaluate(table.iloc[a:b], fwd, cfg)
    publish_json(output / 'validation_metrics.json', results['validation'])
    results['holdout'] = evaluate(table.iloc[b:], fwd, cfg)   # ouvert une seule fois, après gel des seuils
    publish_json(output / 'holdout_metrics.json', results['holdout'])
    publish_csv(output / 'scores.csv', table)
    publish_json(output / 'alarms.json', alarm_records(table.iloc[a:b], 'validation')
                 + alarm_records(table.iloc[b:], 'holdout'))
    publish_json(output / 'summary.json', {
        'status': 'experimental; descriptive only; no labeled ground truth, accuracy, or trading benefit established',
        'expected_elevated_rate_if_stationary': 1 - cfg.elevated_quantile,
        'thresholds': thresholds, 'results': results, 'limitations': LIMITATIONS})
    return output
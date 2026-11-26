import numpy as np
import pandas as pd
from .config import FEATURES
from .detectors import IsolationDetector, robust_z, severity, combine, check_frame


def split_positions(n):
    return int(n * .6), int(n * .8)


def thresholds_from_train(score, cfg):
    values = score.dropna()
    if len(values) < cfg.min_threshold_rows:
        raise ValueError('Insufficient scored rows to fix thresholds')
    return {'elevated': float(values.quantile(cfg.elevated_quantile)),
            'extreme': float(values.quantile(cfg.extreme_quantile)), 'rows': int(len(values))}


def walk_forward_iforest(features, start, cfg):
    """Chaque bloc de `refit_hours` est scoré par un modèle ajusté UNIQUEMENT sur les heures qui le précèdent."""
    n = len(features)
    cols = {k: pd.Series(np.nan, index=features.index) for k in ('score', 'elevated', 'extreme')}
    for s in range(start, n, cfg.refit_hours):
        detector = IsolationDetector(cfg).fit(features.iloc[max(0, s - cfg.iforest_train_hours):s])
        block = features.iloc[s:s + cfg.refit_hours]
        sl = slice(s, s + len(block))
        cols['score'].iloc[sl] = detector.score(block).to_numpy()
        cols['elevated'].iloc[sl] = detector.elevated
        cols['extreme'].iloc[sl] = detector.extreme
    return pd.DataFrame(cols)


def assemble(features, z, reason, rscore, thresholds, iso_score, iso_elevated, iso_extreme):
    table = pd.DataFrame(index=features.index)
    for c in FEATURES:
        table['z_' + c] = z[c]
    table['status'] = reason
    table['robust_score'] = rscore
    table['robust_severity'] = severity(rscore, thresholds['elevated'], thresholds['extreme'])
    table['iforest_score'] = iso_score
    table['iforest_severity'] = severity(iso_score, iso_elevated, iso_extreme)
    table['severity'] = combine(table.robust_severity, table.iforest_severity)
    return table


def score_table(features, cfg, start, thresholds):
    z, reason, rscore = robust_z(features, cfg)
    forest = walk_forward_iforest(features, start, cfg)
    return assemble(features, z, reason, rscore, thresholds, forest.score, forest.elevated, forest.extreme)


def report_record(table, timestamp, top=2):
    row = table.loc[timestamp]
    zs = row[[c for c in table.columns if c.startswith('z_')]].astype(float).dropna()
    ranked = zs.abs().sort_values(ascending=False).index[:top]
    return {'timestamp': pd.Timestamp(timestamp).isoformat(), 'severity': row.severity,
            'status': row.status, 'robust_score': row.robust_score, 'robust_severity': row.robust_severity,
            'iforest_score': row.iforest_score, 'iforest_severity': row.iforest_severity,
            'top_features': [{'feature': c[2:], 'robust_z': float(zs[c])} for c in ranked],
            'interpretation': 'Anomaly score relative to recent history; not a crash probability, '
                              'forecast, or trading signal'}
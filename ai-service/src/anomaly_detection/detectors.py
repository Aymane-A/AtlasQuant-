import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest
from .config import FEATURES, RANK


def check_frame(features):
    if list(features.columns) != list(FEATURES):
        raise ValueError('Unexpected feature columns')
    if not isinstance(features.index, pd.DatetimeIndex) or features.index.tz is None:
        raise ValueError('Timezone-aware DatetimeIndex required')
    if not features.index.is_monotonic_increasing or not features.index.is_unique:
        raise ValueError('Features must be chronological with unique timestamps')


def _mad(window):
    values = window[np.isfinite(window)]
    if values.size == 0:
        return np.nan
    return float(np.median(np.abs(values - np.median(values))))


def robust_z(features, cfg):
    """Z-score robuste (médiane/MAD) sur les `baseline_hours` PRÉCÉDENTES.
    Retourne (z, reason, score) ; score = max |z| sur les features, NaN si non évaluable."""
    check_frame(features)
    features = features.replace([np.inf, -np.inf], np.nan)
    shifted = features.shift(1)  # ✅ l'observation évaluée n'entre jamais dans sa propre baseline
    roll = shifted.rolling(cfg.baseline_hours, min_periods=cfg.min_baseline_hours)
    med = roll.median()
    scale = 1.4826 * roll.apply(_mad, raw=True)
    z = (features - med) / scale.where(scale > cfg.mad_floor)
    reason = pd.Series('ok', index=features.index, dtype=object)
    reason[scale.le(cfg.mad_floor).any(axis=1)] = 'constant_feature'
    reason[features.isna().any(axis=1)] = 'missing_features'
    reason[med.isna().any(axis=1)] = 'warmup'
    usable = reason == 'ok'
    return z.where(usable), reason, z.abs().max(axis=1).where(usable)


def severity(score, elevated, extreme):
    """Normal / Elevated / Extreme ; 'Unscored' si le score est NaN. Les seuils peuvent être des Series."""
    out = pd.Series('Unscored', index=score.index, dtype=object)
    ok = score.notna()
    out[ok] = 'Normal'
    out[ok & (score >= elevated)] = 'Elevated'
    out[ok & (score >= extreme)] = 'Extreme'
    return out


def combine(*severities):
    ranks = pd.concat([s.map(RANK) for s in severities], axis=1)
    best = ranks.max(axis=1)
    return best.map({0.0: 'Normal', 1.0: 'Elevated', 2.0: 'Extreme'}).fillna('Unscored')


class IsolationDetector:
    """Isolation Forest. Les splits sont invariants à l'échelle : pas de normalisation, donc rien à fuiter."""

    def __init__(self, cfg):
        self.cfg = cfg

    def fit(self, train):
        rows = train[list(FEATURES)].replace([np.inf, -np.inf], np.nan).dropna()
        if len(rows) < self.cfg.iforest_min_train_rows:
            raise ValueError('Insufficient training rows for Isolation Forest')
        x = rows.to_numpy()
        self.model = IsolationForest(n_estimators=self.cfg.iforest_trees, random_state=self.cfg.seed,
                                     n_jobs=1).fit(x)
        scores = -self.model.score_samples(x)  # plus grand = plus anormal
        self.elevated = float(np.quantile(scores, self.cfg.elevated_quantile))
        self.extreme = float(np.quantile(scores, self.cfg.extreme_quantile))
        return self

    @classmethod
    def from_parts(cls, cfg, model, elevated, extreme):
        obj = cls(cfg)
        obj.model, obj.elevated, obj.extreme = model, float(elevated), float(extreme)
        return obj

    def score(self, frame):
        x = frame[list(FEATURES)].replace([np.inf, -np.inf], np.nan)
        ok = x.notna().all(axis=1)
        out = pd.Series(np.nan, index=frame.index)
        if ok.any():
            out[ok] = -self.model.score_samples(x[ok].to_numpy())
        return out
import numpy as np
import pandas as pd
from .config import Config, FEATURES


def build_features(ohlcv, cfg=Config()):
    """Features horaires strictement causales : la valeur à t n'utilise que des données <= t.
    Aucun remplissage : une bougie manquante rend NaN toutes les fenêtres qui la contiennent."""
    c = ohlcv.close
    ret = np.log(c / c.shift(1))
    rng = np.log(ohlcv.high / ohlcv.low)
    rv = ret.rolling(cfg.rv_hours, min_periods=cfg.rv_hours).std(ddof=1)
    # médiane du volume sur le passé SEULEMENT (shift(1)) : un pic ne se dilue pas dans sa propre baseline
    med = ohlcv.volume.shift(1).rolling(cfg.volume_hours, min_periods=max(1, cfg.volume_hours // 2)).median()
    lvr = np.log(ohlcv.volume / med)
    out = pd.DataFrame({'ret': ret, 'range': rng, 'rv': rv, 'log_volume_ratio': lvr}, index=ohlcv.index)
    return out[list(FEATURES)].replace([np.inf, -np.inf], np.nan)
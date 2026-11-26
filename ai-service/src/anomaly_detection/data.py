import numpy as np
import pandas as pd

COLUMNS = ['open', 'high', 'low', 'close', 'volume']


def hourly_frame(frame):
    """Validation stricte OHLCV horaire. Bougies invalides -> NaN (jamais remplies)."""
    d = frame.copy()
    if 'open_time' in d:
        d['timestamp'] = pd.to_datetime(d['open_time'], unit='ms', utc=True)
    else:
        d['timestamp'] = pd.to_datetime(d['timestamp'], utc=True, errors='raise')
    d[COLUMNS] = d[COLUMNS].apply(pd.to_numeric, errors='raise')
    if d.empty or d.timestamp.isna().any() or d.timestamp.duplicated().any():
        raise ValueError('Empty data, invalid or duplicate timestamp')
    if not d.timestamp.is_monotonic_increasing:
        raise ValueError('Data must be chronological')
    if (d.timestamp != d.timestamp.dt.floor('h')).any():
        raise ValueError('Hourly timestamps must be aligned')
    if np.isinf(d[COLUMNS].to_numpy()).any():
        raise ValueError('Infinite OHLCV')
    complete = d[COLUMNS].notna().all(axis=1)
    invalid = ((d[['open', 'high', 'low', 'close']] <= 0).any(axis=1) | (d.volume < 0)
               | (d.high < d[['open', 'close', 'low']].max(axis=1))
               | (d.low > d[['open', 'close', 'high']].min(axis=1)))
    if (complete & invalid).any():
        raise ValueError('Invalid OHLCV geometry or value')
    d.loc[~complete | (d.volume == 0), COLUMNS] = np.nan
    return d.set_index('timestamp')[COLUMNS].asfreq('h')


def load_hourly(path):
    import pandas as pd
    return hourly_frame(pd.read_csv(path))
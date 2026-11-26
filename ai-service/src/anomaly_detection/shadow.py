import pandas as pd
from .config import safe_path
from .features import build_features
from .pipeline import report_record
from .store import publish_json


def record(frozen, ohlcv, output, now=None):
    """Record only: one exclusive report per closed hourly candle.
    No network, no scheduler, no trading decision, no HAR-LAD or HMM access."""
    now = pd.Timestamp.now(tz='UTC') if now is None else pd.Timestamp(now)
    if now.tzinfo is None:
        raise ValueError('Timezone-aware now required')
    features = build_features(ohlcv, frozen.cfg)
    table = frozen.score(features)
    ts = table.index[-1]
    close_time = ts + pd.Timedelta(hours=1)
    if close_time > now:
        raise ValueError('Latest candle is not closed yet')
    result = report_record(table, ts)
    result.update(recorded_at=now.isoformat(),
                  lag_hours=(now - close_time) / pd.Timedelta(hours=1),
                  trained_through=frozen.trained_through,
                  in_sample=bool(ts <= pd.Timestamp(frozen.trained_through)))
    target = safe_path(output) / 'reports' / (ts.strftime('%Y%m%dT%H%M%SZ') + '.json')
    try:
        publish_json(target, result)
        status = 'ok'
    except FileExistsError:
        status = 'already_recorded'
    return {'status': status, 'timestamp': str(ts), 'severity': result['severity']}

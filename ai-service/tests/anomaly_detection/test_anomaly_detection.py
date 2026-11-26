import json
import sys
import uuid
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'src'))
from anomaly_detection.config import Config, OUTPUT, FEATURES, safe_path
from anomaly_detection.data import hourly_frame
from anomaly_detection.detectors import robust_z, severity, combine
from anomaly_detection.features import build_features
from anomaly_detection.frozen import FrozenDetector
from anomaly_detection.pipeline import (split_positions, thresholds_from_train, score_table,
                                        walk_forward_iforest, report_record)
from anomaly_detection.shadow import record
from anomaly_detection.store import publish_json
from anomaly_detection.validation import run

# Petites fenêtres pour des tests rapides ; la logique est identique à la configuration de production.
CFG = Config(rv_hours=12, volume_hours=48, baseline_hours=96, min_baseline_hours=48, iforest_trees=50,
             iforest_train_hours=1000, iforest_min_train_rows=300, refit_hours=200,
             min_threshold_rows=300, min_total_rows=1500)


def candles(hours=3000, seed=3, spike_at=None, spike=.12):
    rng = np.random.default_rng(seed)
    r = rng.standard_t(5, hours) * .003
    if spike_at is not None:
        r[spike_at] = spike
    close = 100 * np.exp(np.cumsum(r))
    open_ = np.r_[close[0], close[:-1]]
    s = np.abs(rng.normal(.004, .001, hours))
    return pd.DataFrame({'timestamp': pd.date_range('2025-01-01', periods=hours, freq='h', tz='UTC'),
                         'open': open_, 'high': np.maximum(open_, close) * (1 + s),
                         'low': np.minimum(open_, close) * (1 - s), 'close': close,
                         'volume': rng.lognormal(4, .3, hours)})


def make_features(**kw):
    return build_features(hourly_frame(candles(**kw)), CFG)


@pytest.fixture
def out():
    return OUTPUT / 'test_tmp' / ('anomaly_' + uuid.uuid4().hex[:8])


def test_features_and_robust_scores_are_causal():
    raw = hourly_frame(candles())
    full = build_features(raw, CFG)
    cut = 2000
    pd.testing.assert_frame_equal(build_features(raw.iloc[:cut], CFG), full.iloc[:cut])
    z_full = robust_z(full, CFG)[2]
    z_cut = robust_z(full.iloc[:cut], CFG)[2]
    pd.testing.assert_series_equal(z_cut, z_full.iloc[:cut])


def test_observation_is_not_in_its_own_baseline_and_spike_is_extreme():
    f = make_features(spike_at=2500)
    _, reason, score = robust_z(f, CFG)
    ts = f.index[2500]
    assert reason[ts] == 'ok' and score[ts] > 20
    a, _ = split_positions(len(f))
    _, _, rs = robust_z(f, CFG)
    thr = thresholds_from_train(rs.iloc[:a], CFG)
    assert severity(score, thr['elevated'], thr['extreme'])[ts] == 'Extreme'


def test_warmup_missing_and_nonfinite_are_unscored_not_errors():
    raw = candles()
    raw.loc[2000, 'close'] = np.nan
    raw.loc[2100, 'volume'] = 0
    f = build_features(hourly_frame(raw), CFG)
    _, reason, score = robust_z(f, CFG)
    assert (reason.iloc[:CFG.min_baseline_hours] == 'warmup').all()
    assert reason.iloc[2000] == 'missing_features' and np.isnan(score.iloc[2000])
    assert reason.iloc[2100] == 'missing_features'
    f2 = f.copy()
    f2.iloc[2200, 0] = np.inf
    assert robust_z(f2, CFG)[1].iloc[2200] == 'missing_features'


def test_constant_feature_does_not_divide_by_zero():
    f = make_features()
    f['range'] = 0.01
    z, reason, score = robust_z(f, CFG)
    assert (reason.iloc[1000:] == 'constant_feature').all()
    assert score.iloc[1000:].isna().all() and not np.isinf(z.to_numpy(dtype=float)[~np.isnan(z.to_numpy(dtype=float))]).any()


@pytest.mark.parametrize('problem', ['duplicate', 'reverse', 'negative', 'geometry', 'infinite', 'unaligned'])
def test_invalid_inputs_are_rejected(problem):
    raw = candles(10)
    if problem == 'duplicate': raw.loc[1, 'timestamp'] = raw.loc[0, 'timestamp']
    if problem == 'reverse': raw = raw.iloc[::-1]
    if problem == 'negative': raw.loc[0, 'close'] = -1
    if problem == 'geometry': raw.loc[0, 'high'] = 0.0001
    if problem == 'infinite': raw.loc[0, 'close'] = np.inf
    if problem == 'unaligned': raw.loc[0, 'timestamp'] += pd.Timedelta(minutes=1)
    with pytest.raises(ValueError):
        hourly_frame(raw)
    with pytest.raises(ValueError):
        robust_z(make_features().iloc[::-1], CFG)


def test_thresholds_depend_on_train_only():
    f = make_features()
    a, _ = split_positions(len(f))
    base = thresholds_from_train(robust_z(f, CFG)[2].iloc[:a], CFG)
    changed = f.copy()
    changed.iloc[a:, 0] *= 50  # on massacre le futur
    again = thresholds_from_train(robust_z(changed, CFG)[2].iloc[:a], CFG)
    assert base == again


def test_isolation_forest_walk_forward_has_no_future_leakage_and_is_reproducible():
    f = make_features()
    start = 1800
    full = walk_forward_iforest(f, start, CFG)
    cut = start + 2 * CFG.refit_hours + 37
    short = walk_forward_iforest(f.iloc[:cut], start, CFG)
    pd.testing.assert_frame_equal(short, full.iloc[:cut])
    pd.testing.assert_frame_equal(walk_forward_iforest(f, start, CFG), full)
    assert full.score.iloc[:start].isna().all()
    changed = f.copy()
    changed.iloc[cut:, :] *= 10
    pd.testing.assert_frame_equal(walk_forward_iforest(changed, start, CFG).iloc[:cut], full.iloc[:cut])


def test_severity_and_combination():
    s = pd.Series([np.nan, 1., 5., 9.])
    out_ = severity(s, 4., 8.)
    assert list(out_) == ['Unscored', 'Normal', 'Elevated', 'Extreme']
    both = combine(out_, pd.Series(['Normal', 'Extreme', 'Unscored', 'Normal']))
    assert list(both) == ['Normal', 'Extreme', 'Elevated', 'Extreme']
    assert combine(pd.Series(['Unscored']), pd.Series(['Unscored'])).iloc[0] == 'Unscored'


def test_end_to_end_validation_report_and_no_overwrite(out):
    data = out / 'data.csv'
    out.mkdir(parents=True)
    raw = candles(spike_at=2600)
    raw.to_csv(data, index=False)
    run(data, out / 'run', CFG)
    summary = json.loads((out / 'run/summary.json').read_text())
    assert summary['thresholds']['elevated'] < summary['thresholds']['extreme']
    assert summary['results']['holdout']['combined']['scored_rows'] > 0
    assert summary['limitations'] and 'no labeled ground truth' in summary['status']
    prereg = json.loads((out / 'run/preregistration.json').read_text())
    assert prereg['robust_thresholds_from_train_only'] == summary['thresholds']
    alarms = json.loads((out / 'run/alarms.json').read_text())
    spike_ts = str(pd.Timestamp('2025-01-01', tz='UTC') + pd.Timedelta(hours=2600))
    hit = [a for a in alarms if a['timestamp'].startswith(spike_ts.replace(' ', 'T')[:19])]
    assert hit and hit[0]['severity'] == 'Extreme' and hit[0]['top_features']
    assert 'not a crash probability' in hit[0]['interpretation']
    with pytest.raises(FileExistsError):
        run(data, out / 'run', CFG)


def test_serialization_reload_and_tamper_detection(out):
    f = make_features()
    frozen = FrozenDetector.fit(f, CFG)
    frozen.save(out / 'frozen')
    loaded = FrozenDetector.load(out / 'frozen')
    pd.testing.assert_frame_equal(frozen.score(f), loaded.score(f))
    (out / 'frozen/iforest.pkl').write_bytes(b'tampered')
    with pytest.raises(ValueError, match='hash mismatch'):
        FrozenDetector.load(out / 'frozen')


def test_shadow_records_once_and_rejects_open_candle(out):
    raw = hourly_frame(candles())
    frozen = FrozenDetector.fit(build_features(raw, CFG), CFG)
    now = raw.index[-1] + pd.Timedelta(hours=1)
    assert record(frozen, raw, out, now)['status'] == 'ok'
    assert record(frozen, raw, out, now)['status'] == 'already_recorded'
    assert len(list((out / 'reports').glob('*.json'))) == 1
    with pytest.raises(ValueError, match='not closed'):
        record(frozen, raw, out, raw.index[-1] + pd.Timedelta(minutes=30))


def test_report_record_fields():
    f = make_features(spike_at=2500)
    a, _ = split_positions(len(f))
    thr = thresholds_from_train(robust_z(f, CFG)[2].iloc[:a], CFG)
    table = score_table(f, CFG, a, thr)
    rec = report_record(table, f.index[2500])
    assert rec['timestamp'] and rec['severity'] == 'Extreme' and len(rec['top_features']) == 2
    assert rec['top_features'][0]['feature'] in FEATURES


def test_writes_are_confined_and_isolated_from_other_modules(out):
    with pytest.raises(ValueError): safe_path(OUTPUT.parent / 'models' / 'har_lad_v1.json')
    with pytest.raises(ValueError): safe_path(OUTPUT.parent / 'regime_detection_artifacts' / 'x.json')
    with pytest.raises(ValueError): safe_path(OUTPUT / '..' / 'data' / 'live' / 'oops')
    target = out / 'a.json'
    publish_json(target, {'v': 1})
    with pytest.raises(FileExistsError): publish_json(target, {'v': 2})
    assert json.loads(target.read_text()) == {'v': 1}
    import ast
    source = Path(__file__).resolve().parents[2] / 'src' / 'anomaly_detection'
    for path in source.glob('*.py'):
        for node in ast.walk(ast.parse(path.read_text(encoding='utf-8'))):
            names = ([a.name for a in node.names] if isinstance(node, ast.Import)
                     else [node.module or ''] if isinstance(node, ast.ImportFrom) and node.level == 0 else [])
            for name in names:
                assert not name.startswith(('regime_detection', 'app', 'paper_log', 'har_lad')), (path.name, name)

def test_frozen_thresholds_use_train_split_only():
    f = make_features()
    a, _ = split_positions(len(f))
    expected = thresholds_from_train(robust_z(f, CFG)[2].iloc[:a], CFG)
    assert FrozenDetector.fit(f, CFG).thresholds == expected


def test_shadow_uses_real_clock_and_marks_in_sample(out):
    raw = hourly_frame(candles())
    frozen = FrozenDetector.fit(build_features(raw, CFG), CFG)
    assert record(frozen, raw, out)['status'] == 'ok'
    report = json.loads(next((out / 'reports').glob('*.json')).read_text())
    assert report['in_sample'] is True and report['lag_hours'] > 0
    live = raw.copy()
    live.index = live.index + (pd.Timestamp.now(tz='UTC').floor('h') - live.index[-1])
    with pytest.raises(ValueError, match='not closed'):
        record(frozen, live, out)

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from walk_forward import (  # noqa: E402
    FINAL_TEST, FOLDS, HORIZON, VALIDATION, FEATURES_CSV, load_features, split_fold,
)


def _synthetic():
    idx = pd.date_range("2022-01-01", "2023-12-31 23:00", freq="h", tz="UTC")
    return pd.DataFrame({"x": np.arange(len(idx))}, index=idx)


def test_embargo_on_synthetic_data():
    df = _synthetic()
    train, test = split_fold(df, "2023-07-01", "2024-01-01")
    start = pd.Timestamp("2023-07-01", tz="UTC")
    # No training label window (t, t+24h] may reach the test window
    assert (train.index + HORIZON < start).all()
    # Exactly the last 24 hours before test start are removed from train
    assert train.index.max() == start - pd.Timedelta(hours=25)


@pytest.mark.skipif(not FEATURES_CSV.exists(), reason="features_1h.csv not built yet")
def test_embargo_on_real_folds():
    df = load_features()
    prev_end = None
    for name, ts, te in FOLDS:
        train, test = split_fold(df, ts, te)
        start = pd.Timestamp(ts, tz="UTC")
        assert len(train) > 0 and len(test) > 0, name
        assert (train.index + HORIZON < start).all(), f"{name}: train label window overlaps test"
        assert train.index.max() < test.index.min(), name
        if prev_end is not None:
            assert start >= prev_end, f"{name}: overlaps previous fold test block"
        prev_end = pd.Timestamp(te, tz="UTC")


def test_folds_never_touch_validation_or_final_test():
    last_fold_end = pd.Timestamp(FOLDS[-1][2], tz="UTC")
    assert last_fold_end <= pd.Timestamp(VALIDATION[0], tz="UTC")
    assert pd.Timestamp(VALIDATION[1], tz="UTC") <= pd.Timestamp(FINAL_TEST[0], tz="UTC")
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from train_volatility import TRIALS, split_validation  # noqa: E402
from walk_forward import FINAL_TEST, HORIZON, VALIDATION  # noqa: E402


def _synthetic():
    idx = pd.date_range("2024-01-01", "2026-09-30 23:00", freq="h", tz="UTC")
    return pd.DataFrame({"x": np.arange(len(idx))}, index=idx)


def test_validation_split_has_no_overlap_with_final_test():
    train, val = split_validation(_synthetic())
    vs = pd.Timestamp(VALIDATION[0], tz="UTC")
    final_start = pd.Timestamp(FINAL_TEST[0], tz="UTC")
    assert (train.index + HORIZON < vs).all()          # embargo before validation
    assert val.index.min() >= vs
    assert (val.index + HORIZON < final_start).all()   # label windows end before final test


def test_exactly_ten_trials():
    assert len(TRIALS) == 10
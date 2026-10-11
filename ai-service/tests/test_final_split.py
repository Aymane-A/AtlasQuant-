import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from final_test import split_final  # noqa: E402
from walk_forward import EMBARGO, FINAL_TEST  # noqa: E402


def _synthetic():
    idx = pd.date_range("2024-01-01", "2026-09-29 23:00", freq="h", tz="UTC")
    return pd.DataFrame({"x": np.arange(len(idx))}, index=idx)


def test_final_split_embargo_and_bounds():
    train, test = split_final(_synthetic())
    fs = pd.Timestamp(FINAL_TEST[0], tz="UTC")
    fe = pd.Timestamp(FINAL_TEST[1], tz="UTC")
    assert (train.index + EMBARGO < fs).all()       # no training label window reaches the final test
    assert test.index.min() >= fs and test.index.max() < fe
    assert train.index.max() < test.index.min()
    assert len(train) > 0 and len(test) > 0
"""Walk-forward folds with a 24h embargo (PROTOCOL.md section 3).

Test blocks are [start, end) in UTC. Validation and FINAL TEST periods are
defined here only so nothing else can accidentally use them; the folds below
never touch them.
"""
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
FEATURES_CSV = ROOT / "data" / "processed" / "features_1h.csv"

HORIZON = pd.Timedelta(hours=24)
EMBARGO = pd.Timedelta(hours=24)

# (name, test_start inclusive, test_end exclusive)
FOLDS = [
    ("fold1", "2023-01-01", "2023-07-01"),
    ("fold2", "2023-07-01", "2024-01-01"),
    ("fold3", "2024-01-01", "2024-07-01"),
    ("fold4", "2024-07-01", "2025-01-01"),
    ("fold5", "2025-01-01", "2025-07-01"),
]
VALIDATION = ("2025-07-01", "2026-04-01")
FINAL_TEST = ("2026-04-01", "2026-10-01")  # DO NOT USE until everything is locked


def _utc(s: str) -> pd.Timestamp:
    return pd.Timestamp(s, tz="UTC")


def load_features() -> pd.DataFrame:
    return pd.read_csv(FEATURES_CSV, index_col="timestamp", parse_dates=True).sort_index()


def split_fold(df: pd.DataFrame, test_start: str, test_end: str):
    """Expanding window. Train rows must satisfy t + 24h < test_start, so no
    training label window (t, t+24h] reaches into the evaluation window."""
    ts, te = _utc(test_start), _utc(test_end)
    train = df[df.index + EMBARGO < ts]
    test = df[(df.index >= ts) & (df.index < te)]
    return train, test
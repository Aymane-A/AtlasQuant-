from dataclasses import dataclass, asdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / 'anomaly_detection_artifacts'
RAW = ROOT / 'data/raw/BTCUSDT_1h_raw.csv'
FEATURES = ('ret', 'range', 'rv', 'log_volume_ratio')
RANK = {'Normal': 0, 'Elevated': 1, 'Extreme': 2}
ALARMS = ('Elevated', 'Extreme')


@dataclass(frozen=True)
class Config:
    seed: int = 42
    # --- cadence : horaire (BTCUSDT 1h) ---
    rv_hours: int = 24               # fenêtre de la volatilité réalisée
    volume_hours: int = 168          # médiane causale du volume (7 jours)
    # --- baseline robuste (strictement causale) ---
    baseline_hours: int = 720        # 30 jours d'historique précédent
    min_baseline_hours: int = 360    # historique valide minimum avant de scorer
    mad_floor: float = 1e-12
    # --- seuils : quantiles du score sur l'entraînement uniquement ---
    elevated_quantile: float = .99
    extreme_quantile: float = .999
    min_threshold_rows: int = 1000
    # --- Isolation Forest (ré-ajusté en walk-forward) ---
    iforest_trees: int = 200
    iforest_train_hours: int = 8760  # 1 an d'historique par ré-ajustement
    iforest_min_train_rows: int = 2000
    refit_hours: int = 720           # ré-ajustement tous les 30 jours
    # --- évaluation ---
    episode_gap_hours: int = 6
    min_total_rows: int = 5000

    def dict(self):
        return asdict(self)


def safe_path(path):
    path = Path(path).resolve()
    root = OUTPUT.resolve()
    if not path.is_relative_to(root) or path == root:
        raise ValueError('Writes must stay inside anomaly_detection_artifacts')
    return path
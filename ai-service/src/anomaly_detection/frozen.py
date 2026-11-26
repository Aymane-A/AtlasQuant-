import hashlib
import json
import pickle
import sklearn
from pathlib import Path
from .config import Config
from .detectors import IsolationDetector, robust_z
from .pipeline import assemble, split_positions, thresholds_from_train
from .store import publish_bytes, publish_json


class FrozenDetector:
    """Détecteur figé pour le shadow : jamais ré-entraîné automatiquement."""

    def __init__(self, cfg, thresholds, forest, trained_through, rows):
        self.cfg, self.thresholds, self.forest = cfg, thresholds, forest
        self.trained_through, self.rows = trained_through, rows

    @classmethod
    def fit(cls, features, cfg):
        _, _, rscore = robust_z(features, cfg)
        thresholds = thresholds_from_train(rscore.iloc[:split_positions(len(features))[0]], cfg)
        forest = IsolationDetector(cfg).fit(features.iloc[-cfg.iforest_train_hours:])
        return cls(cfg, thresholds, forest, str(features.index[-1]), int(len(features)))

    def score(self, features):
        z, reason, rscore = robust_z(features, self.cfg)
        iso = self.forest.score(features)
        return assemble(features, z, reason, rscore, self.thresholds, iso,
                        self.forest.elevated, self.forest.extreme)

    def save(self, directory):
        directory = Path(directory)
        blob = pickle.dumps(self.forest.model, protocol=4)
        publish_bytes(directory / 'iforest.pkl', blob)
        publish_json(directory / 'detector.json', {
            'schema': 1, 'config': self.cfg.dict(), 'robust_thresholds': self.thresholds,
            'iforest_thresholds': {'elevated': self.forest.elevated, 'extreme': self.forest.extreme},
            'trained_through': self.trained_through, 'rows': self.rows,
            'iforest_sha256': hashlib.sha256(blob).hexdigest(), 'sklearn_version': sklearn.__version__,
            'note': 'Load only artifacts you created yourself (pickle). Never retrained automatically.'})

    @classmethod
    def load(cls, directory):
        directory = Path(directory)
        meta = json.loads((directory / 'detector.json').read_text(encoding='utf-8'))
        blob = (directory / 'iforest.pkl').read_bytes()
        if hashlib.sha256(blob).hexdigest() != meta['iforest_sha256']:
            raise ValueError('Isolation Forest artifact hash mismatch')
        if meta['sklearn_version'] != sklearn.__version__:
            raise ValueError('scikit-learn version differs from the frozen artifact')
        cfg = Config(**meta['config'])
        forest = IsolationDetector.from_parts(cfg, pickle.loads(blob), **meta['iforest_thresholds'])
        return cls(cfg, meta['robust_thresholds'], forest, meta['trained_through'], meta['rows'])
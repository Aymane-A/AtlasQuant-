import json
import os
import uuid
import numpy as np
import pandas as pd
from .config import safe_path


def jsonable(value):
    if isinstance(value, dict):
        return {str(k): jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    if isinstance(value, (bool, np.bool_)):
        return bool(value)
    if isinstance(value, (float, np.floating)):
        return float(value) if np.isfinite(value) else None
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    return value


def _sync_dir(directory):
    if os.name == 'nt':
        return
    fd = os.open(str(directory), os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def publish_bytes(path, data):
    """Création atomique sans écrasement : fsync du fichier, puis publication exclusive."""
    path = safe_path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name('.pending-' + uuid.uuid4().hex)
    try:
        with temp.open('xb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        if os.name == 'nt':
            os.rename(temp, path)  # Windows : refuse de remplacer
        else:
            os.link(temp, path)    # POSIX : refuse une destination existante
    finally:
        if temp.exists():
            temp.unlink()
    _sync_dir(path.parent)


def publish_json(path, value):
    publish_bytes(path, json.dumps(jsonable(value), indent=2, allow_nan=False).encode('utf-8'))


def publish_csv(path, frame):
    publish_bytes(path, frame.to_csv(index=True).encode('utf-8'))
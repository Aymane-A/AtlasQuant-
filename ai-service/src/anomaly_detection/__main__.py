import argparse
import json
from pathlib import Path
from .config import RAW, OUTPUT


def main():
    parser = argparse.ArgumentParser(description='Isolated anomaly-detection research (Model 3)')
    sub = parser.add_subparsers(dest='command', required=True)
    v = sub.add_parser('validate', help='Chronological historical validation (descriptive)')
    v.add_argument('--data', type=Path, default=RAW)
    v.add_argument('--run', required=True, help='New directory name under anomaly_detection_artifacts')
    f = sub.add_parser('freeze', help='Fit a frozen detector on all given history (after reviewing validation)')
    f.add_argument('--data', type=Path, default=RAW)
    f.add_argument('--run', required=True)
    s = sub.add_parser('shadow', help='Record-only report for the latest closed candle of a local CSV')
    s.add_argument('--detector', type=Path, required=True, help='Directory containing detector.json')
    s.add_argument('--data', type=Path, required=True)
    s.add_argument('--run', required=True)
    args = parser.parse_args()
    if args.command == 'validate':
        from .validation import run
        print(run(args.data, OUTPUT / args.run))
    elif args.command == 'freeze':
        from .config import Config
        from .data import load_hourly
        from .features import build_features
        from .frozen import FrozenDetector
        features = build_features(load_hourly(args.data), Config())
        detector = FrozenDetector.fit(features, Config())
        detector.save(OUTPUT / args.run / 'frozen')
        print(OUTPUT / args.run / 'frozen')
    else:
        from .data import load_hourly
        from .frozen import FrozenDetector
        from .shadow import record
        print(json.dumps(record(FrozenDetector.load(args.detector), load_hourly(args.data), OUTPUT / args.run), indent=2))


if __name__ == '__main__':
    main()
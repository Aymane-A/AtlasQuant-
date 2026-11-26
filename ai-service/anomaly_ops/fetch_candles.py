"""Download the latest closed BTCUSDT 1h candles (public market data, no API key)."""
import csv
import json
import sys
import time
import urllib.request

URL = 'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=1000'
HOUR_MS = 3_600_000


def download(attempts=3):
    for attempt in range(1, attempts + 1):
        try:
            with urllib.request.urlopen(URL, timeout=30) as response:
                return json.load(response)
        except OSError:
            if attempt == attempts:
                raise
            time.sleep(10 * attempt)


def main(target):
    klines = download()
    now = int(time.time() * 1000)
    closed = [k for k in klines if int(k[6]) < now]
    if len(closed) < 900:
        raise SystemExit(f'Too few closed candles: {len(closed)}')
    if now - int(closed[-1][6]) > HOUR_MS:
        raise SystemExit('Latest closed candle is stale')
    with open(target, 'x', newline='', encoding='ascii') as f:
        writer = csv.writer(f)
        writer.writerow(['open_time', 'open', 'high', 'low', 'close', 'volume'])
        writer.writerows(k[:6] for k in closed)
    print(f'Rows: {len(closed)}')


if __name__ == '__main__':
    main(sys.argv[1])

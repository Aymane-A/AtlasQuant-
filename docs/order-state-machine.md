# Live order state machine

```
pending ──send──► submitted ─► partially_filled ─► filled
   │                  └────────────────────────────► cancelled / rejected
   ├─ the exchange says "no" (definite) ─────────────► rejected
   └─ we cannot tell (timeout, 5xx, lost reply) ────► unknown ──reconciler──► submitted / filled / cancelled / rejected
```

## Why
An order accepted by the exchange whose reply never reached us used to leave **no trace**: the controller only wrote
`live_orders` after a successful answer, so the user saw an error, retried, and a second real order could follow.

## What happens now (`POST /api/trading/order`, live mode)
1. The row is written as `pending` **before** anything is sent, with a `client_order_id` (`aq` + 28 hex). If that write fails
   the order is **not sent** (503 `ORDER_NOT_RECORDED`).
2. The same id travels to the exchange (`clientExtensions.id` on OANDA, `client_order_id` on Alpaca, `clientOrderId` on ccxt exchanges).
3. Answer received → the row is completed (`exchange_order_id`, normalised status: `open/new/accepted` → `submitted`, `closed` → `filled`, ...).
4. A **definite refusal** (HTTP 400/401/403/404/405/422, ccxt `InvalidOrder` / `InsufficientFunds` / `AuthenticationError` /
   `BadSymbol` / ..., or an error raised before any request left the server) → `rejected`.
5. **Anything else** (timeout, reset, 5xx, 429, unknown errors) → `unknown`, and the API answers **502 `ORDER_STATE_UNKNOWN`**
   with the `orderId`. The order is never sent again; the Idempotency-Key replays the same answer on a retry.

`unknown` is the default on purpose: a wrong "unknown" costs a delay, a wrong "rejected" costs a live order nobody tracks.

## Resolution (`resolveUnresolvedOrders`, every minute)
- `pending` with no exchange id for more than 60 s → `unknown` (the process stopped, or the reply was lost).
- For each `unknown` row the exchange is asked **by client id**:
  - found → the exchange id and state are adopted (the fill reconciler then fetches fills);
  - not found and younger than `ORDER_NOT_FOUND_GRACE_MIN` (default 10) → left alone, a delayed request can still land;
  - not found and older → `rejected` ("never reached the exchange");
  - the lookup itself fails (network, auth, unsupported) → left `unknown`, never concluded.
- `unknown` for more than 60 minutes → an ERROR is logged every minute: check the exchange by hand.
- `GET /api/trading/orders?status=open` includes `unknown` orders so the user sees them.

## Not validated against a real exchange yet
Order placement with a client id and the lookup by client id follow the documented APIs (OANDA `GET /orders/@{clientID}`,
Alpaca `GET /orders:by_client_order_id`, ccxt `fetchOrder(undefined, symbol, {clientOrderId})`) and are covered by tests with the
network stubbed. **Run them once on OANDA practice, Alpaca paper and Binance testnet before any live use**, including a forced
timeout (e.g. block the network right after the request). Other ccxt exchanges may not support lookup by client id: for them an
`unknown` order stays `unknown` and needs a manual check.
Live trading stays **NO-GO** until that is done and balance/position reconciliation exists (see `docs/endpoint-audit.md`).

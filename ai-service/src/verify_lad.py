"""Check that the IRLS fit used for har-lad-v1 is a true least-absolute-deviation (L1) solution.

    python src/verify_lad.py      (the exact LP solver is slow on big samples, so it runs on the last 3000 and 8000 rows)

1) IRLS vs the exact LP solution (sklearn QuantileRegressor, quantile 0.5, HiGHS) on subsamples.
2) IRLS on ALL rows: iterations needed, and a local optimality probe (no small change of a
   coefficient may lower the mean absolute error).
"""
import numpy as np

from baselines import TARGET
from diagnostics import HAR3, lad_fit
from sklearn.linear_model import QuantileRegressor
from walk_forward import load_features


def mae_of(beta, X, y):
    return float(np.mean(np.abs(y - (beta[0] + X @ beta[1:]))))


def irls_with_info(X, y, iters=200):
    """Same algorithm as diagnostics.lad_fit, but also returns the iteration count."""
    A = np.column_stack([np.ones(len(y)), X])
    beta = np.linalg.lstsq(A, y, rcond=None)[0]
    for i in range(1, iters + 1):
        r = y - A @ beta
        sw = np.sqrt(1.0 / np.maximum(np.abs(r), 1e-7))
        new = np.linalg.lstsq(A * sw[:, None], y * sw, rcond=None)[0]
        done = np.max(np.abs(new - beta)) < 1e-12
        beta = new
        if done:
            return beta, i, True
    return beta, iters, False


def main() -> None:
    df = load_features()
    X_all, y_all = df[HAR3].to_numpy(), df[TARGET].to_numpy()

    print("1) IRLS vs exact LP (HiGHS) on subsamples")
    for n in (3000, 8000):
        X, y = X_all[-n:], y_all[-n:]
        b_irls = lad_fit(X, y)
        q = QuantileRegressor(quantile=0.5, alpha=0.0, solver="highs").fit(X, y)
        b_lp = np.r_[q.intercept_, q.coef_]
        m_irls, m_lp = mae_of(b_irls, X, y), mae_of(b_lp, X, y)
        print(f"  n={n}: IRLS {np.round(b_irls, 5)} | LP {np.round(b_lp, 5)}")
        print(f"         MAE IRLS={m_irls:.8f} LP={m_lp:.8f}  relative gap={(m_irls - m_lp) / m_lp:+.2e}")

    print("\n2) IRLS on all rows: 200 iterations (used in evaluation) vs 5000 (product)")
    b200, it200, ok200 = irls_with_info(X_all, y_all, iters=200)
    assert np.allclose(b200, lad_fit(X_all, y_all), atol=1e-12), "lad_fit differs from the verification copy"
    beta, its, converged = irls_with_info(X_all, y_all, iters=5000)
    m200, m5000 = mae_of(b200, X_all, y_all), mae_of(beta, X_all, y_all)
    print(f"  rows={len(y_all)}")
    print(f"  200 iters : iterations={it200} converged={ok200}  {np.round(b200, 5)}  MAE={m200:.9f}")
    print(f"  5000 iters: iterations={its} converged={converged}  {np.round(beta, 5)}  MAE={m5000:.9f}")
    print(f"  MAE relative change 200 -> 5000 = {(m5000 - m200) / m200:+.2e} | max coefficient change = {np.max(np.abs(beta - b200)):.2e}")

    base = m5000
    steps = [1e-6, 1e-3, 1e-3, 1e-3]  # absolute step per coefficient (intercept, then 3 slopes)
    worst = 0.0
    for j, step in enumerate(steps):
        for sign in (-1, 1):
            b = beta.copy()
            b[j] += sign * step
            worst = min(worst, mae_of(b, X_all, y_all) - base)
    print(f"  best MAE change from perturbing one coefficient (5000-iter fit) = {worst:+.2e} "
          f"({'OK, at a minimum' if worst > -1e-9 else 'NOT a minimum: investigate'})")

if __name__ == "__main__":
    main()
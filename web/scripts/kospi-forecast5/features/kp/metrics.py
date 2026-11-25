"""[실사용 모듈] (service_5 복사본, 2026-11-20 원본: experiments/daily/kp/metrics.py) 평가 지표(MCC·MAE 개선율 등)."""
import numpy as np
from scipy.stats import spearmanr
from sklearn.metrics import (accuracy_score, roc_auc_score, log_loss, matthews_corrcoef,
                             mean_absolute_error, mean_squared_error, r2_score, balanced_accuracy_score)


def mcc_fast(y, label):
    """numpy MCC (조합 탐색용). y, label: 0/1 배열."""
    y = np.asarray(y, bool); l = np.asarray(label, bool)
    tp = float((y & l).sum()); tn = float((~y & ~l).sum()); fp = float((~y & l).sum()); fn = float((y & ~l).sum())
    den = np.sqrt((tp + fp) * (tp + fn) * (tn + fp) * (tn + fn))
    return (tp * tn - fp * fn) / den if den > 0 else 0.0


def mae_skill(y, pred):
    z = np.mean(np.abs(y))
    return 1 - np.mean(np.abs(y - pred)) / z if z > 0 else np.nan


def regression_metrics(y, pred):
    y, pred = np.asarray(y, float), np.asarray(pred, float)
    ic = np.nan if np.ptp(pred) < 1e-15 else float(spearmanr(y, pred).statistic)
    return {"MAESkillVsZero": mae_skill(y, pred), "MAE": mean_absolute_error(y, pred),
            "RMSE": float(np.sqrt(mean_squared_error(y, pred))), "R2": float(r2_score(y, pred)),
            "SpearmanIC": ic, "DirectionAcc": float(((y > 0) == (pred > 0)).mean())}


def classification_metrics(y, proba):
    y = np.asarray(y, int); p = np.clip(np.asarray(proba, float), 1e-7, 1 - 1e-7)
    lab = (p >= 0.5).astype(int)
    out = {"MCC": float(matthews_corrcoef(y, lab)), "Accuracy": float(accuracy_score(y, lab)),
           "BalancedAccuracy": float(balanced_accuracy_score(y, lab))}      # 상승·하락 각각의 적중률 평균(항상 한쪽만 맞히는 Naive는 0.5)
    two = len(np.unique(y)) == 2
    out["AUC"] = float(roc_auc_score(y, p)) if two else np.nan
    out["LogLoss"] = float(log_loss(y, p, labels=[0, 1]))
    return out


def score(objective, y, pred):
    """주지표 하나(클수록 좋음)."""
    return mcc_fast(y, np.asarray(pred) >= 0.5) if objective == "cls" else mae_skill(np.asarray(y, float), np.asarray(pred, float))

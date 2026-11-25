"""[실사용 모듈] (service_5 복사본, 2026-11-20 원본: experiments/daily/kp/seq_models.py) LSTM / GRU / BiLSTM / BiGRU 시퀀스 모델 (기존 벤치마크 노트북의 TorchSequenceModel 중 순환 모델 부분).
Transformer·TCN은 이전 결과가 좋지 않아 뺐다. 시계열 문맥(lookback 윈도우) 유지, 학습 구간만으로 스케일링,
학습 구간 마지막 15%로 early stopping 후 최적 가중치 복원."""
from __future__ import annotations
import copy
import numpy as np
import pandas as pd
from . import config as C

try:
    import torch
    import torch.nn as nn
    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False


def _padded_windows(arr, lookback):
    n, f = arr.shape
    padded = np.zeros((n + lookback - 1, f), dtype=float)
    padded[lookback - 1:] = arr
    return np.stack([padded[i:i + lookback] for i in range(n)], axis=0)


class _WindowScaler:
    def fit(self, flat):
        self.median_ = np.nanmedian(flat, axis=0)
        self.median_ = np.where(np.isnan(self.median_), 0.0, self.median_)
        imp = np.where(np.isnan(flat), self.median_, flat)
        self.mean_ = imp.mean(axis=0); self.std_ = imp.std(axis=0)
        self.std_[self.std_ < 1e-8] = 1.0
        return self

    def transform(self, flat):
        return (np.where(np.isnan(flat), self.median_, flat) - self.mean_) / self.std_


if HAS_TORCH:
    class _SeqNet(nn.Module):
        def __init__(self, arch, n_features, hidden_size, num_layers, dropout=0.1):
            super().__init__()
            bi = arch.startswith("bi")
            base = arch[2:] if bi else arch
            cls = {"lstm": nn.LSTM, "gru": nn.GRU}[base]
            self.encoder = cls(n_features, hidden_size, num_layers=num_layers, batch_first=True, bidirectional=bi,
                               dropout=dropout if num_layers > 1 else 0.0)
            self.head = nn.Linear(hidden_size * (2 if bi else 1), 1)

        def forward(self, x):
            out, _ = self.encoder(x)
            return self.head(out[:, -1, :]).squeeze(-1)

    class TorchSequenceModel:
        def __init__(self, arch, task, hidden_size=32, num_layers=1, lookback=20, lr=1e-3, epochs=150, batch_size=64,
                     dropout=0.1, patience=20, min_delta=1e-5, val_fraction=0.15, seed=42):
            self.arch, self.task = arch, task
            self.hidden_size, self.num_layers, self.lookback = hidden_size, num_layers, lookback
            self.lr, self.epochs, self.batch_size, self.dropout = lr, epochs, batch_size, dropout
            self.patience, self.min_delta, self.val_fraction, self.seed = patience, min_delta, val_fraction, seed
            self.device = torch.device(C.DL_DEVICE if (C.DL_DEVICE != "cuda" or torch.cuda.is_available()) else "cpu")

        def _windows(self, X, history=False):
            frame = X.sort_index()
            if history and hasattr(self, "history_") and len(self.history_):
                comb = pd.concat([self.history_, frame])
                comb = comb[~comb.index.duplicated(keep="last")].sort_index()
                w_all = _padded_windows(comb.to_numpy(dtype=float), self.lookback)
                return frame.index, w_all[comb.index.get_indexer(frame.index)]
            return frame.index, _padded_windows(frame.to_numpy(dtype=float), self.lookback)

        def fit(self, X, y, target_dates=None):
            torch.manual_seed(self.seed)
            index, w = self._windows(X)
            y = pd.Series(np.asarray(y, float), index=X.index).loc[index].to_numpy()
            n_val = min(max(40, int(np.ceil(len(y) * self.val_fraction))), max(1, len(y) // 3))
            split = len(y) - n_val
            train = np.arange(len(y)) < split
            if split > 0 and target_dates is not None:
                known = pd.to_datetime(target_dates.reindex(index)) < index[split]
                train &= known.to_numpy()
            if train.sum() < 30:
                raise ValueError("early stopping을 위한 학습 행이 부족합니다.")
            self.scaler_ = _WindowScaler().fit(w[train].reshape(-1, w.shape[-1]))
            w = self.scaler_.transform(w.reshape(-1, w.shape[-1])).reshape(w.shape)
            self.net_ = _SeqNet(self.arch, w.shape[-1], self.hidden_size, self.num_layers, self.dropout).to(self.device)
            opt = torch.optim.AdamW(self.net_.parameters(), lr=self.lr, weight_decay=1e-4)
            loss_fn = nn.BCEWithLogitsLoss() if self.task == "cls" else nn.L1Loss()
            dev = self.device
            Xt, yt = torch.tensor(w[train], dtype=torch.float32, device=dev), torch.tensor(y[train], dtype=torch.float32, device=dev)
            Xv, yv = torch.tensor(w[split:], dtype=torch.float32, device=dev), torch.tensor(y[split:], dtype=torch.float32, device=dev)
            best, state, wait = np.inf, None, 0
            for epoch in range(self.epochs):
                self.net_.train()
                perm = torch.randperm(len(yt), device=dev)
                for s in range(0, len(yt), self.batch_size):
                    idx = perm[s:s + self.batch_size]
                    opt.zero_grad()
                    loss_fn(self.net_(Xt[idx]), yt[idx]).backward()
                    torch.nn.utils.clip_grad_norm_(self.net_.parameters(), 1.0)
                    opt.step()
                self.net_.eval()
                with torch.no_grad():
                    vl = float(loss_fn(self.net_(Xv), yv).item())
                if vl < best - self.min_delta:
                    best, state, wait = vl, copy.deepcopy(self.net_.state_dict()), 0
                else:
                    wait += 1
                    if wait >= self.patience:
                        break
            if state is not None:
                self.net_.load_state_dict(state)
            self.history_ = X.sort_index().iloc[-max(0, self.lookback - 1):].copy()
            return self

        def _forward(self, X):
            index, w = self._windows(X, history=True)
            w = self.scaler_.transform(w.reshape(-1, w.shape[-1])).reshape(w.shape)
            self.net_.eval()
            with torch.no_grad():
                out = self.net_(torch.tensor(w, dtype=torch.float32, device=self.device)).cpu().numpy()
            return pd.Series(out, index=index).reindex(X.index).to_numpy()

        def predict(self, X):
            o = self._forward(X)
            return (o >= 0).astype(float) if self.task == "cls" else o

        def predict_proba(self, X):
            p = 1 / (1 + np.exp(-np.clip(self._forward(X), -30, 30)))
            return np.stack([1 - p, p], axis=1)

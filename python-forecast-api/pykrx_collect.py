"""pykrx 로 KOSPI 일별 시세를 조회한다.

data.krx.co.kr 화면을 읽으므로, Open API 와 달리 장마감 후 당일 종가를 받을 수 있다.
stdin JSON: {"dataset":"kospi"|"kospi_series","start":"YYYY-MM-DD","end":"YYYY-MM-DD","sample":false}
stdout JSON: {"ok":true,"rows":[...]} 또는 {"ok":false,"error":"..."}
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Optional


def _load_web_env() -> None:
    if os.getenv("KRX_ID") and os.getenv("KRX_PW"):
        return
    env_path = Path(__file__).resolve().parents[1] / "web" / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        trimmed = line.strip()
        if not trimmed or trimmed.startswith("#") or "=" not in trimmed:
            continue
        key, value = trimmed.split("=", 1)
        key = key.strip()
        if key in ("KRX_ID", "KRX_PW") and not os.getenv(key):
            os.environ[key] = value.strip().strip('"').strip("'")


def _ymd(iso_date: str) -> str:
    parsed = datetime.strptime(iso_date, "%Y-%m-%d")
    return parsed.strftime("%Y%m%d")


def _num(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number:
        return None
    return number


def _blank_price(open_v, high_v, low_v, close_v) -> bool:
    return all(value in (None, 0, 0.0) for value in (open_v, high_v, low_v, close_v))


def _rows_from_ohlcv(frame, index_name: str, index_ticker: str) -> list[dict]:
    if frame is None or getattr(frame, "empty", True):
        return []
    rows: list[dict] = []
    working = frame.reset_index()
    date_col = None
    for candidate in ("날짜", "date", "Date"):
        if candidate in working.columns:
            date_col = candidate
            break
    if date_col is None:
        date_col = working.columns[0]
    for _, record in working.iterrows():
        raw_date = record.get(date_col)
        try:
            parsed = datetime.strptime(str(raw_date)[:10].replace(".", "-"), "%Y-%m-%d")
        except ValueError:
            try:
                parsed = datetime.strptime(str(raw_date)[:10].replace("-", ""), "%Y%m%d")
            except ValueError:
                continue
        open_v = _num(record.get("시가"))
        high_v = _num(record.get("고가"))
        low_v = _num(record.get("저가"))
        close_v = _num(record.get("종가"))
        if _blank_price(open_v, high_v, low_v, close_v):
            continue
        rows.append(
            {
                "date": parsed.strftime("%Y-%m-%d"),
                "index_name": index_name,
                "index_ticker": index_ticker,
                "open": open_v,
                "high": high_v,
                "low": low_v,
                "close": close_v,
                "volume": _num(record.get("거래량")),
                "trading_value": _num(record.get("거래대금")),
            }
        )
    return rows


def _anchor_and_tickers(end_iso: str):
    from pykrx import stock

    end = datetime.strptime(end_iso, "%Y-%m-%d")
    for offset in range(0, 10):
        day = (end - timedelta(days=offset)).strftime("%Y%m%d")
        try:
            tickers = stock.get_index_ticker_list(day, market="KOSPI") or []
        except Exception:
            tickers = []
        if tickers:
            return day, list(tickers)
    return None, []


def collect(dataset: str, start: str, end: str, sample: bool = False) -> list[dict]:
    dataset_id = (dataset or "").strip()
    if dataset_id not in ("kospi", "kospi_series"):
        raise ValueError("dataset 은 kospi 또는 kospi_series 여야 합니다.")
    start_dt = datetime.strptime(start, "%Y-%m-%d")
    end_dt = datetime.strptime(end, "%Y-%m-%d")
    if end_dt < start_dt:
        start_dt, end_dt = end_dt, start_dt
    if (end_dt - start_dt).days > 8000:
        raise ValueError("조회 기간이 8000일을 넘습니다.")

    _load_web_env()
    if not (os.getenv("KRX_ID") and os.getenv("KRX_PW")):
        raise RuntimeError(
            "pykrx는 KRX 정보데이터시스템 로그인이 필요합니다. web/.env 에 KRX_ID 와 KRX_PW 를 설정하세요."
        )

    from pykrx import stock

    start_ymd = start_dt.strftime("%Y%m%d")
    end_ymd = end_dt.strftime("%Y%m%d")

    if dataset_id == "kospi":
        frame = stock.get_index_ohlcv_by_date(start_ymd, end_ymd, "1001")
        return _rows_from_ohlcv(frame, "코스피", "1001")

    if sample:
        anchor, _tickers = _anchor_and_tickers(end_dt.strftime("%Y-%m-%d"))
        if not anchor:
            return []
        frame = stock.get_index_ohlcv_by_ticker(anchor, "KOSPI")
        if frame is None or getattr(frame, "empty", True):
            return []
        anchor_iso = datetime.strptime(anchor, "%Y%m%d").strftime("%Y-%m-%d")
        rows: list[dict] = []
        for index_name, record in frame.iterrows():
            open_v = _num(record.get("시가"))
            high_v = _num(record.get("고가"))
            low_v = _num(record.get("저가"))
            close_v = _num(record.get("종가"))
            if _blank_price(open_v, high_v, low_v, close_v):
                continue
            rows.append(
                {
                    "date": anchor_iso,
                    "index_name": str(index_name),
                    "index_ticker": "",
                    "open": open_v,
                    "high": high_v,
                    "low": low_v,
                    "close": close_v,
                    "volume": _num(record.get("거래량")),
                    "trading_value": _num(record.get("거래대금")),
                }
            )
        return rows

    _anchor, tickers = _anchor_and_tickers(end_dt.strftime("%Y-%m-%d"))
    if not tickers:
        raise ValueError("KOSPI 지수 목록을 찾지 못했습니다. 기간 또는 KRX 화면을 확인하세요.")
    rows: list[dict] = []
    for ticker in tickers:
        try:
            index_name = stock.get_index_ticker_name(ticker) or ticker
            frame = stock.get_index_ohlcv_by_date(start_ymd, end_ymd, ticker)
        except Exception as error:  # noqa: BLE001
            raise RuntimeError(f"KOSPI 시리즈 조회 실패({ticker}): {error}") from error
        rows.extend(_rows_from_ohlcv(frame, str(index_name), str(ticker)))
    return rows


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        json.dump({"ok": False, "error": "요청 JSON 을 읽지 못했습니다."}, sys.stdout, ensure_ascii=False)
        return 1
    try:
        rows = collect(
            dataset=str(payload.get("dataset") or ""),
            start=str(payload.get("start") or ""),
            end=str(payload.get("end") or ""),
            sample=bool(payload.get("sample")),
        )
    except Exception as error:  # noqa: BLE001
        json.dump({"ok": False, "error": str(error)}, sys.stdout, ensure_ascii=False)
        return 1
    if not rows:
        json.dump(
            {"ok": False, "error": "해당 기간에 조회된 KOSPI 시세가 없습니다. (휴장일이거나 아직 종가 반영 전일 수 있습니다.)"},
            sys.stdout,
            ensure_ascii=False,
        )
        return 1
    json.dump({"ok": True, "rows": rows}, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())

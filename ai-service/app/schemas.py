"""Request / response validation (pydantic v2)."""
from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class Candle(BaseModel):
    model_config = ConfigDict(extra="forbid")
    timestamp: datetime                      # candle OPEN time, UTC
    open: Optional[float] = Field(default=None, gt=0)
    high: float = Field(gt=0)
    low: float = Field(gt=0)
    close: float = Field(gt=0)
    volume: float = Field(ge=0)


class PredictRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    symbol: Literal["BTCUSDT"] = "BTCUSDT"
    timeframe: Literal["1h"] = "1h"
    candles: list[Candle] = Field(min_length=721, max_length=2000)


class Range90(BaseModel):
    low: float
    high: float


class Forecast(BaseModel):
    hourly_std: float
    move_24h_pct_1sigma: float
    range_90: Range90


class Risk(BaseModel):
    level: Literal["low", "medium", "high"]
    historical_percentile: int
    out_of_historical_range: bool
    note: str


class Inputs(BaseModel):
    RV_d: float
    RV_w: float
    RV_m: float


class Monitoring(BaseModel):
    persistence: float
    har_rv: float


class ModelInfo(BaseModel):
    trained_through: str
    oos_mae_hourly_std: float


class PredictResponse(BaseModel):
    model_version: str
    protocol: str
    as_of: str
    candle_closed_at: str
    data_age_hours: float
    horizon_hours: int
    forecast: Forecast
    risk: Risk
    inputs: Inputs
    monitoring: Monitoring
    model_info: ModelInfo
    disclaimer: str
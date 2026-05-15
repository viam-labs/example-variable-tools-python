"""Standard timing variables that any module loop can update each tick.

Adds a ``system`` child registry with:
  - ``epoch_s``: wall clock seconds since the unix epoch
  - ``uptime_s``: seconds since this ``SystemTiming`` was created
  - ``loop_period_ms``: most recent inter-tick interval
  - ``loop_jitter_ms``: standard deviation of recent inter-tick intervals
  - ``tick_count``: count of ``tick()`` calls

The host module instantiates ``SystemTiming(my_registry)`` at startup and
calls ``.tick()`` each iteration of its control loop. The variables are
read-only via ``vt.set`` (overrides would be meaningless).

The jitter window defaults to the most recent 64 intervals.
"""
from __future__ import annotations

import time
from collections import deque
from typing import Deque, Optional

from .registry import Registry


class SystemTiming:
    def __init__(self, registry: Registry, *, jitter_window: int = 64) -> None:
        if jitter_window < 2:
            raise ValueError("jitter_window must be >= 2")
        self._window = jitter_window
        self._intervals: Deque[float] = deque(maxlen=jitter_window)
        self._last_tick: Optional[float] = None
        self._t0 = time.monotonic()

        sys = registry.add_child("system")
        self._epoch = sys.add_double("epoch_s", time.time(), units="s")
        self._uptime = sys.add_double("uptime_s", 0.0, units="s")
        self._period = sys.add_double("loop_period_ms", 0.0, units="ms")
        self._jitter = sys.add_double("loop_jitter_ms", 0.0, units="ms")
        self._count = sys.add_int("tick_count", 0)

    def tick(self) -> None:
        now = time.monotonic()
        self._epoch.value = time.time()
        self._uptime.value = now - self._t0
        if self._last_tick is not None:
            interval_ms = (now - self._last_tick) * 1000.0
            self._period.value = interval_ms
            self._intervals.append(interval_ms)
            if len(self._intervals) >= 2:
                mean = sum(self._intervals) / len(self._intervals)
                var = sum((x - mean) ** 2 for x in self._intervals) / len(
                    self._intervals
                )
                self._jitter.value = var ** 0.5
        self._last_tick = now
        self._count.value = self._count.value + 1

    def reset(self) -> None:
        """Reset uptime / interval history (e.g. after a long pause)."""
        self._t0 = time.monotonic()
        self._last_tick = None
        self._intervals.clear()
        self._uptime.value = 0.0
        self._period.value = 0.0
        self._jitter.value = 0.0

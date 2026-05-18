"""Tests for SystemTiming.

Time-based behavior is verified by mocking ``time.monotonic`` and
``time.time`` so the test is deterministic.
"""
import math

import pytest

from src.variable_tools import Registry, SystemTiming


def test_attaches_system_child_with_expected_vars():
    r = Registry("root")
    SystemTiming(r)
    flat = r.flatten()
    assert "system_epochS" in flat
    assert "system_uptimeS" in flat
    assert "system_loopPeriodMs" in flat
    assert "system_loopJitterMs" in flat
    assert "system_tickCount" in flat


def test_first_tick_increments_count_no_period_yet(monkeypatch):
    r = Registry("root")
    monkeypatch.setattr("src.variable_tools.timing.time.monotonic", lambda: 100.0)
    monkeypatch.setattr("src.variable_tools.timing.time.time", lambda: 1700000000.0)
    t = SystemTiming(r)
    monkeypatch.setattr("src.variable_tools.timing.time.monotonic", lambda: 100.05)
    t.tick()
    assert r.get("system_tickCount").value == 1
    assert r.get("system_uptimeS").value == pytest.approx(0.05)
    # No previous tick → period stays 0.
    assert r.get("system_loopPeriodMs").value == 0.0


def test_second_tick_records_period(monkeypatch):
    r = Registry("root")
    monkeypatch.setattr("src.variable_tools.timing.time.monotonic", lambda: 100.0)
    monkeypatch.setattr("src.variable_tools.timing.time.time", lambda: 1700000000.0)
    t = SystemTiming(r)
    monkeypatch.setattr("src.variable_tools.timing.time.monotonic", lambda: 100.05)
    t.tick()
    monkeypatch.setattr("src.variable_tools.timing.time.monotonic", lambda: 100.10)
    t.tick()
    assert r.get("system_loopPeriodMs").value == pytest.approx(50.0)
    assert r.get("system_tickCount").value == 2


def test_jitter_zero_for_constant_intervals(monkeypatch):
    r = Registry("root")
    seq = iter([100.0, 100.05, 100.10, 100.15, 100.20])
    monkeypatch.setattr("src.variable_tools.timing.time.monotonic", lambda: next(seq))
    monkeypatch.setattr("src.variable_tools.timing.time.time", lambda: 1700000000.0)
    t = SystemTiming(r)
    for _ in range(4):
        t.tick()
    assert r.get("system_loopJitterMs").value == pytest.approx(0.0, abs=1e-9)


def test_jitter_positive_for_varying_intervals(monkeypatch):
    r = Registry("root")
    # __init__ sees 100.0; first tick 100.05 → no period; subsequent ticks
    # produce intervals of 20ms, 30ms, 100ms (3 samples in the window).
    seq = iter([100.0, 100.05, 100.07, 100.10, 100.20])
    monkeypatch.setattr("src.variable_tools.timing.time.monotonic", lambda: next(seq))
    monkeypatch.setattr("src.variable_tools.timing.time.time", lambda: 1700000000.0)
    t = SystemTiming(r)
    for _ in range(4):
        t.tick()
    intervals_ms = [20.0, 30.0, 100.0]
    mean = sum(intervals_ms) / len(intervals_ms)
    var = sum((x - mean) ** 2 for x in intervals_ms) / len(intervals_ms)
    expected = math.sqrt(var)
    assert r.get("system_loopJitterMs").value == pytest.approx(expected, rel=1e-6)


def test_reset_clears_intervals_and_uptime(monkeypatch):
    r = Registry("root")
    monkeypatch.setattr("src.variable_tools.timing.time.monotonic", lambda: 100.0)
    monkeypatch.setattr("src.variable_tools.timing.time.time", lambda: 1700000000.0)
    t = SystemTiming(r)
    monkeypatch.setattr("src.variable_tools.timing.time.monotonic", lambda: 110.0)
    t.tick()
    monkeypatch.setattr("src.variable_tools.timing.time.monotonic", lambda: 120.0)
    t.tick()
    assert r.get("system_loopPeriodMs").value > 0
    monkeypatch.setattr("src.variable_tools.timing.time.monotonic", lambda: 200.0)
    t.reset()
    assert r.get("system_uptimeS").value == 0.0
    assert r.get("system_loopPeriodMs").value == 0.0
    assert r.get("system_loopJitterMs").value == 0.0


def test_jitter_window_too_small_rejected():
    r = Registry("root")
    with pytest.raises(ValueError, match="jitter_window"):
        SystemTiming(r, jitter_window=1)


def test_system_vars_are_not_tunable():
    r = Registry("root")
    SystemTiming(r)
    for path in [
        "system_epochS",
        "system_uptimeS",
        "system_loopPeriodMs",
        "system_loopJitterMs",
        "system_tickCount",
    ]:
        assert r.get(path).tunable is False


def test_collision_when_added_twice():
    r = Registry("root")
    SystemTiming(r)
    with pytest.raises(ValueError, match="collision"):
        SystemTiming(r)

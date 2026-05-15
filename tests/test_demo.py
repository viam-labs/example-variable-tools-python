"""Tests for the demo Sensor.

Bypass ``EasyResource.new()`` with ``__new__`` + manual init (precedent:
example-visualizations-python and apriltag-tracker). The control loop is
not started in these tests — instead the test mutates the registry
directly so behavior is deterministic.
"""
import math

import pytest

from src.demo import STATE_CYCLE, Demo


def _make_demo() -> Demo:
    """Construct a Demo without the framework lifecycle. Registry is built
    in __init__ but no asyncio task starts."""
    d = Demo.__new__(Demo)
    d._registry = Demo._build_registry()
    d._task = None
    d._t0 = 0.0
    return d


def test_registry_has_expected_paths():
    d = _make_demo()
    assert set(d._registry.flatten().keys()) == {
        "controller.pid.kp",
        "controller.pid.ki",
        "controller.state",
        "diagnostics.loop_count",
        "diagnostics.fault_active",
        "diagnostics.loop_time_ms",
    }


def test_initial_values():
    d = _make_demo()
    flat = d._registry.flatten()
    assert flat["controller.pid.kp"] == 5.0
    assert flat["controller.pid.ki"] == 0.1
    assert flat["controller.state"] == "idle"
    assert flat["diagnostics.loop_count"] == 0
    assert flat["diagnostics.fault_active"] is False
    assert flat["diagnostics.loop_time_ms"] == 0.0


def test_tunable_flags():
    d = _make_demo()
    assert d._registry.get("controller.pid.kp").tunable is True
    assert d._registry.get("controller.pid.ki").tunable is True
    assert d._registry.get("controller.state").tunable is True
    assert d._registry.get("diagnostics.loop_count").tunable is False
    assert d._registry.get("diagnostics.fault_active").tunable is False
    assert d._registry.get("diagnostics.loop_time_ms").tunable is False


def test_state_enum_cases():
    d = _make_demo()
    cases = d._registry.get("controller.state").cases
    assert cases == list(dict.fromkeys(STATE_CYCLE))


async def test_get_readings_returns_flat_dict():
    d = _make_demo()
    readings = await d.get_readings()
    assert isinstance(readings, dict)
    assert "controller.pid.kp" in readings
    assert "diagnostics.loop_count" in readings


async def test_do_command_vt_dump():
    d = _make_demo()
    resp = await d.do_command({"command": "vt.dump"})
    assert "values" in resp
    assert "version" in resp


async def test_do_command_vt_set_tunable():
    d = _make_demo()
    resp = await d.do_command(
        {"command": "vt.set", "path": "controller.pid.kp", "value": 9.5}
    )
    assert resp["ok"] is True
    assert resp["previous"] == 5.0
    assert resp["value"] == 9.5
    flat = d._registry.flatten()
    assert flat["controller.pid.kp"] == 9.5


async def test_do_command_vt_set_non_tunable():
    d = _make_demo()
    resp = await d.do_command(
        {"command": "vt.set", "path": "diagnostics.loop_count", "value": 99}
    )
    assert resp == {"ok": False, "error": "not_tunable"}


async def test_do_command_unrecognized_returns_empty():
    d = _make_demo()
    assert await d.do_command({"command": "not_a_vt_verb"}) == {}
    assert await d.do_command({}) == {}


def test_loop_math_at_t_zero():
    """One-step manual simulation: at t=0, sine is 0 → loop_time_ms = 10.0,
    fault_active = False (int(0/7)%2 == 0), state[0] = idle."""
    t = 0.0
    sine_period = 5.0
    fault_period = 7.0
    assert 10.0 + 2.0 * math.sin(2 * math.pi * t / sine_period) == 10.0
    assert (int(t / fault_period) % 2) == 0
    assert STATE_CYCLE[int(t / 5.0) % len(STATE_CYCLE)] == "idle"


def test_loop_math_state_cycling():
    """At t=5s we should advance to STATE_CYCLE[1] = 'moving'."""
    t = 5.0
    assert STATE_CYCLE[int(t / 5.0) % len(STATE_CYCLE)] == "moving"
    t = 15.0
    assert STATE_CYCLE[int(t / 5.0) % len(STATE_CYCLE)] == "fault"

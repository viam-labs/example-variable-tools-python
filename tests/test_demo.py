"""Tests for the demo Sensor.

Bypass ``EasyResource.new()`` with ``__new__`` + manual init (precedent:
example-visualizations-python and apriltag-tracker). The control loop is
not started in these tests — instead the test mutates the registry
directly so behavior is deterministic.
"""
import math

import pytest

from src.demo import STATE_CYCLE, WAYPOINTS, Demo, _pose_at, _smoothstep


def _make_demo() -> Demo:
    """Construct a Demo without the framework lifecycle. Registry is built
    in __init__ but no asyncio task starts."""
    from src.variable_tools import SystemTiming

    d = Demo.__new__(Demo)
    d._registry = Demo._build_registry()
    d._timing = SystemTiming(d._registry)
    d._task = None
    d._t0 = 0.0
    d._traj_state = "idle"
    d._traj_time = 0.0
    d._last_loop_t = None
    d._filtered = WAYPOINTS[0]
    return d


def test_registry_has_expected_controller_diagnostics_paths():
    d = _make_demo()
    flat = set(d._registry.flatten().keys())
    expected_subset = {
        "controller.pid.kp",
        "controller.pid.ki",
        "controller.state",
        "diagnostics.loop_count",
        "diagnostics.fault_active",
        "diagnostics.loop_time_ms",
    }
    assert expected_subset <= flat


def test_registry_has_system_timing_paths():
    d = _make_demo()
    flat = d._registry.flatten()
    assert "system.epoch_s" in flat
    assert "system.uptime_s" in flat
    assert "system.loop_period_ms" in flat
    assert "system.loop_jitter_ms" in flat
    assert "system.tick_count" in flat


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


# Trajectory + pose tests


def test_trajectory_paths_present():
    d = _make_demo()
    flat = set(d._registry.flatten().keys())
    expected = {
        "trajectory.start",
        "trajectory.pause",
        "trajectory.stop",
        "trajectory.trajectory_time",
        "trajectory.time_in_trajectory",
        "trajectory.state",
        "pose.x",
        "pose.y",
        "pose.z",
        "pose.o_x",
        "pose.o_y",
        "pose.o_z",
        "pose.theta",
        "filtered_pose.x",
        "filtered_pose.theta",
        "filter.alpha_translation",
        "filter.alpha_orientation",
    }
    assert expected <= flat


def test_trajectory_initial_pose_is_first_waypoint():
    d = _make_demo()
    flat = d._registry.flatten()
    assert flat["pose.x"] == WAYPOINTS[0][0]
    assert flat["pose.y"] == WAYPOINTS[0][1]
    assert flat["pose.z"] == WAYPOINTS[0][2]
    assert flat["pose.theta"] == WAYPOINTS[0][6]


def test_trajectory_state_initially_idle():
    d = _make_demo()
    assert d._registry.get("trajectory.state").value == "idle"


def test_smoothstep_endpoints_and_midpoint():
    assert _smoothstep(0.0) == 0.0
    assert _smoothstep(1.0) == 1.0
    assert _smoothstep(0.5) == pytest.approx(0.5)
    # Below 0 / above 1 clamp.
    assert _smoothstep(-0.1) == 0.0
    assert _smoothstep(1.1) == 1.0


def test_pose_at_lands_on_waypoints():
    total = 9.0
    n_seg = len(WAYPOINTS) - 1
    seg = total / n_seg
    # Each waypoint boundary should equal the corresponding waypoint.
    for i, wp in enumerate(WAYPOINTS):
        t = i * seg
        if i == len(WAYPOINTS) - 1:
            t = total
        p = _pose_at(t, total, WAYPOINTS)
        for a, b in zip(p, wp):
            assert a == pytest.approx(b)


def test_pose_at_midpoint_of_segment_uses_smoothstep():
    total = 6.0
    # Middle of first segment: smoothstep(0.5) = 0.5 → linear midpoint.
    p = _pose_at(1.0, total, WAYPOINTS)
    p0 = WAYPOINTS[0]
    p1 = WAYPOINTS[1]
    expected = tuple((a + b) / 2.0 for a, b in zip(p0, p1))
    for got, want in zip(p, expected):
        assert got == pytest.approx(want)


def test_pose_at_clamps_past_total():
    p = _pose_at(100.0, 5.0, WAYPOINTS)
    for a, b in zip(p, WAYPOINTS[-1]):
        assert a == pytest.approx(b)


def test_orientation_is_normalized_after_interpolation():
    # Pick a time inside a segment where orientation lerps.
    total = 6.0
    p = _pose_at(4.5, total, WAYPOINTS)  # in segment 2 → 3 (theta change)
    norm = math.sqrt(p[3] * p[3] + p[4] * p[4] + p[5] * p[5])
    assert norm == pytest.approx(1.0, abs=1e-6)


def test_filter_alphas_are_tunable_with_bounds():
    d = _make_demo()
    a_t = d._registry.get("filter.alpha_translation")
    a_o = d._registry.get("filter.alpha_orientation")
    assert a_t.tunable and a_o.tunable
    assert a_t.min == 0.001 and a_t.max == 1.0
    assert a_o.min == 0.001 and a_o.max == 1.0


def test_trajectory_controls_are_tunable():
    d = _make_demo()
    for path in ("trajectory.start", "trajectory.pause", "trajectory.stop"):
        assert d._registry.get(path).tunable is True
    assert d._registry.get("trajectory.trajectory_time").tunable is True


def test_trajectory_state_and_time_in_trajectory_are_read_only():
    d = _make_demo()
    assert d._registry.get("trajectory.state").tunable is False
    assert d._registry.get("trajectory.time_in_trajectory").tunable is False

"""Tests for the demo Sensor.

Bypass ``EasyResource.new()`` with ``__new__`` + manual init (precedent:
example-visualizations-python and apriltag-tracker). The control loop is
not started in these tests — instead the test mutates the registry
directly so behavior is deterministic.
"""
import math

import pytest

from src.demo import (
    STATE_CYCLE,
    WAYPOINTS,
    Demo,
    _axis_angle_quat,
    _pose_at,
    _slerp,
    _smoothstep,
)


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
        "pose.qw",
        "pose.qx",
        "pose.qy",
        "pose.qz",
        "filtered_pose.x",
        "filtered_pose.qw",
        "filter.alpha_translation",
        "filter.alpha_orientation",
    }
    assert expected <= flat


def test_trajectory_initial_pose_is_first_waypoint():
    d = _make_demo()
    flat = d._registry.flatten()
    for i, name in enumerate(["x", "y", "z", "qw", "qx", "qy", "qz"]):
        assert flat[f"pose.{name}"] == WAYPOINTS[0][i]


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
    n_seg = len(WAYPOINTS) - 1
    total = float(n_seg * 2)  # 2s per segment for clean arithmetic
    # Middle of first segment: t = 0 + seg/2 = 1.0; smoothstep(0.5) = 0.5
    # → translation lands at the linear midpoint of WP[0]→WP[1].
    p = _pose_at(1.0, total, WAYPOINTS)
    p0 = WAYPOINTS[0]
    p1 = WAYPOINTS[1]
    for i in range(3):  # x, y, z
        assert p[i] == pytest.approx((p0[i] + p1[i]) / 2.0)


def test_pose_at_clamps_past_total():
    p = _pose_at(100.0, 5.0, WAYPOINTS)
    for a, b in zip(p, WAYPOINTS[-1]):
        assert a == pytest.approx(b)


def test_quaternion_is_unit_norm_after_interpolation():
    # Several mid-segment times across the trajectory.
    total = 8.0
    for t in (1.0, 2.5, 4.0, 5.5, 7.5):
        p = _pose_at(t, total, WAYPOINTS)
        n = math.sqrt(p[3] ** 2 + p[4] ** 2 + p[5] ** 2 + p[6] ** 2)
        assert n == pytest.approx(1.0, abs=1e-6)


def test_axis_angle_quat_basic_cases():
    # 0 around any axis → identity.
    q = _axis_angle_quat((0.0, 0.0, 1.0), 0.0)
    assert q == pytest.approx((1.0, 0.0, 0.0, 0.0))
    # 180 around X → (0, 1, 0, 0).
    q = _axis_angle_quat((1.0, 0.0, 0.0), 180.0)
    assert q[0] == pytest.approx(0.0, abs=1e-9)
    assert q[1] == pytest.approx(1.0, abs=1e-9)
    assert q[2] == pytest.approx(0.0, abs=1e-9)
    assert q[3] == pytest.approx(0.0, abs=1e-9)
    # 90 around Z → (sqrt(2)/2, 0, 0, sqrt(2)/2).
    q = _axis_angle_quat((0.0, 0.0, 1.0), 90.0)
    sqrt2_2 = math.sqrt(2.0) / 2.0
    assert q[0] == pytest.approx(sqrt2_2, abs=1e-9)
    assert q[3] == pytest.approx(sqrt2_2, abs=1e-9)
    # Non-unit axis is normalized internally.
    q = _axis_angle_quat((2.0, 0.0, 0.0), 90.0)
    sqrt2_2 = math.sqrt(2.0) / 2.0
    assert q[1] == pytest.approx(sqrt2_2, abs=1e-9)


def test_slerp_endpoints_and_midpoint():
    q0 = (1.0, 0.0, 0.0, 0.0)
    q1 = _axis_angle_quat((0.0, 0.0, 1.0), 90.0)
    assert _slerp(q0, q1, 0.0) == pytest.approx(q0)
    assert _slerp(q0, q1, 1.0) == pytest.approx(q1)
    # Midpoint should be the 45° rotation.
    mid = _slerp(q0, q1, 0.5)
    expected = _axis_angle_quat((0.0, 0.0, 1.0), 45.0)
    for a, b in zip(mid, expected):
        assert a == pytest.approx(b, abs=1e-9)


def test_slerp_takes_shortest_path_via_negation():
    q0 = (1.0, 0.0, 0.0, 0.0)
    # Same orientation as identity but with q negated — slerp should
    # treat them as the same and return identity-ish at any t.
    q1 = (-1.0, 0.0, 0.0, 0.0)
    out = _slerp(q0, q1, 0.5)
    # Should be ~identity (or its double-cover negation).
    assert abs(out[0]) == pytest.approx(1.0, abs=1e-6)
    assert out[1] == pytest.approx(0.0, abs=1e-6)
    assert out[2] == pytest.approx(0.0, abs=1e-6)
    assert out[3] == pytest.approx(0.0, abs=1e-6)


def test_waypoints_actually_vary_orientation_components():
    """The whole point of switching to quaternions: rotation should
    visibly vary on multiple components, not just one channel."""
    qx_vals = [wp[4] for wp in WAYPOINTS]
    qy_vals = [wp[5] for wp in WAYPOINTS]
    assert max(qx_vals) - min(qx_vals) > 0.1
    assert max(qy_vals) - min(qy_vals) > 0.1


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

"""``viam:example-variable-tools-python:demo`` — a Sensor that demonstrates
``variable_tools`` end-to-end.

Demonstrates the recommended pattern for adopting the library: define
small **channel classes** that own a child Registry and expose their
variables as public attributes. This gives direct typed ref access
(``self._pid.kp.value``) — no per-tick string lookup, IDE autocomplete,
and refactor-safe rename. The same pattern is used by ``SystemTiming``
in the library itself.

The 20 Hz background loop:
* updates diagnostic vars (counter, sine wave, periodic boolean, enum
  state machine);
* advances a 5-waypoint pose trajectory with smoothstep timing inside
  each segment and slerp orientation between waypoints (so all four
  quaternion components animate);
* applies a 1st-order low-pass filter to the pose — translation lerps,
  orientation slerps — with tunable alphas you can scope live.
"""
import asyncio
import math
import time
from typing import ClassVar, List, Mapping, Optional, Sequence, Tuple

from typing_extensions import Self

from viam.components.sensor import Sensor
from viam.logging import getLogger
from viam.proto.app.robot import ComponentConfig
from viam.proto.common import ResourceName
from viam.resource.base import ResourceBase
from viam.resource.easy_resource import EasyResource
from viam.resource.types import Model, ModelFamily
from viam.utils import SensorReading, ValueTypes

from .variable_tools import Registry, SystemTiming, handle_command

LOGGER = getLogger(__name__)

TICK_HZ = 20.0
STATE_CYCLE = ("idle", "moving", "idle", "fault", "idle")
STATE_PERIOD_S = 5.0
FAULT_PERIOD_S = 7.0
SINE_PERIOD_S = 5.0

TRAJ_STATES = ["idle", "running", "paused"]
DEFAULT_TRAJECTORY_TIME_S = 8.0
DEFAULT_ALPHA = 0.10

# (x_mm, y_mm, z_mm, qw, qx, qy, qz)
Pose = Tuple[float, float, float, float, float, float, float]


# =============================================================================
# Pure math helpers — smoothstep timing, quaternion ops, trajectory eval.
# These don't touch the registry; they're free functions so they can be
# unit-tested without any module scaffolding.
# =============================================================================


def _smoothstep(t: float) -> float:
    """C1-continuous ease in/out — zero velocity at endpoints."""
    if t <= 0.0:
        return 0.0
    if t >= 1.0:
        return 1.0
    return t * t * (3.0 - 2.0 * t)


def _lerp(a: float, b: float, u: float) -> float:
    return a + (b - a) * u


def _quat_dot(a: Tuple[float, ...], b: Tuple[float, ...]) -> float:
    return sum(x * y for x, y in zip(a, b))


def _quat_normalize(q: Tuple[float, ...]) -> Tuple[float, float, float, float]:
    n = math.sqrt(sum(x * x for x in q))
    if n < 1e-9:
        return (1.0, 0.0, 0.0, 0.0)
    return (q[0] / n, q[1] / n, q[2] / n, q[3] / n)


def _slerp(
    q0: Tuple[float, float, float, float],
    q1: Tuple[float, float, float, float],
    t: float,
) -> Tuple[float, float, float, float]:
    """Spherical linear interpolation between two unit quaternions.
    Picks the shortest-path direction (negates q1 if dot is negative).
    Falls back to lerp+normalize when the quaternions are nearly parallel
    to avoid the divide-by-tiny-sin-omega blowup."""
    dot = _quat_dot(q0, q1)
    if dot < 0.0:
        q1 = (-q1[0], -q1[1], -q1[2], -q1[3])
        dot = -dot
    if dot > 0.9995:
        return _quat_normalize(tuple(a + (b - a) * t for a, b in zip(q0, q1)))
    omega = math.acos(max(-1.0, min(1.0, dot)))
    sin_omega = math.sin(omega)
    s0 = math.sin((1.0 - t) * omega) / sin_omega
    s1 = math.sin(t * omega) / sin_omega
    return (
        s0 * q0[0] + s1 * q1[0],
        s0 * q0[1] + s1 * q1[1],
        s0 * q0[2] + s1 * q1[2],
        s0 * q0[3] + s1 * q1[3],
    )


def _axis_angle_quat(
    axis: Tuple[float, float, float], angle_deg: float
) -> Tuple[float, float, float, float]:
    """Unit quaternion (w, x, y, z) from rotation axis + angle in degrees."""
    n = math.sqrt(axis[0] ** 2 + axis[1] ** 2 + axis[2] ** 2)
    if n < 1e-9:
        return (1.0, 0.0, 0.0, 0.0)
    angle = math.radians(angle_deg)
    half = angle / 2.0
    s = math.sin(half)
    return (math.cos(half), axis[0] / n * s, axis[1] / n * s, axis[2] / n * s)


# Waypoints expressed as ((x_mm, y_mm, z_mm), axis, angle_deg) — easier to
# read than raw quaternions — then converted to (x, y, z, qw, qx, qy, qz).
_WAYPOINTS_DEF: List[
    Tuple[Tuple[float, float, float], Tuple[float, float, float], float]
] = [
    ((  0.0,   0.0, 500.0), (0.0, 0.0, 1.0),   0.0),  # home, identity
    ((300.0,   0.0, 300.0), (1.0, 0.0, 0.0),  90.0),  # tilt 90° around +X
    ((300.0, 300.0, 200.0), (0.0, 1.0, 0.0),  90.0),  # tilt 90° around +Y
    ((200.0, 200.0, 400.0), (1.0, 1.0, 0.0),  60.0),  # 60° around (1,1,0)
    ((  0.0,   0.0, 500.0), (0.0, 0.0, 1.0),   0.0),  # back to home
]
WAYPOINTS: List[Pose] = [
    pos + _axis_angle_quat(axis, angle) for pos, axis, angle in _WAYPOINTS_DEF
]


def _pose_at(t: float, total: float, waypoints: Sequence[Pose]) -> Pose:
    """Position+rotation at trajectory time ``t`` (0..total). Translation
    lerps with smoothstep easing; orientation slerps. Endpoints clamp."""
    n_seg = len(waypoints) - 1
    if total <= 0.0 or n_seg <= 0:
        return waypoints[0]
    if t >= total:
        return waypoints[-1]
    seg_dur = total / n_seg
    seg_idx = min(int(t / seg_dur), n_seg - 1)
    local = (t - seg_idx * seg_dur) / seg_dur
    eased = _smoothstep(local)
    p0 = waypoints[seg_idx]
    p1 = waypoints[seg_idx + 1]
    pos = (
        _lerp(p0[0], p1[0], eased),
        _lerp(p0[1], p1[1], eased),
        _lerp(p0[2], p1[2], eased),
    )
    q = _slerp(
        (p0[3], p0[4], p0[5], p0[6]),
        (p1[3], p1[4], p1[5], p1[6]),
        eased,
    )
    return (pos[0], pos[1], pos[2], q[0], q[1], q[2], q[3])


# =============================================================================
# Channel classes — the recommended pattern for grouping related variables.
#
# Each one takes a parent Registry, adds a child registry with its own
# name, and exposes the typed Variable refs as public attributes. The
# host code then holds the channel as `self._pid` etc. and writes /
# reads via `self._pid.kp.value` — no per-tick string lookup, IDE
# autocomplete on field names, and refactor-safe renames.
#
# Convention: snake_case Python attribute names mirror the camelCase
# registry variable names (since the path separator is "_" and names
# can't contain underscores, the wire-side has to be camelCase; the
# Python side stays Pythonic).
# =============================================================================


class _PidGains:
    """Standard PID gains: kp, ki."""

    def __init__(self, parent: Registry, name: str = "pid") -> None:
        sub = parent.add_child(name)
        self.kp = sub.add_double(
            "kp", 5.0, tunable=True, min=0.0, max=100.0, units="N/rad"
        )
        self.ki = sub.add_double(
            "ki", 0.1, tunable=True, min=0.0, units="N/(rad*s)"
        )


class _Diagnostics:
    """Counter + fault flag + sine-wave cycle time."""

    def __init__(self, parent: Registry, name: str = "diagnostics") -> None:
        sub = parent.add_child(name)
        self.loop_count = sub.add_int("loopCount", 0)
        self.fault_active = sub.add_bool("faultActive", False)
        self.loop_time_ms = sub.add_double("loopTimeMs", 0.0, units="ms")


class _TrajectoryControls:
    """Triggers + duration + state for a trajectory player."""

    def __init__(self, parent: Registry, name: str = "trajectory") -> None:
        sub = parent.add_child(name)
        self.start = sub.add_bool("start", False, tunable=True)
        self.pause = sub.add_bool("pause", False, tunable=True)
        self.stop = sub.add_bool("stop", False, tunable=True)
        self.duration = sub.add_double(
            "trajectoryTime",
            DEFAULT_TRAJECTORY_TIME_S,
            tunable=True,
            min=0.5,
            max=60.0,
            units="s",
        )
        self.elapsed = sub.add_double("timeInTrajectory", 0.0, units="s")
        self.state = sub.add_enum("state", "idle", TRAJ_STATES)


class _PoseChannel:
    """7-component pose: translation (mm) + unit quaternion."""

    def __init__(self, parent: Registry, name: str, initial: Pose) -> None:
        sub = parent.add_child(name)
        self.x = sub.add_double("x", initial[0], units="mm")
        self.y = sub.add_double("y", initial[1], units="mm")
        self.z = sub.add_double("z", initial[2], units="mm")
        self.qw = sub.add_double("qw", initial[3])
        self.qx = sub.add_double("qx", initial[4])
        self.qy = sub.add_double("qy", initial[5])
        self.qz = sub.add_double("qz", initial[6])

    def write(self, p: Pose) -> None:
        self.x.value = p[0]
        self.y.value = p[1]
        self.z.value = p[2]
        self.qw.value = p[3]
        self.qx.value = p[4]
        self.qy.value = p[5]
        self.qz.value = p[6]


class _FilterParams:
    """Two tunable low-pass alphas — one for translation, one for orientation."""

    def __init__(self, parent: Registry, name: str = "filter") -> None:
        sub = parent.add_child(name)
        self.alpha_translation = sub.add_double(
            "alphaTranslation",
            DEFAULT_ALPHA,
            tunable=True,
            min=0.001,
            max=1.0,
        )
        self.alpha_orientation = sub.add_double(
            "alphaOrientation",
            DEFAULT_ALPHA,
            tunable=True,
            min=0.001,
            max=1.0,
        )


# =============================================================================
# Demo Sensor
# =============================================================================


class Demo(Sensor, EasyResource):
    MODEL: ClassVar[Model] = Model(
        ModelFamily("viam", "example-variable-tools-python"), "demo"
    )

    def __init__(self, name: str) -> None:
        super().__init__(name)
        self._registry = Registry("demo")
        # Library helper: adds a `system` child with epoch_s / uptime_s /
        # loop_period_ms / loop_jitter_ms / tick_count.
        self._timing = SystemTiming(self._registry)
        # Per-feature channels (see classes above).
        controller = self._registry.add_child("controller")
        self._pid = _PidGains(controller)
        self._ctrl_state = controller.add_enum(
            "state", "idle", list(dict.fromkeys(STATE_CYCLE)), tunable=True
        )
        self._diag = _Diagnostics(self._registry)
        self._traj = _TrajectoryControls(self._registry)
        self._pose = _PoseChannel(self._registry, "pose", WAYPOINTS[0])
        self._filtered = _PoseChannel(
            self._registry, "filteredPose", WAYPOINTS[0]
        )
        self._filter = _FilterParams(self._registry)
        # Runtime state — not registry-exposed, just internal bookkeeping.
        self._task: Optional[asyncio.Task] = None
        self._t0 = time.monotonic()
        self._traj_state: str = "idle"
        self._traj_time: float = 0.0
        self._last_loop_t: Optional[float] = None
        self._filtered_pose: Pose = WAYPOINTS[0]

    @classmethod
    def new(
        cls,
        config: ComponentConfig,
        dependencies: Mapping[ResourceName, ResourceBase],
    ) -> Self:
        instance = super().new(config, dependencies)
        instance.reconfigure(config, dependencies)
        return instance

    @classmethod
    def validate_config(
        cls, config: ComponentConfig
    ) -> Tuple[Sequence[str], Sequence[str]]:
        return [], []

    def reconfigure(
        self,
        config: ComponentConfig,
        dependencies: Mapping[ResourceName, ResourceBase],
    ) -> None:
        if self._task is not None and not self._task.done():
            self._task.cancel()
        self._t0 = time.monotonic()
        self._timing.reset()
        self._traj_state = "idle"
        self._traj_time = 0.0
        self._last_loop_t = None
        self._filtered_pose = WAYPOINTS[0]
        try:
            self._task = asyncio.create_task(self._loop())
        except RuntimeError:
            self._task = None
            LOGGER.debug(
                "no running event loop at reconfigure; loop will not start"
            )

    async def _loop(self) -> None:
        interval = 1.0 / TICK_HZ
        try:
            while True:
                self._timing.tick()
                t = time.monotonic() - self._t0
                dt = (
                    t - self._last_loop_t
                    if self._last_loop_t is not None
                    else interval
                )
                self._last_loop_t = t

                # ---- Diagnostics ----
                self._diag.loop_count.value = self._diag.loop_count.value + 1
                self._diag.loop_time_ms.value = 10.0 + 2.0 * math.sin(
                    2 * math.pi * t / SINE_PERIOD_S
                )
                self._diag.fault_active.value = (int(t / FAULT_PERIOD_S) % 2) == 1
                idx = int(t / STATE_PERIOD_S) % len(STATE_CYCLE)
                if self._ctrl_state.value != STATE_CYCLE[idx]:
                    self._ctrl_state.value = STATE_CYCLE[idx]

                # ---- Trajectory state machine ----
                # stop > start; both are momentary, cleared after handling.
                if self._traj.stop.value:
                    self._traj_state = "idle"
                    self._traj_time = 0.0
                    self._traj.stop.value = False
                if self._traj.start.value:
                    if self._traj_state == "idle":
                        self._traj_time = 0.0
                    self._traj_state = "running"
                    self._traj.start.value = False
                if self._traj_state == "running" and self._traj.pause.value:
                    self._traj_state = "paused"
                elif (
                    self._traj_state == "paused" and not self._traj.pause.value
                ):
                    self._traj_state = "running"

                total = max(0.001, self._traj.duration.value)
                if self._traj_state == "running":
                    self._traj_time += dt
                    if self._traj_time >= total:
                        self._traj_time = total
                        self._traj_state = "idle"

                target = _pose_at(self._traj_time, total, WAYPOINTS)
                self._traj.elapsed.value = self._traj_time
                if self._traj.state.value != self._traj_state:
                    self._traj.state.value = self._traj_state

                # ---- Pose + filtered pose ----
                self._pose.write(target)

                a_t = max(0.0, min(1.0, self._filter.alpha_translation.value))
                a_o = max(0.0, min(1.0, self._filter.alpha_orientation.value))
                fx = _lerp(self._filtered_pose[0], target[0], a_t)
                fy = _lerp(self._filtered_pose[1], target[1], a_t)
                fz = _lerp(self._filtered_pose[2], target[2], a_t)
                fq = _slerp(
                    (
                        self._filtered_pose[3],
                        self._filtered_pose[4],
                        self._filtered_pose[5],
                        self._filtered_pose[6],
                    ),
                    (target[3], target[4], target[5], target[6]),
                    a_o,
                )
                self._filtered_pose = (fx, fy, fz, fq[0], fq[1], fq[2], fq[3])
                self._filtered.write(self._filtered_pose)

                await asyncio.sleep(interval)
        except asyncio.CancelledError:
            raise
        except Exception:
            LOGGER.exception("demo control loop crashed")

    async def close(self) -> None:
        if self._task is not None and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        self._task = None

    async def get_readings(
        self, *, extra=None, timeout=None, **kwargs
    ) -> Mapping[str, SensorReading]:
        return self._registry.flatten()

    async def do_command(
        self,
        command: Mapping[str, ValueTypes],
        *,
        timeout: Optional[float] = None,
        **kwargs,
    ) -> Mapping[str, ValueTypes]:
        resp = handle_command(self._registry, command)
        if resp is not None:
            return resp
        return {}

    async def get_geometries(self, *, extra=None, timeout=None, **kwargs):
        return []

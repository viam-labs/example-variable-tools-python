"""``viam:example-variable-tools-python:demo`` — a Sensor that demonstrates
``variable_tools`` end-to-end.

Builds a small hierarchical registry with a mix of types and tunability,
then runs a 20 Hz background loop that:

  * mutates a few read-only diagnostic vars (counter, sine wave, periodic
    boolean, enum state machine);
  * advances a pose trajectory through waypoints with smoothstep timing
    inside each segment, slerping orientation between waypoints so all
    rotation axes vary visibly;
  * applies a tunable 1st-order low-pass filter to the live pose so users
    can tune the alphas from the scope and see the effect immediately.

Pose uses translation x/y/z in millimetres + a unit quaternion
(qw, qx, qy, qz). Quaternions interpolate cleanly across all rotation
axes (slerp) — unlike the orientation-vector form which requires per-
component lerp + renormalize and only animates well within a single
fixed axis.
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

# Pose = (x_mm, y_mm, z_mm, qw, qx, qy, qz). Unit quaternion.
Pose = Tuple[float, float, float, float, float, float, float]


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
    """Build a unit quaternion (w, x, y, z) from a rotation axis and
    angle in degrees. Axis is normalized internally."""
    n = math.sqrt(axis[0] ** 2 + axis[1] ** 2 + axis[2] ** 2)
    if n < 1e-9:
        return (1.0, 0.0, 0.0, 0.0)
    angle = math.radians(angle_deg)
    half = angle / 2.0
    s = math.sin(half)
    return (math.cos(half), axis[0] / n * s, axis[1] / n * s, axis[2] / n * s)


# Waypoints expressed as ((x_mm, y_mm, z_mm), axis, angle_deg) — easier to
# read than raw quaternions — then converted to (x, y, z, qw, qx, qy, qz).
# Picked so successive segments rotate around different axes and translate
# along different directions: orientation channels qx/qy/qz all vary.
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


class Demo(Sensor, EasyResource):
    MODEL: ClassVar[Model] = Model(
        ModelFamily("viam", "example-variable-tools-python"), "demo"
    )

    def __init__(self, name: str):
        super().__init__(name)
        self._registry = self._build_registry()
        self._timing = SystemTiming(self._registry)
        self._task: Optional[asyncio.Task] = None
        self._t0 = time.monotonic()
        self._traj_state: str = "idle"
        self._traj_time: float = 0.0
        self._last_loop_t: Optional[float] = None
        self._filtered: Pose = WAYPOINTS[0]

    @staticmethod
    def _build_registry() -> Registry:
        root = Registry("demo")

        controller = root.add_child("controller")
        pid = controller.add_child("pid")
        pid.add_double(
            "kp", 5.0, tunable=True, min=0.0, max=100.0, units="N/rad"
        )
        pid.add_double(
            "ki", 0.1, tunable=True, min=0.0, units="N/(rad*s)"
        )
        controller.add_enum(
            "state", "idle", list(dict.fromkeys(STATE_CYCLE)), tunable=True
        )

        diagnostics = root.add_child("diagnostics")
        diagnostics.add_int("loop_count", 0)
        diagnostics.add_bool("fault_active", False)
        diagnostics.add_double("loop_time_ms", 0.0, units="ms")

        # Trajectory controls + readout.
        traj = root.add_child("trajectory")
        traj.add_bool("start", False, tunable=True)
        traj.add_bool("pause", False, tunable=True)
        traj.add_bool("stop", False, tunable=True)
        traj.add_double(
            "trajectory_time",
            DEFAULT_TRAJECTORY_TIME_S,
            tunable=True,
            min=0.5,
            max=60.0,
            units="s",
        )
        traj.add_double("time_in_trajectory", 0.0, units="s")
        traj.add_enum("state", "idle", TRAJ_STATES)

        # Live pose along the trajectory: translation + unit quaternion.
        wp0 = WAYPOINTS[0]
        pose = root.add_child("pose")
        pose.add_double("x", wp0[0], units="mm")
        pose.add_double("y", wp0[1], units="mm")
        pose.add_double("z", wp0[2], units="mm")
        pose.add_double("qw", wp0[3])
        pose.add_double("qx", wp0[4])
        pose.add_double("qy", wp0[5])
        pose.add_double("qz", wp0[6])

        # Filtered pose — same shape, low-pass-smoothed.
        fp = root.add_child("filtered_pose")
        fp.add_double("x", wp0[0], units="mm")
        fp.add_double("y", wp0[1], units="mm")
        fp.add_double("z", wp0[2], units="mm")
        fp.add_double("qw", wp0[3])
        fp.add_double("qx", wp0[4])
        fp.add_double("qy", wp0[5])
        fp.add_double("qz", wp0[6])

        # Filter alphas (per-tick low-pass coefficients). 1.0 = no filter,
        # smaller = more smoothing / more lag.
        f = root.add_child("filter")
        f.add_double(
            "alpha_translation",
            DEFAULT_ALPHA,
            tunable=True,
            min=0.001,
            max=1.0,
        )
        f.add_double(
            "alpha_orientation",
            DEFAULT_ALPHA,
            tunable=True,
            min=0.001,
            max=1.0,
        )

        return root

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
        self._filtered = WAYPOINTS[0]
        try:
            self._task = asyncio.create_task(self._loop())
        except RuntimeError:
            self._task = None
            LOGGER.debug("no running event loop at reconfigure; loop will not start")

    async def _loop(self) -> None:
        interval = 1.0 / TICK_HZ
        loop_count = self._registry.get("diagnostics.loop_count")
        fault_active = self._registry.get("diagnostics.fault_active")
        loop_time_ms = self._registry.get("diagnostics.loop_time_ms")
        state_var = self._registry.get("controller.state")

        traj_start = self._registry.get("trajectory.start")
        traj_pause = self._registry.get("trajectory.pause")
        traj_stop = self._registry.get("trajectory.stop")
        traj_time_var = self._registry.get("trajectory.trajectory_time")
        traj_in = self._registry.get("trajectory.time_in_trajectory")
        traj_state_var = self._registry.get("trajectory.state")

        pose_x = self._registry.get("pose.x")
        pose_y = self._registry.get("pose.y")
        pose_z = self._registry.get("pose.z")
        pose_qw = self._registry.get("pose.qw")
        pose_qx = self._registry.get("pose.qx")
        pose_qy = self._registry.get("pose.qy")
        pose_qz = self._registry.get("pose.qz")

        fp_x = self._registry.get("filtered_pose.x")
        fp_y = self._registry.get("filtered_pose.y")
        fp_z = self._registry.get("filtered_pose.z")
        fp_qw = self._registry.get("filtered_pose.qw")
        fp_qx = self._registry.get("filtered_pose.qx")
        fp_qy = self._registry.get("filtered_pose.qy")
        fp_qz = self._registry.get("filtered_pose.qz")

        alpha_t_var = self._registry.get("filter.alpha_translation")
        alpha_o_var = self._registry.get("filter.alpha_orientation")

        try:
            while True:
                self._timing.tick()
                t = time.monotonic() - self._t0
                dt = (
                    t - self._last_loop_t if self._last_loop_t is not None else interval
                )
                self._last_loop_t = t

                loop_count.value = loop_count.value + 1
                loop_time_ms.value = 10.0 + 2.0 * math.sin(
                    2 * math.pi * t / SINE_PERIOD_S
                )
                fault_active.value = (int(t / FAULT_PERIOD_S) % 2) == 1
                idx = int(t / STATE_PERIOD_S) % len(STATE_CYCLE)
                if state_var.value != STATE_CYCLE[idx]:
                    state_var.value = STATE_CYCLE[idx]

                # ---- Trajectory state machine ----
                if traj_stop.value:
                    self._traj_state = "idle"
                    self._traj_time = 0.0
                    traj_stop.value = False
                if traj_start.value:
                    if self._traj_state == "idle":
                        self._traj_time = 0.0
                    self._traj_state = "running"
                    traj_start.value = False
                if self._traj_state == "running" and traj_pause.value:
                    self._traj_state = "paused"
                elif self._traj_state == "paused" and not traj_pause.value:
                    self._traj_state = "running"

                total = max(0.001, traj_time_var.value)
                if self._traj_state == "running":
                    self._traj_time += dt
                    if self._traj_time >= total:
                        self._traj_time = total
                        self._traj_state = "idle"

                target = _pose_at(self._traj_time, total, WAYPOINTS)

                traj_in.value = self._traj_time
                if traj_state_var.value != self._traj_state:
                    traj_state_var.value = self._traj_state

                pose_x.value = target[0]
                pose_y.value = target[1]
                pose_z.value = target[2]
                pose_qw.value = target[3]
                pose_qx.value = target[4]
                pose_qy.value = target[5]
                pose_qz.value = target[6]

                # ---- 1st-order low-pass on the pose ----
                # Translation: simple lerp per component.
                # Orientation: slerp from filtered toward target by alpha.
                a_t = max(0.0, min(1.0, alpha_t_var.value))
                a_o = max(0.0, min(1.0, alpha_o_var.value))

                fx = _lerp(self._filtered[0], target[0], a_t)
                fy = _lerp(self._filtered[1], target[1], a_t)
                fz = _lerp(self._filtered[2], target[2], a_t)
                fq = _slerp(
                    (self._filtered[3], self._filtered[4], self._filtered[5], self._filtered[6]),
                    (target[3], target[4], target[5], target[6]),
                    a_o,
                )
                self._filtered = (fx, fy, fz, fq[0], fq[1], fq[2], fq[3])

                fp_x.value = self._filtered[0]
                fp_y.value = self._filtered[1]
                fp_z.value = self._filtered[2]
                fp_qw.value = self._filtered[3]
                fp_qx.value = self._filtered[4]
                fp_qy.value = self._filtered[5]
                fp_qz.value = self._filtered[6]

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

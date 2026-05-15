"""``viam:example-variable-tools-python:demo`` — a Sensor that demonstrates
``variable_tools`` end-to-end.

Builds a small hierarchical registry with a mix of types and tunability,
then runs a 20 Hz background loop that:

  * mutates a few read-only diagnostic vars (counter, sine wave, periodic
    boolean, enum state machine);
  * advances a 4-waypoint pose trajectory under start/pause/stop control,
    with smoothstep timing inside each segment so the motion looks like
    a deliberate pick-and-place;
  * applies a tunable 1st-order low-pass filter to the live pose so users
    can tune the alphas from the scope and see the effect immediately.

Pose uses Viam's convention: translation x/y/z in millimetres, orientation
as a unit vector (o_x, o_y, o_z) plus rotation theta in degrees.
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

# Pose = (x_mm, y_mm, z_mm, o_x, o_y, o_z, theta_deg). Unit orientation
# vector + rotation angle is the Viam orientation-vector convention; theta
# is in degrees.
Pose = Tuple[float, float, float, float, float, float, float]

# Pick-and-place-style waypoints — 4 poses, 3 segments. Tool pointing down
# throughout, with a 90° wrist rotation between pickup and place to look
# like an arm reorienting a part.
WAYPOINTS: List[Pose] = [
    (   0.0,    0.0, 500.0, 0.0, 0.0, 1.0,   0.0),  # home
    ( 300.0,    0.0, 200.0, 0.0, 0.0, 1.0,   0.0),  # above pickup
    ( 300.0,  300.0, 200.0, 0.0, 0.0, 1.0,  90.0),  # above place, rotated
    (   0.0,    0.0, 500.0, 0.0, 0.0, 1.0,   0.0),  # back to home
]


def _smoothstep(t: float) -> float:
    """C1-continuous ease in/out — zero velocity at endpoints, peak velocity
    mid-segment. Makes each waypoint look like a deliberate stop."""
    if t <= 0.0:
        return 0.0
    if t >= 1.0:
        return 1.0
    return t * t * (3.0 - 2.0 * t)


def _lerp(a: float, b: float, u: float) -> float:
    return a + (b - a) * u


def _normalize_orientation(p: Pose) -> Pose:
    x, y, z, ox, oy, oz, th = p
    n = math.sqrt(ox * ox + oy * oy + oz * oz)
    if n > 1e-9:
        ox, oy, oz = ox / n, oy / n, oz / n
    return (x, y, z, ox, oy, oz, th)


def _pose_at(t: float, total: float, waypoints: Sequence[Pose]) -> Pose:
    """Position at trajectory time ``t`` (seconds, 0..total), interpolated
    across ``waypoints`` with smoothstep easing within each segment."""
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
    out = tuple(_lerp(a, b, eased) for a, b in zip(p0, p1))
    return _normalize_orientation(out)  # type: ignore[arg-type]


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
        # Trajectory runtime state — separate from the tunable booleans so
        # we have an authoritative source of truth even while the booleans
        # bounce.
        self._traj_state: str = "idle"
        self._traj_time: float = 0.0
        self._last_loop_t: Optional[float] = None
        # Filtered-pose state. Initialized at WAYPOINTS[0] so it doesn't
        # snap from zero on the first tick.
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

        # Live pose along the trajectory, in Viam orientation-vector form.
        pose = root.add_child("pose")
        pose.add_double("x", WAYPOINTS[0][0], units="mm")
        pose.add_double("y", WAYPOINTS[0][1], units="mm")
        pose.add_double("z", WAYPOINTS[0][2], units="mm")
        pose.add_double("o_x", WAYPOINTS[0][3])
        pose.add_double("o_y", WAYPOINTS[0][4])
        pose.add_double("o_z", WAYPOINTS[0][5])
        pose.add_double("theta", WAYPOINTS[0][6], units="deg")

        # Filtered pose — same shape, low-pass-smoothed.
        fp = root.add_child("filtered_pose")
        fp.add_double("x", WAYPOINTS[0][0], units="mm")
        fp.add_double("y", WAYPOINTS[0][1], units="mm")
        fp.add_double("z", WAYPOINTS[0][2], units="mm")
        fp.add_double("o_x", WAYPOINTS[0][3])
        fp.add_double("o_y", WAYPOINTS[0][4])
        fp.add_double("o_z", WAYPOINTS[0][5])
        fp.add_double("theta", WAYPOINTS[0][6], units="deg")

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
        # Cache var refs (lookup-by-path is repeated; refs are cheap).
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
        pose_ox = self._registry.get("pose.o_x")
        pose_oy = self._registry.get("pose.o_y")
        pose_oz = self._registry.get("pose.o_z")
        pose_theta = self._registry.get("pose.theta")

        fp_x = self._registry.get("filtered_pose.x")
        fp_y = self._registry.get("filtered_pose.y")
        fp_z = self._registry.get("filtered_pose.z")
        fp_ox = self._registry.get("filtered_pose.o_x")
        fp_oy = self._registry.get("filtered_pose.o_y")
        fp_oz = self._registry.get("filtered_pose.o_z")
        fp_theta = self._registry.get("filtered_pose.theta")

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
                # stop > start; both are momentary — clear after handling.
                if traj_stop.value:
                    self._traj_state = "idle"
                    self._traj_time = 0.0
                    traj_stop.value = False
                if traj_start.value:
                    if self._traj_state == "idle":
                        self._traj_time = 0.0
                    self._traj_state = "running"
                    traj_start.value = False
                # pause is a state, not a trigger — true means hold time.
                if self._traj_state == "running" and traj_pause.value:
                    self._traj_state = "paused"
                elif self._traj_state == "paused" and not traj_pause.value:
                    self._traj_state = "running"

                # Advance time when running.
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
                pose_ox.value = target[3]
                pose_oy.value = target[4]
                pose_oz.value = target[5]
                pose_theta.value = target[6]

                # ---- 1st-order low-pass on the pose ----
                a_t = max(0.0, min(1.0, alpha_t_var.value))
                a_o = max(0.0, min(1.0, alpha_o_var.value))
                fx, fy, fz, fox, foy, foz, fth = self._filtered
                fx = _lerp(fx, target[0], a_t)
                fy = _lerp(fy, target[1], a_t)
                fz = _lerp(fz, target[2], a_t)
                fox = _lerp(fox, target[3], a_o)
                foy = _lerp(foy, target[4], a_o)
                foz = _lerp(foz, target[5], a_o)
                fth = _lerp(fth, target[6], a_o)
                self._filtered = _normalize_orientation(
                    (fx, fy, fz, fox, foy, foz, fth)
                )

                fp_x.value = self._filtered[0]
                fp_y.value = self._filtered[1]
                fp_z.value = self._filtered[2]
                fp_ox.value = self._filtered[3]
                fp_oy.value = self._filtered[4]
                fp_oz.value = self._filtered[5]
                fp_theta.value = self._filtered[6]

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

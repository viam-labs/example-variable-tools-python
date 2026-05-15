"""``viam:example-variable-tools-python:demo`` — a Sensor that demonstrates
``variable_tools`` end-to-end.

In ``__init__`` it builds a small hierarchical registry with six variables of
mixed types and tunability. A 20 Hz background task mutates the read-only
variables (counter, sine wave, periodic boolean, enum state machine) so the
tunable ones (``controller.pid.kp`` / ``ki`` / ``state``) are the only thing
a client can change via ``vt.set`` — making the tunable round-trip visibly
observable.

``get_readings`` returns ``registry.flatten()``. ``do_command`` delegates to
``variable_tools.handle_command``; unrecognized verbs fall through to an
empty response.
"""
import asyncio
import math
import time
from typing import Any, ClassVar, Mapping, Optional, Sequence, Tuple

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
STATE_CYCLE = ("idle", "moving", "idle", "fault", "idle")  # one cycle per ~25s
STATE_PERIOD_S = 5.0
FAULT_PERIOD_S = 7.0
SINE_PERIOD_S = 5.0


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
        state = self._registry.get("controller.state")
        try:
            while True:
                self._timing.tick()
                t = time.monotonic() - self._t0
                loop_count.value = loop_count.value + 1
                loop_time_ms.value = 10.0 + 2.0 * math.sin(
                    2 * math.pi * t / SINE_PERIOD_S
                )
                fault_active.value = (int(t / FAULT_PERIOD_S) % 2) == 1
                # State cycle: one slot per STATE_PERIOD_S seconds.
                idx = int(t / STATE_PERIOD_S) % len(STATE_CYCLE)
                if state.value != STATE_CYCLE[idx]:
                    state.value = STATE_CYCLE[idx]
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

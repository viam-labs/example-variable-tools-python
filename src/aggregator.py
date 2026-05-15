"""``viam:example-variable-tools-python:aggregator`` — a Sensor that fans
out to declared resource deps and merges their ``variable_tools`` registries
into a single flat reading map suitable for data-manager capture.

Config attributes:
  * ``sources``: required list of resource names. The framework injects each
    as a dependency on reconfigure.
  * ``prefix_with_name``: optional bool, default true. When true, each dep's
    keys are prefixed with ``<resource_name>.``; when false the keys are
    passed through (risk of collisions if two deps publish the same path).

``get_readings`` issues ``vt.dump`` to every dep in parallel and merges the
result. A dep that fails (no ``vt.*`` support, exception, malformed reply)
is logged and skipped; the reading set is partial-but-valid.

``do_command``:
  * ``vt.schema_all`` — refresh cached schemas from each dep, return
    ``{"schemas": {dep_name: <schema>}}``.
  * ``vt.set`` — splits ``path`` on the first ``.`` and routes to that dep's
    ``vt.set``. Unknown dep prefix returns ``{"ok": false, "error":
    "unknown_variable"}``.
"""
import asyncio
from typing import Any, ClassVar, Dict, Mapping, Optional, Sequence, Tuple

from typing_extensions import Self

from viam.components.sensor import Sensor
from viam.logging import getLogger
from viam.proto.app.robot import ComponentConfig
from viam.proto.common import ResourceName
from viam.resource.base import ResourceBase
from viam.resource.easy_resource import EasyResource
from viam.resource.types import Model, ModelFamily
from viam.utils import SensorReading, ValueTypes, struct_to_dict

LOGGER = getLogger(__name__)

ATTR_SOURCES = "sources"
ATTR_PREFIX = "prefix_with_name"


def _parse_sources(config: ComponentConfig) -> Sequence[str]:
    attrs = struct_to_dict(config.attributes)
    raw = attrs.get(ATTR_SOURCES, [])
    if not isinstance(raw, (list, tuple)):
        raise ValueError(f"{ATTR_SOURCES} must be a list of resource names")
    out = []
    for s in raw:
        if not isinstance(s, str) or not s:
            raise ValueError(f"{ATTR_SOURCES} entries must be non-empty strings")
        out.append(s)
    if not out:
        raise ValueError(f"{ATTR_SOURCES} must contain at least one resource name")
    return out


class Aggregator(Sensor, EasyResource):
    MODEL: ClassVar[Model] = Model(
        ModelFamily("viam", "example-variable-tools-python"), "aggregator"
    )

    def __init__(self, name: str):
        super().__init__(name)
        self._deps: Dict[str, ResourceBase] = {}
        self._schemas: Dict[str, Any] = {}
        self._prefix_with_name: bool = True

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
        sources = _parse_sources(config)
        return list(sources), []

    def reconfigure(
        self,
        config: ComponentConfig,
        dependencies: Mapping[ResourceName, ResourceBase],
    ) -> None:
        attrs = struct_to_dict(config.attributes)
        sources = _parse_sources(config)
        self._prefix_with_name = bool(attrs.get(ATTR_PREFIX, True))

        wanted = set(sources)
        resolved: Dict[str, ResourceBase] = {}
        for rn, resource in dependencies.items():
            name = getattr(rn, "name", None)
            if name in wanted:
                resolved[name] = resource
        missing = wanted - set(resolved.keys())
        if missing:
            LOGGER.warning(
                "aggregator: declared sources not present in dependencies: %s",
                sorted(missing),
            )
        # Preserve config order, only for sources that resolved.
        self._deps = {name: resolved[name] for name in sources if name in resolved}
        self._schemas = {}

        # Best-effort schema prefetch — warn and continue on failure.
        # TODO: track this task on self and cancel in close(). Acceptable for
        # v1 because _refresh_schemas only awaits dep do_command calls which
        # are short-lived, but a robust shutdown should cancel it.
        try:
            asyncio.create_task(self._refresh_schemas())
        except RuntimeError:
            LOGGER.debug("no running event loop at reconfigure; schemas will refresh lazily")

    async def _refresh_schemas(self) -> None:
        results = await asyncio.gather(
            *[self._fetch_schema(name, dep) for name, dep in self._deps.items()],
            return_exceptions=True,
        )
        for (name, _), result in zip(self._deps.items(), results):
            if isinstance(result, Exception):
                LOGGER.warning("aggregator: %s vt.schema failed: %s", name, result)
                continue
            if isinstance(result, Mapping) and "schema" in result:
                self._schemas[name] = result

    async def _fetch_schema(self, name: str, dep: ResourceBase) -> Any:
        return await dep.do_command({"command": "vt.schema"})

    async def _fetch_dump(self, name: str, dep: ResourceBase) -> Any:
        return await dep.do_command({"command": "vt.dump"})

    async def get_readings(
        self, *, extra=None, timeout=None, **kwargs
    ) -> Mapping[str, SensorReading]:
        if not self._deps:
            return {}
        results = await asyncio.gather(
            *[self._fetch_dump(name, dep) for name, dep in self._deps.items()],
            return_exceptions=True,
        )
        out: Dict[str, SensorReading] = {}
        for (name, _), result in zip(self._deps.items(), results):
            if isinstance(result, Exception):
                LOGGER.warning("aggregator: %s vt.dump failed: %s", name, result)
                continue
            if not isinstance(result, Mapping):
                LOGGER.warning(
                    "aggregator: %s vt.dump returned %s, expected Mapping",
                    name,
                    type(result).__name__,
                )
                continue
            values = result.get("values")
            if not isinstance(values, Mapping):
                LOGGER.warning(
                    "aggregator: %s vt.dump missing 'values' key", name
                )
                continue
            # Drift check: invalidate cached schema if version disagrees.
            cached = self._schemas.get(name)
            if cached is not None:
                cached_v = cached.get("version")
                live_v = result.get("version")
                if cached_v is not None and live_v is not None and cached_v != live_v:
                    LOGGER.info(
                        "aggregator: %s schema version drift (cached=%s live=%s); "
                        "invalidating",
                        name,
                        cached_v,
                        live_v,
                    )
                    self._schemas.pop(name, None)
            for k, v in values.items():
                key = f"{name}.{k}" if self._prefix_with_name else k
                out[key] = v
        return out

    async def do_command(
        self,
        command: Mapping[str, ValueTypes],
        *,
        timeout: Optional[float] = None,
        **kwargs,
    ) -> Mapping[str, ValueTypes]:
        verb = command.get("command") if isinstance(command, Mapping) else None
        if verb == "vt.schema_all":
            await self._refresh_schemas()
            return {"schemas": dict(self._schemas)}
        if verb == "vt.set":
            return await self._route_set(command)
        return {}

    async def _route_set(
        self, command: Mapping[str, ValueTypes]
    ) -> Mapping[str, ValueTypes]:
        path = command.get("path")
        if not isinstance(path, str) or not path:
            return {"ok": False, "error": "wrong_type"}
        head, sep, rest = path.partition(".")
        if not sep or not rest:
            return {"ok": False, "error": "unknown_variable"}
        dep = self._deps.get(head)
        if dep is None:
            return {"ok": False, "error": "unknown_variable"}
        return await dep.do_command(
            {"command": "vt.set", "path": rest, "value": command.get("value")}
        )

    async def get_geometries(self, *, extra=None, timeout=None, **kwargs):
        return []

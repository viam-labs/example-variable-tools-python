"""Tests for the Aggregator Sensor.

Deps are stubbed as objects with an ``async def do_command``. The
Aggregator's ``_deps`` mapping is poked in directly, bypassing the
framework's resource-name → ResourceBase dependency injection.
"""
import pytest

from viam.proto.app.robot import ComponentConfig
from viam.utils import dict_to_struct

from src.aggregator import Aggregator


def _config(attrs: dict) -> ComponentConfig:
    return ComponentConfig(name="agg", attributes=dict_to_struct(attrs))


class StubDep:
    """Minimal dep stub: answers vt.dump / vt.schema / vt.set."""

    def __init__(self, values, schema=None, version=1):
        self._values = dict(values)
        self._schema = schema or {"name": "stub", "version": version, "variables": [], "children": []}
        self._version = version

    async def do_command(self, command):
        verb = command.get("command")
        if verb == "vt.dump":
            return {"values": dict(self._values), "version": self._version}
        if verb == "vt.schema":
            return {"schema": self._schema, "version": self._version}
        if verb == "vt.set":
            path = command["path"]
            if path not in self._values:
                return {"ok": False, "error": "unknown_variable"}
            prev = self._values[path]
            self._values[path] = command["value"]
            return {"ok": True, "previous": prev, "value": command["value"]}
        return {}


class BrokenDep:
    """Raises on every call."""

    async def do_command(self, command):
        raise RuntimeError("intentional test failure")


class SilentDep:
    """Returns empty {} — emulates a host module that doesn't speak vt.*."""

    async def do_command(self, command):
        return {}


def _make_agg() -> Aggregator:
    a = Aggregator.__new__(Aggregator)
    a._deps = {}
    a._schemas = {}
    a._prefix_with_name = True
    return a


async def test_get_readings_empty_no_deps():
    a = _make_agg()
    assert await a.get_readings() == {}


async def test_get_readings_single_dep_with_prefix():
    a = _make_agg()
    a._deps = {"arm": StubDep({"kp": 5.0, "ki": 0.1})}
    out = await a.get_readings()
    assert out == {"arm.kp": 5.0, "arm.ki": 0.1}


async def test_get_readings_multiple_deps_merge():
    a = _make_agg()
    a._deps = {
        "arm": StubDep({"kp": 5.0}),
        "ctrl": StubDep({"setpoint": 1.5, "active": True}),
    }
    out = await a.get_readings()
    assert out == {
        "arm.kp": 5.0,
        "ctrl.setpoint": 1.5,
        "ctrl.active": True,
    }


async def test_get_readings_without_prefix():
    a = _make_agg()
    a._prefix_with_name = False
    a._deps = {"arm": StubDep({"kp": 5.0})}
    out = await a.get_readings()
    assert out == {"kp": 5.0}


async def test_one_failing_dep_does_not_break_others():
    a = _make_agg()
    a._deps = {
        "good": StubDep({"x": 1.0}),
        "bad": BrokenDep(),
        "alsogood": StubDep({"y": 2.0}),
    }
    out = await a.get_readings()
    assert out == {"good.x": 1.0, "alsogood.y": 2.0}


async def test_silent_dep_skipped():
    """A dep that returns {} (no vt.* support) is logged and skipped, not
    crashing the aggregator."""
    a = _make_agg()
    a._deps = {
        "good": StubDep({"x": 1.0}),
        "silent": SilentDep(),
    }
    out = await a.get_readings()
    assert out == {"good.x": 1.0}


async def test_schema_all_refreshes_from_deps():
    a = _make_agg()
    a._deps = {
        "arm": StubDep(
            {"kp": 5.0},
            schema={"name": "arm", "version": 1, "variables": [], "children": []},
        ),
    }
    resp = await a.do_command({"command": "vt.schema_all"})
    assert "arm" in resp["schemas"]
    assert resp["schemas"]["arm"]["schema"]["name"] == "arm"


async def test_vt_set_routes_to_dep():
    a = _make_agg()
    arm = StubDep({"pid.kp": 5.0})
    a._deps = {"arm": arm}
    resp = await a.do_command(
        {"command": "vt.set", "path": "arm.pid.kp", "value": 9.5}
    )
    assert resp["ok"] is True
    assert arm._values["pid.kp"] == 9.5


async def test_vt_set_unknown_dep_prefix():
    a = _make_agg()
    a._deps = {"arm": StubDep({"kp": 5.0})}
    resp = await a.do_command(
        {"command": "vt.set", "path": "nope.kp", "value": 1.0}
    )
    assert resp == {"ok": False, "error": "unknown_variable"}


async def test_vt_set_no_dot_in_path():
    a = _make_agg()
    a._deps = {"arm": StubDep({"kp": 5.0})}
    resp = await a.do_command({"command": "vt.set", "path": "kp", "value": 1.0})
    assert resp == {"ok": False, "error": "unknown_variable"}


async def test_vt_set_empty_path():
    a = _make_agg()
    a._deps = {"arm": StubDep({"kp": 5.0})}
    resp = await a.do_command({"command": "vt.set", "path": "", "value": 1.0})
    assert resp == {"ok": False, "error": "wrong_type"}


async def test_unknown_do_command_returns_empty():
    a = _make_agg()
    a._deps = {"arm": StubDep({"kp": 5.0})}
    assert await a.do_command({"command": "fly_to_moon"}) == {}


def test_validate_config_returns_sources_as_required_deps():
    cfg = _config({"sources": ["arm-1", "controller"]})
    required, optional = Aggregator.validate_config(cfg)
    assert list(required) == ["arm-1", "controller"]
    assert list(optional) == []


def test_validate_config_rejects_missing_sources():
    cfg = _config({})
    with pytest.raises(ValueError, match="sources"):
        Aggregator.validate_config(cfg)


def test_validate_config_rejects_empty_sources_list():
    cfg = _config({"sources": []})
    with pytest.raises(ValueError, match="at least one"):
        Aggregator.validate_config(cfg)


def test_validate_config_rejects_non_string_entry():
    cfg = _config({"sources": ["good", 123]})
    with pytest.raises(ValueError, match="non-empty strings"):
        Aggregator.validate_config(cfg)


def test_validate_config_rejects_empty_string_entry():
    cfg = _config({"sources": ["good", ""]})
    with pytest.raises(ValueError, match="non-empty strings"):
        Aggregator.validate_config(cfg)


async def test_schema_drift_invalidates_cache():
    """Aggregator caches a dep's schema; if dump's version doesn't match,
    the cache for that dep is invalidated."""
    a = _make_agg()
    dep = StubDep({"x": 1.0}, version=1)
    a._deps = {"arm": dep}
    a._schemas = {
        "arm": {"schema": {"name": "arm", "version": 1, "variables": [], "children": []}, "version": 1}
    }
    # Bump dep version → dump returns version 5
    dep._version = 5
    await a.get_readings()
    assert "arm" not in a._schemas  # invalidated

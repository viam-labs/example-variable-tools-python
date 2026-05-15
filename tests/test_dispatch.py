import pytest

from src.variable_tools import Registry, handle_command


def _build_registry() -> Registry:
    r = Registry("root")
    pid = r.add_child("pid")
    pid.add_double("kp", 5.0, tunable=True, min=0.0, max=100.0, units="N/rad")
    pid.add_double("ki", 0.1, tunable=True, min=0.0)
    r.add_int("count", 0)
    r.add_bool("flag", False)
    r.add_enum("state", "idle", ["idle", "moving", "fault"], tunable=True)
    return r


def test_returns_none_for_non_vt_verb():
    r = _build_registry()
    assert handle_command(r, {"command": "other_verb"}) is None
    assert handle_command(r, {}) is None
    assert handle_command(r, {"command": None}) is None


def test_returns_none_for_non_mapping():
    r = _build_registry()
    assert handle_command(r, None) is None  # type: ignore[arg-type]


def test_vt_dump():
    r = _build_registry()
    resp = handle_command(r, {"command": "vt.dump"})
    assert resp is not None
    assert resp["values"] == {
        "pid.kp": 5.0,
        "pid.ki": 0.1,
        "count": 0,
        "flag": False,
        "state": "idle",
    }
    assert isinstance(resp["version"], int)
    assert resp["version"] >= 1


def test_vt_schema_shape():
    r = _build_registry()
    resp = handle_command(r, {"command": "vt.schema"})
    assert resp is not None
    schema = resp["schema"]
    assert schema["name"] == "root"
    assert isinstance(schema["version"], int)
    # Top-level vars: count, flag, state
    var_names = [v["name"] for v in schema["variables"]]
    assert var_names == ["count", "flag", "state"]
    # Child: pid
    assert [c["name"] for c in schema["children"]] == ["pid"]
    pid = schema["children"][0]
    assert [v["name"] for v in pid["variables"]] == ["kp", "ki"]


def test_vt_paths():
    r = _build_registry()
    resp = handle_command(r, {"command": "vt.paths"})
    assert resp is not None
    assert set(resp["paths"]) == {"pid.kp", "pid.ki", "count", "flag", "state"}


def test_vt_set_ok():
    r = _build_registry()
    resp = handle_command(
        r, {"command": "vt.set", "path": "pid.kp", "value": 9.5}
    )
    assert resp == {"ok": True, "previous": 5.0, "value": 9.5}
    assert r.get("pid.kp").value == 9.5


def test_vt_set_unknown_variable():
    r = _build_registry()
    resp = handle_command(
        r, {"command": "vt.set", "path": "no.such", "value": 1}
    )
    assert resp == {"ok": False, "error": "unknown_variable"}


def test_vt_set_not_tunable():
    r = _build_registry()
    resp = handle_command(r, {"command": "vt.set", "path": "count", "value": 5})
    assert resp == {"ok": False, "error": "not_tunable"}


def test_vt_set_out_of_range_low():
    r = _build_registry()
    resp = handle_command(
        r, {"command": "vt.set", "path": "pid.kp", "value": -1.0}
    )
    assert resp == {"ok": False, "error": "out_of_range"}


def test_vt_set_out_of_range_high():
    r = _build_registry()
    resp = handle_command(
        r, {"command": "vt.set", "path": "pid.kp", "value": 200.0}
    )
    assert resp == {"ok": False, "error": "out_of_range"}


def test_vt_set_only_min_enforced():
    r = _build_registry()
    # pid.ki has min=0.0 but no max
    resp = handle_command(
        r, {"command": "vt.set", "path": "pid.ki", "value": 999.0}
    )
    assert resp["ok"] is True
    assert resp["value"] == 999.0


def test_vt_set_wrong_type_for_double():
    r = _build_registry()
    resp = handle_command(
        r, {"command": "vt.set", "path": "pid.kp", "value": "abc"}
    )
    assert resp == {"ok": False, "error": "wrong_type"}


def test_vt_set_invalid_enum_case():
    r = _build_registry()
    resp = handle_command(
        r, {"command": "vt.set", "path": "state", "value": "running"}
    )
    assert resp == {"ok": False, "error": "invalid_enum_case"}


def test_vt_set_enum_wrong_type():
    r = _build_registry()
    resp = handle_command(
        r, {"command": "vt.set", "path": "state", "value": 5}
    )
    assert resp == {"ok": False, "error": "wrong_type"}


def test_vt_set_missing_path():
    r = _build_registry()
    resp = handle_command(r, {"command": "vt.set", "value": 1.0})
    assert resp == {"ok": False, "error": "wrong_type"}


def test_vt_set_missing_value():
    r = _build_registry()
    resp = handle_command(r, {"command": "vt.set", "path": "pid.kp"})
    assert resp == {"ok": False, "error": "wrong_type"}


def test_unknown_vt_verb_claimed_as_error():
    r = _build_registry()
    resp = handle_command(r, {"command": "vt.fly_to_moon"})
    assert resp == {"ok": False, "error": "unknown_verb"}


def test_dump_version_increases_after_set():
    r = _build_registry()
    v1 = handle_command(r, {"command": "vt.dump"})["version"]
    # vt.set does NOT bump version (only structural adds do)
    handle_command(r, {"command": "vt.set", "path": "pid.kp", "value": 7.0})
    v2 = handle_command(r, {"command": "vt.dump"})["version"]
    assert v1 == v2
    # But adding a variable does bump version
    r.add_double("newvar", 1.0)
    v3 = handle_command(r, {"command": "vt.dump"})["version"]
    assert v3 > v2

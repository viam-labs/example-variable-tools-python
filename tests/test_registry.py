import pytest

from src.variable_tools import Boolean, Double, Enum, Integer, Registry


def test_construct_empty_registry():
    r = Registry("root")
    assert r.name == "root"
    assert r.flatten() == {}
    assert r.effective_version() == 0


def test_add_variables_and_flatten():
    r = Registry("ctrl")
    r.add_double("kp", 5.0)
    r.add_int("count", 0)
    r.add_bool("active", False)
    r.add_enum("state", "idle", ["idle", "moving"])
    assert r.flatten() == {
        "kp": 5.0,
        "count": 0,
        "active": False,
        "state": "idle",
    }


def test_flatten_nested():
    r = Registry("root")
    pid = r.add_child("pid")
    pid.add_double("kp", 5.0)
    pid.add_double("ki", 0.1)
    diag = r.add_child("diag")
    diag.add_int("loops", 7)
    out = r.flatten()
    assert out == {"pid.kp": 5.0, "pid.ki": 0.1, "diag.loops": 7}


def test_deeply_nested():
    r = Registry("a")
    b = r.add_child("b")
    c = b.add_child("c")
    c.add_bool("flag", True)
    assert r.flatten() == {"b.c.flag": True}


def test_version_bumps_on_add():
    r = Registry("root")
    assert r._version == 0
    r.add_double("x", 1.0)
    assert r._version == 1
    r.add_child("child")
    assert r._version == 2


def test_effective_version_max_over_tree():
    r = Registry("root")
    c = r.add_child("c")  # root._version = 1
    c.add_double("x", 1.0)  # c._version = 1
    c.add_double("y", 2.0)  # c._version = 2
    c.add_double("z", 3.0)  # c._version = 3
    # root sees effective = max(1, 3) = 3
    assert r._version == 1
    assert c._version == 3
    assert r.effective_version() == 3


def test_get_variable_by_path():
    r = Registry("root")
    pid = r.add_child("pid")
    var = pid.add_double("kp", 5.0)
    assert r.get("pid.kp") is var


def test_get_top_level_variable():
    r = Registry("root")
    var = r.add_int("count", 0)
    assert r.get("count") is var


def test_get_missing_raises_key_error():
    r = Registry("root")
    r.add_child("pid").add_double("kp", 5.0)
    with pytest.raises(KeyError):
        r.get("pid.ki")
    with pytest.raises(KeyError):
        r.get("nope")
    with pytest.raises(KeyError):
        r.get("pid")  # pid is a child registry, not a variable


def test_get_invalid_path_raises():
    r = Registry("root")
    with pytest.raises(KeyError):
        r.get("")
    with pytest.raises(KeyError):
        r.get(".")
    with pytest.raises(KeyError):
        r.get("a..b")


@pytest.mark.parametrize("bad", ["", "with.dot", "with space", "with/slash", "tab\t"])
def test_name_validation_rejects_invalid(bad):
    r = Registry("root")
    with pytest.raises(ValueError):
        r.add_double(bad, 1.0)
    with pytest.raises(ValueError):
        r.add_child(bad)


@pytest.mark.parametrize("good", ["a", "Z", "snake_case", "kebab-case", "x1", "_x"])
def test_name_validation_accepts_valid(good):
    r = Registry("root")
    r.add_double(good, 1.0)


def test_name_collision_var_vs_var():
    r = Registry("root")
    r.add_double("x", 1.0)
    with pytest.raises(ValueError, match="collision"):
        r.add_int("x", 1)


def test_name_collision_var_vs_child():
    r = Registry("root")
    r.add_double("x", 1.0)
    with pytest.raises(ValueError, match="collision"):
        r.add_child("x")


def test_name_collision_child_vs_var():
    r = Registry("root")
    r.add_child("x")
    with pytest.raises(ValueError, match="collision"):
        r.add_double("x", 1.0)


def test_invalid_registry_name_at_construction():
    with pytest.raises(ValueError):
        Registry("bad name")
    with pytest.raises(ValueError):
        Registry("bad.name")


# Variable coercion tests


def test_double_coerces_int_and_float():
    r = Registry("r")
    d = r.add_double("x", 1.0)
    d.value = 2
    assert d.value == 2.0
    assert isinstance(d.value, float)
    d.value = 3.5
    assert d.value == 3.5


def test_double_rejects_bool():
    r = Registry("r")
    d = r.add_double("x", 1.0)
    with pytest.raises(TypeError):
        d.value = True


def test_double_rejects_str():
    r = Registry("r")
    d = r.add_double("x", 1.0)
    with pytest.raises(TypeError):
        d.value = "hi"


def test_integer_coerces_int():
    r = Registry("r")
    i = r.add_int("x", 0)
    i.value = 5
    assert i.value == 5


def test_integer_coerces_integer_float():
    r = Registry("r")
    i = r.add_int("x", 0)
    i.value = 5.0
    assert i.value == 5


def test_integer_rejects_non_integer_float():
    r = Registry("r")
    i = r.add_int("x", 0)
    with pytest.raises(TypeError):
        i.value = 5.5


def test_integer_rejects_bool():
    r = Registry("r")
    i = r.add_int("x", 0)
    with pytest.raises(TypeError):
        i.value = True


def test_integer_rejects_bool_initial():
    r = Registry("r")
    with pytest.raises(TypeError):
        r.add_int("x", True)


def test_boolean_accepts_bool():
    r = Registry("r")
    b = r.add_bool("x", False)
    b.value = True
    assert b.value is True


def test_boolean_rejects_int():
    r = Registry("r")
    b = r.add_bool("x", False)
    with pytest.raises(TypeError):
        b.value = 1


def test_boolean_initial_must_be_bool():
    r = Registry("r")
    with pytest.raises(TypeError):
        r.add_bool("x", 1)


def test_enum_construction_validates():
    r = Registry("r")
    e = r.add_enum("s", "a", ["a", "b", "c"])
    assert e.value == "a"
    assert e.cases == ["a", "b", "c"]


def test_enum_initial_must_be_in_cases():
    r = Registry("r")
    with pytest.raises(ValueError):
        r.add_enum("s", "z", ["a", "b"])


def test_enum_empty_cases_rejected():
    r = Registry("r")
    with pytest.raises(ValueError):
        r.add_enum("s", "a", [])


def test_enum_rejects_unknown_case_on_set():
    r = Registry("r")
    e = r.add_enum("s", "a", ["a", "b"])
    with pytest.raises(ValueError):
        e.value = "z"


def test_enum_rejects_non_str_on_set():
    r = Registry("r")
    e = r.add_enum("s", "a", ["a", "b"])
    with pytest.raises(TypeError):
        e.value = 5


def test_variable_default_tunable_false():
    r = Registry("r")
    d = r.add_double("x", 1.0)
    assert d.tunable is False


def test_variable_tunable_true_via_kw():
    r = Registry("r")
    d = r.add_double("x", 1.0, tunable=True)
    assert d.tunable is True


def test_variable_units_stored():
    r = Registry("r")
    d = r.add_double("x", 1.0, units="N/rad")
    assert d.units == "N/rad"


def test_double_min_max_stored_but_not_enforced_internally():
    """Min/max are advisory — internal writes bypass them. vt.set enforces."""
    r = Registry("r")
    d = r.add_double("x", 1.0, min=0.0, max=10.0)
    # Internal write outside bounds is allowed (trusted control loop).
    d.value = -5.0
    assert d.value == -5.0
    d.value = 100.0
    assert d.value == 100.0

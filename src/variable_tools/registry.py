"""Hierarchical typed-variable registry.

A ``Registry`` owns ordered child Registries and ordered Variables. Variables
come in four flavors: ``Double``, ``Integer``, ``Boolean``, ``Enum``. Names
must match ``[A-Za-z0-9_-]+`` because ``.`` is reserved as the path separator.

The registry tracks a monotonically-increasing version int that is bumped on
every structural mutation (add). The "effective version" reported by
``schema()`` and ``flatten()``-related verbs is the max over the tree, so an
aggregator can detect schema drift by comparing the version it cached against
the version returned with each ``vt.dump``.
"""
import re
from typing import Any, Dict, Optional, Sequence, Union

NAME_RE = re.compile(r"^[A-Za-z0-9_-]+$")
PATH_SEP = "."

Scalar = Union[float, bool, int, str]


def _validate_name(name: str) -> None:
    if not isinstance(name, str) or not NAME_RE.match(name):
        raise ValueError(
            f"invalid name {name!r}: must match {NAME_RE.pattern} (no dots, no whitespace)"
        )


class Variable:
    """Base class. Construct via ``Registry.add_*`` rather than directly."""

    def __init__(self, name: str, *, tunable: bool = False, units: Optional[str] = None):
        _validate_name(name)
        self.name = name
        self.tunable = bool(tunable)
        self.units = units
        self._value: Scalar = None  # type: ignore[assignment]

    @property
    def value(self) -> Scalar:
        return self._value

    @value.setter
    def value(self, v: Scalar) -> None:
        self._value = self._coerce(v)

    def _coerce(self, v: Scalar) -> Scalar:
        raise NotImplementedError

    def _type_name(self) -> str:
        raise NotImplementedError

    def schema(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "name": self.name,
            "type": self._type_name(),
            "tunable": self.tunable,
        }
        if self.units is not None:
            out["units"] = self.units
        return out


class Double(Variable):
    def __init__(
        self,
        name: str,
        initial: float,
        *,
        units: Optional[str] = None,
        tunable: bool = False,
        min: Optional[float] = None,
        max: Optional[float] = None,
    ):
        super().__init__(name, tunable=tunable, units=units)
        self.min = float(min) if min is not None else None
        self.max = float(max) if max is not None else None
        self._value = float(initial)

    def _coerce(self, v: Scalar) -> float:
        if isinstance(v, bool):
            raise TypeError("expected float, got bool")
        if not isinstance(v, (int, float)):
            raise TypeError(f"expected float, got {type(v).__name__}")
        return float(v)

    def _type_name(self) -> str:
        return "double"

    def schema(self) -> Dict[str, Any]:
        out = super().schema()
        if self.min is not None:
            out["min"] = self.min
        if self.max is not None:
            out["max"] = self.max
        return out


class Integer(Variable):
    def __init__(
        self,
        name: str,
        initial: int,
        *,
        units: Optional[str] = None,
        tunable: bool = False,
        min: Optional[int] = None,
        max: Optional[int] = None,
    ):
        super().__init__(name, tunable=tunable, units=units)
        self.min = int(min) if min is not None else None
        self.max = int(max) if max is not None else None
        if isinstance(initial, bool):
            raise TypeError("expected int, got bool")
        self._value = int(initial)

    def _coerce(self, v: Scalar) -> int:
        if isinstance(v, bool):
            raise TypeError("expected int, got bool")
        if isinstance(v, float):
            if not v.is_integer():
                raise TypeError(f"expected int, got non-integer float {v!r}")
            return int(v)
        if not isinstance(v, int):
            raise TypeError(f"expected int, got {type(v).__name__}")
        return int(v)

    def _type_name(self) -> str:
        return "integer"

    def schema(self) -> Dict[str, Any]:
        out = super().schema()
        if self.min is not None:
            out["min"] = self.min
        if self.max is not None:
            out["max"] = self.max
        return out


class Boolean(Variable):
    def __init__(self, name: str, initial: bool, *, tunable: bool = False):
        super().__init__(name, tunable=tunable)
        if not isinstance(initial, bool):
            raise TypeError(f"expected bool, got {type(initial).__name__}")
        self._value = bool(initial)

    def _coerce(self, v: Scalar) -> bool:
        if not isinstance(v, bool):
            raise TypeError(f"expected bool, got {type(v).__name__}")
        return bool(v)

    def _type_name(self) -> str:
        return "boolean"


class Enum(Variable):
    def __init__(
        self,
        name: str,
        initial: str,
        cases: Sequence[str],
        *,
        tunable: bool = False,
    ):
        super().__init__(name, tunable=tunable)
        cases_l = list(cases)
        if not cases_l:
            raise ValueError("enum requires at least one case")
        for c in cases_l:
            if not isinstance(c, str) or not c:
                raise ValueError(f"enum case must be non-empty str: {c!r}")
        self.cases = cases_l
        if initial not in cases_l:
            raise ValueError(f"initial {initial!r} not in cases {cases_l}")
        self._value = initial

    def _coerce(self, v: Scalar) -> str:
        if not isinstance(v, str):
            raise TypeError(f"expected str, got {type(v).__name__}")
        if v not in self.cases:
            raise ValueError(f"{v!r} not in cases {self.cases}")
        return v

    def _type_name(self) -> str:
        return "enum"

    def schema(self) -> Dict[str, Any]:
        out = super().schema()
        out["cases"] = list(self.cases)
        return out


class Registry:
    """Hierarchical container of Variables and child Registries.

    Insertion order is preserved for both. Names of variables and child
    registries share a single namespace (no var named ``foo`` plus child
    named ``foo``). ``_version`` increments on every successful add.
    """

    def __init__(self, name: str):
        _validate_name(name)
        self.name = name
        self._version: int = 0
        self._vars: Dict[str, Variable] = {}
        self._children: Dict[str, "Registry"] = {}

    def _check_free(self, name: str) -> None:
        _validate_name(name)
        if name in self._vars or name in self._children:
            raise ValueError(
                f"name collision: {name!r} already exists in registry {self.name!r}"
            )

    def _add_var(self, var: Variable) -> None:
        self._check_free(var.name)
        self._vars[var.name] = var
        self._version += 1

    def add_double(self, name: str, initial: float, **kw: Any) -> Double:
        v = Double(name, initial, **kw)
        self._add_var(v)
        return v

    def add_int(self, name: str, initial: int, **kw: Any) -> Integer:
        v = Integer(name, initial, **kw)
        self._add_var(v)
        return v

    def add_bool(self, name: str, initial: bool, **kw: Any) -> Boolean:
        v = Boolean(name, initial, **kw)
        self._add_var(v)
        return v

    def add_enum(
        self, name: str, initial: str, cases: Sequence[str], **kw: Any
    ) -> Enum:
        v = Enum(name, initial, cases, **kw)
        self._add_var(v)
        return v

    def add_child(self, name: str) -> "Registry":
        self._check_free(name)
        child = Registry(name)
        self._children[name] = child
        self._version += 1
        return child

    def get(self, path: str) -> Variable:
        """Look up a variable by dotted path. Raises ``KeyError`` if missing."""
        if not isinstance(path, str) or not path:
            raise KeyError(f"invalid path: {path!r}")
        parts = path.split(PATH_SEP)
        if any(not p for p in parts):
            raise KeyError(f"invalid path: {path!r}")
        node = self
        for i, p in enumerate(parts[:-1]):
            if p not in node._children:
                raise KeyError(f"no such registry: {PATH_SEP.join(parts[: i + 1])}")
            node = node._children[p]
        last = parts[-1]
        if last not in node._vars:
            raise KeyError(f"no such variable: {path}")
        return node._vars[last]

    def flatten(self) -> Dict[str, Scalar]:
        """Flat ``{dotted_path: value}`` over the whole subtree.

        The Registry's own name is NOT included in returned paths — callers
        (typically the aggregator) prefix with the resource name themselves.
        """
        out: Dict[str, Scalar] = {}
        self._flatten_into(out, "")
        return out

    def _flatten_into(self, out: Dict[str, Scalar], prefix: str) -> None:
        for vname, var in self._vars.items():
            out[f"{prefix}{vname}"] = var.value
        for cname, child in self._children.items():
            child._flatten_into(out, f"{prefix}{cname}{PATH_SEP}")

    def effective_version(self) -> int:
        """Max ``_version`` across this Registry and all descendants."""
        v = self._version
        for child in self._children.values():
            cv = child.effective_version()
            if cv > v:
                v = cv
        return v

    def schema(self) -> Dict[str, Any]:
        """Recursive schema tree. Byte-stable: keys ordered, ``None``-valued
        optional fields omitted."""
        return {
            "name": self.name,
            "version": self.effective_version(),
            "variables": [v.schema() for v in self._vars.values()],
            "children": [c.schema() for c in self._children.values()],
        }

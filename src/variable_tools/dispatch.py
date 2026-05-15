"""``vt.*`` DoCommand verb dispatch.

A host module wires the library into its ``do_command`` like:

    async def do_command(self, command, ...):
        if (resp := handle_command(self._registry, command)) is not None:
            return resp
        # ... host's own verbs ...
        return {}

``handle_command`` returns ``None`` if the verb isn't a ``vt.*`` verb, so the
host falls through to its own dispatch. Returning a dict (even an error dict)
means ``handle_command`` claimed the verb.
"""
from typing import Any, Mapping, Optional

from .registry import Double, Enum, Integer, Registry


def handle_command(
    reg: Registry, command: Mapping[str, Any]
) -> Optional[Mapping[str, Any]]:
    if not isinstance(command, Mapping):
        return None
    verb = command.get("command")
    if not isinstance(verb, str) or not verb.startswith("vt."):
        return None

    if verb == "vt.dump":
        return {"values": reg.flatten(), "version": reg.effective_version()}
    if verb == "vt.schema":
        return {"schema": reg.schema(), "version": reg.effective_version()}
    if verb == "vt.paths":
        return {
            "paths": list(reg.flatten().keys()),
            "version": reg.effective_version(),
        }
    if verb == "vt.set":
        return _handle_set(reg, command)
    return {"ok": False, "error": "unknown_verb"}


def _handle_set(reg: Registry, command: Mapping[str, Any]) -> Mapping[str, Any]:
    path = command.get("path")
    if not isinstance(path, str) or not path:
        return {"ok": False, "error": "wrong_type"}
    if "value" not in command:
        return {"ok": False, "error": "wrong_type"}
    value = command["value"]

    try:
        var = reg.get(path)
    except KeyError:
        return {"ok": False, "error": "unknown_variable"}

    if not var.tunable:
        return {"ok": False, "error": "not_tunable"}

    previous = var.value
    try:
        coerced = var._coerce(value)
    except TypeError:
        return {"ok": False, "error": "wrong_type"}
    except ValueError:
        if isinstance(var, Enum):
            return {"ok": False, "error": "invalid_enum_case"}
        return {"ok": False, "error": "wrong_type"}

    if isinstance(var, (Double, Integer)):
        if var.min is not None and coerced < var.min:
            return {"ok": False, "error": "out_of_range"}
        if var.max is not None and coerced > var.max:
            return {"ok": False, "error": "out_of_range"}

    var._value = coerced
    return {"ok": True, "previous": previous, "value": coerced}

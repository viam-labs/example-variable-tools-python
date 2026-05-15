"""Public surface for ``variable_tools``.

A drop-in library for Viam Python modules to expose a hierarchical registry
of named, typed, runtime-mutable variables (doubles, integers, booleans,
enums) for live monitoring and tuning over ``do_command``.
"""
from .dispatch import handle_command
from .registry import (
    NAME_RE,
    PATH_SEP,
    Boolean,
    Double,
    Enum,
    Integer,
    Registry,
    Variable,
)

__all__ = [
    "Registry",
    "Variable",
    "Double",
    "Integer",
    "Boolean",
    "Enum",
    "handle_command",
    "NAME_RE",
    "PATH_SEP",
]

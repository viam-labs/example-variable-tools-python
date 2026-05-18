"""Public surface for ``variable_tools``.

A drop-in library for Viam Python modules to expose a hierarchical registry
of named, typed, runtime-mutable variables (doubles, integers, booleans,
enums) for live monitoring and tuning over ``do_command``.

Wire-format contract (versioned):

  * ``SCHEMA_FORMAT_VERSION`` is sent in every dispatch response and is
    incremented when the JSON shape changes in a way that breaks naive
    clients. Bumps imply you need to update your reader.
"""
from .dispatch import handle_command
from .registry import (
    DEFAULT_PATH_SEP,
    NAME_RE,
    Boolean,
    Double,
    Enum,
    Integer,
    Registry,
    Variable,
)
from .timing import SystemTiming

# Bump on any change to the dispatch response shape (vt.dump / vt.schema /
# vt.set / vt.paths / vt.schema_all). The schema dict itself (returned
# inside the response) is byte-stable separately — see
# tests/test_schema_golden.py.
SCHEMA_FORMAT_VERSION = 1

__all__ = [
    "Boolean",
    "DEFAULT_PATH_SEP",
    "Double",
    "Enum",
    "Integer",
    "NAME_RE",
    "Registry",
    "SCHEMA_FORMAT_VERSION",
    "SystemTiming",
    "Variable",
    "handle_command",
]

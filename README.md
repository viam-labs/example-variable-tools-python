# example-variable-tools-python

A drop-in Python library plus two example Sensors for exposing a hierarchical
registry of named, typed, runtime-mutable variables (`Double`, `Integer`,
`Boolean`, `Enum`) from a Viam module. Inspired by IHMC YoVariables, reshaped
for Viam idioms — flat dotted-path readings for the hot path, schema and
tuning over `do_command`.

## What this gives you

```
variable_tools (library)             ← drop into your existing module
├── Registry  (hierarchical container)
├── Double / Integer / Boolean / Enum
├── handle_command(reg, cmd)         ← mixin do_command dispatch
└── flatten(), schema()              ← for get_readings + vt.schema

viam:example-variable-tools-python:demo (Sensor)
  ├── 6 variables across 2 child registries (controller, diagnostics)
  ├── 20 Hz fake control loop mutates the read-only ones
  └── get_readings = flatten(), do_command = handle_command

viam:example-variable-tools-python:aggregator (Sensor)
  ├── takes resource deps via config "sources": [...]
  ├── parallel vt.dump fan-out, prefix keys with dep name
  └── data manager auto-captures the unified flat map
```

## Drop-in pattern for your own module

The library is not on PyPI. To use it, copy `src/variable_tools/` from this
repo into your own module's `src/` directory — the package is pure Python and
has no external dependencies beyond the standard library. Import it as
`from .variable_tools import ...` relative to your module package, e.g.:

```python
from .variable_tools import Registry, handle_command


class MyArm(Arm, EasyResource):
    def __init__(self, name):
        super().__init__(name)
        self._registry = Registry("my_arm")
        pid = self._registry.add_child("pid")
        self._kp = pid.add_double("kp", 5.0, tunable=True, min=0.0, max=100.0)
        self._diag = self._registry.add_child("diag")
        self._loop_count = self._diag.add_int("loop_count", 0)

    async def do_command(self, command, **kwargs):
        if (resp := handle_command(self._registry, command)) is not None:
            return resp
        # ... your own verbs ...
        return {}

    # In your control loop:
    #   self._loop_count.value = self._loop_count.value + 1
    #   self._kp.value = 6.0    # in-process, no IPC
```

Then a client can introspect the registry:

```
# Get the current values (flat dotted-path keys):
do_command({"command": "vt.dump"})
→ {"values": {"pid.kp": 5.0, "diag.loop_count": 42}, "version": 2}

# Get the schema (sent once, cache client-side):
do_command({"command": "vt.schema"})
→ {"schema": {"name": "my_arm", "version": 2, "children": [...], ...}}

# Tune a variable at runtime:
do_command({"command": "vt.set", "path": "pid.kp", "value": 9.5})
→ {"ok": true, "previous": 5.0, "value": 9.5}
```

## Verb contract

All verbs are namespaced `vt.*` to avoid colliding with your module's own
DoCommand verbs. `handle_command` returns `None` if the verb isn't `vt.*`,
so your dispatch can fall through.

| Verb | Input | Output |
|---|---|---|
| `vt.dump` | `{"command": "vt.dump"}` | `{"values": {path: scalar}, "version": int}` |
| `vt.schema` | `{"command": "vt.schema"}` | `{"schema": <tree>, "version": int}` |
| `vt.paths` | `{"command": "vt.paths"}` | `{"paths": [str], "version": int}` |
| `vt.set` | `{"command": "vt.set", "path": str, "value": scalar}` | `{"ok": true, "previous": scalar, "value": scalar}` OR `{"ok": false, "error": code}` |

`vt.set` error codes: `unknown_variable`, `not_tunable`, `out_of_range`,
`wrong_type`, `invalid_enum_case`. Min/max bounds are enforced **only** on
`vt.set` — internal `var.value = ...` from your control loop is trusted (it
may briefly overshoot bounds and that shouldn't crash).

## Wire format

`get_readings` returns flat dotted-path keys: `{"controller.pid.kp": 5.0,
"diagnostics.loop_count": 42}`. The tree shape lives in `vt.schema` and is
sent once per client. This matches IHMC's SCS log convention and means Viam
Cloud's data tab plots each variable as its own scalar time-series — nested
readings would either get flattened anyway or stored as un-plottable JSON.

Variable and registry names must match `^[A-Za-z0-9_-]+$` — the `.`
separator is reserved, dots in names would be ambiguous. Duplicates inside
a single registry are rejected at add time.

## Configuring the demo

```json
{
  "modules": [
    {
      "type": "registry",
      "name": "example-variable-tools-python",
      "module_id": "viam:example-variable-tools-python",
      "version": "0.0.1"
    }
  ],
  "components": [
    {
      "name": "vt-demo",
      "namespace": "rdk",
      "type": "sensor",
      "model": "viam:example-variable-tools-python:demo",
      "attributes": {}
    }
  ]
}
```

`get_readings` on `vt-demo` returns the 6 variables every poll;
`do_command` answers all four `vt.*` verbs.

## Configuring the aggregator

```json
{
  "components": [
    {
      "name": "vt-aggregator",
      "namespace": "rdk",
      "type": "sensor",
      "model": "viam:example-variable-tools-python:aggregator",
      "attributes": {
        "sources": ["vt-demo", "my-arm"],
        "prefix_with_name": true
      }
    }
  ]
}
```

The aggregator declares each entry in `sources` as a required dependency,
calls `vt.dump` on all of them in parallel, and merges the results into one
flat map with keys prefixed by source name. A source that doesn't speak
`vt.*` (or crashes) is logged and skipped — the reading set is
partial-but-valid.

`do_command` on the aggregator:
- `vt.schema_all` returns merged schemas keyed by dep name
- `vt.set` routes by path prefix: `vt-demo.controller.pid.kp` → forwards to
  the `vt-demo` dep as `controller.pid.kp`

## Tests

```sh
make test
```

Runs the full pytest suite. The schema-format golden test
(`tests/test_schema_golden.py`) is byte-stable — any intentional change to
the schema shape must update the stored golden string.

## What this isn't

- **Not real-time at control-loop rate.** Polling over gRPC realistically
  caps around 50–100 Hz; IHMC's 1 kHz scrubbing is out of reach without a
  separate streaming verb. For diagnostics and tuning, polling is fine.
- **Not cross-process state.** Each module owns its own registry. Variable
  updates inside a module are in-process and free; the aggregator's
  cross-module merge is poll-based, not push-based.

## License

Apache 2.0.

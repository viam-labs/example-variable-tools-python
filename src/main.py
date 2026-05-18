"""Module entrypoint.

Importing ``Demo`` and ``Scope`` triggers their ``EasyResource``
self-registration via class-creation side effect; ``Module.run_from_registry``
then serves both models over gRPC.
"""
import asyncio

from viam.module.module import Module

from .demo import Demo  # noqa: F401  (registers the model)
from .scope import Scope  # noqa: F401  (registers the model)


if __name__ == "__main__":
    asyncio.run(Module.run_from_registry())

"""Module entrypoint.

Importing ``Demo`` and ``Aggregator`` triggers their ``EasyResource``
self-registration via class-creation side effect; ``Module.run_from_registry``
then serves both models over gRPC.
"""
import asyncio

from viam.module.module import Module

from .aggregator import Aggregator  # noqa: F401  (registers the model)
from .demo import Demo  # noqa: F401  (registers the model)


if __name__ == "__main__":
    asyncio.run(Module.run_from_registry())

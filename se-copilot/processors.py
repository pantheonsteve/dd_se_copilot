"""Post-processor plugin interface for downstream consumers of synthesized output."""

from __future__ import annotations

import logging
from typing import Protocol, runtime_checkable

from ddtrace.llmobs.decorators import task

from models import PipelineContext

logger = logging.getLogger(__name__)


@runtime_checkable
class PostProcessor(Protocol):
    """Interface that all post-synthesis processors must satisfy."""

    name: str

    async def process(self, ctx: PipelineContext) -> PipelineContext: ...


_processors: list[PostProcessor] = []


def register(proc: PostProcessor) -> None:
    """Register a post-processor to run after synthesis."""
    _processors.append(proc)
    logger.info("Registered post-processor: %s", proc.name)


def clear() -> None:
    """Remove all registered processors (useful for testing)."""
    _processors.clear()


@task(name="run_all")
async def run_all(ctx: PipelineContext) -> PipelineContext:
    """Execute every registered post-processor in order."""
    for proc in _processors:
        try:
            ctx = await proc.process(ctx)
        except Exception:
            logger.exception("Post-processor '%s' failed", proc.name)
    return ctx

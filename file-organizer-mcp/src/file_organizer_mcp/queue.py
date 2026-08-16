from __future__ import annotations
import asyncio
import time
from collections.abc import Callable
from .errors import QueueFullError, QueueTimeoutError


class SequentialJobQueue:
    def __init__(self, max_queued: int, wait_timeout: float, processing_timeout: float):
        self.max_queued = max_queued
        self.wait_timeout = wait_timeout
        self.processing_timeout = processing_timeout
        self._run_lock = asyncio.Lock()
        self._state_lock = asyncio.Lock()
        self._waiting = 0
        self._background: set[asyncio.Task] = set()

    async def run(self, func: Callable, *args):
        queued_at = time.monotonic()
        async with self._state_lock:
            if self._run_lock.locked() and self._waiting >= self.max_queued:
                raise QueueFullError()
            if self._run_lock.locked():
                self._waiting += 1
        try:
            try:
                await asyncio.wait_for(self._run_lock.acquire(), timeout=self.wait_timeout)
            except TimeoutError as exc:
                raise QueueTimeoutError() from exc
        finally:
            async with self._state_lock:
                if self._waiting > 0:
                    self._waiting -= 1
        queue_wait = time.monotonic() - queued_at

        async def execute_and_release():
            try:
                return await asyncio.wait_for(asyncio.to_thread(func, *args, queue_wait), timeout=self.processing_timeout)
            finally:
                self._run_lock.release()

        task = asyncio.create_task(execute_and_release())
        self._background.add(task)
        task.add_done_callback(self._background.discard)
        # Shield keeps native embedding/clustering work alive if the HTTP client disconnects.
        return await asyncio.shield(task)

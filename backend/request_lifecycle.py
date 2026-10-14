"""Event-driven HTTP cancellation, with no model or device dependencies."""
import asyncio
from contextlib import suppress


async def wait_native_request(task, receive, cancelled):
    """Call only after consuming the request body; never cancel native work.

    ASGI receive blocks until a message arrives. The caller retains its model
    lock and drains the native task if this coroutine is cancelled or fails.
    """
    async def watch_disconnect():
        while True:
            message = await receive()
            if message['type'] == 'http.disconnect':
                cancelled.set()
                return

    watcher = asyncio.create_task(watch_disconnect())
    try:
        done, _ = await asyncio.wait([task, watcher], return_when=asyncio.FIRST_COMPLETED)
        if task not in done:
            # Propagate channel failures to the caller's existing error handling.
            await watcher
        return await asyncio.shield(task)
    finally:
        watcher.cancel()
        with suppress(asyncio.CancelledError):
            await watcher

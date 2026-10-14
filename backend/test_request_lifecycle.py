"""No models, devices, HTTP server or third-party modules are loaded."""
import asyncio
import threading
import unittest
from unittest.mock import patch
from backend.request_lifecycle import wait_native_request


class Channel:
    def __init__(self):
        self.messages = asyncio.Queue()
        self.reads = 0
        self.stopped = asyncio.Event()

    async def receive(self):
        self.reads += 1
        try:
            return await self.messages.get()
        except asyncio.CancelledError:
            self.stopped.set()
            raise


class RequestLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_pending_work_has_one_blocking_receive_and_no_timeout_poll(self):
        channel = Channel()
        completed = asyncio.Event()
        cancelled = threading.Event()

        async def work():
            await completed.wait()
            return {'latex': 'x+y'}

        task = asyncio.create_task(work())
        original_wait = asyncio.wait
        waits = []

        async def observed_wait(*args, **kwargs):
            waits.append(kwargs)
            return await original_wait(*args, **kwargs)

        with patch('backend.request_lifecycle.asyncio.wait', observed_wait):
            request = asyncio.create_task(wait_native_request(task, channel.receive, cancelled))
            for _ in range(20):
                await asyncio.sleep(0)
            self.assertEqual(channel.reads, 1)
            self.assertEqual(len(waits), 1)
            self.assertNotIn('timeout', waits[0])
            self.assertFalse(request.done())
            self.assertFalse(cancelled.is_set())
            completed.set()
            self.assertEqual(await request, {'latex': 'x+y'})
        self.assertTrue(channel.stopped.is_set())

    async def test_disconnect_sets_cooperative_cancel_and_waits_for_work(self):
        channel = Channel()
        completed = asyncio.Event()
        cancelled = threading.Event()

        async def work():
            await completed.wait()
            raise InterruptedError('cancelled by model')

        task = asyncio.create_task(work())
        request = asyncio.create_task(wait_native_request(task, channel.receive, cancelled))
        channel.messages.put_nowait({'type': 'http.disconnect'})
        for _ in range(10):
            await asyncio.sleep(0)
        self.assertTrue(cancelled.is_set())
        self.assertFalse(task.done())
        self.assertFalse(request.done())
        self.assertEqual(channel.reads, 1)
        completed.set()
        with self.assertRaisesRegex(InterruptedError, 'cancelled by model'):
            await request

    async def test_http_task_cancellation_does_not_cancel_native_task(self):
        channel = Channel()
        completed = asyncio.Event()
        cancelled = threading.Event()

        async def work():
            await completed.wait()
            return 'finished'

        task = asyncio.create_task(work())
        request = asyncio.create_task(wait_native_request(task, channel.receive, cancelled))
        for _ in range(5):
            await asyncio.sleep(0)
        request.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await request
        self.assertFalse(task.cancelled())
        self.assertFalse(task.done())
        self.assertTrue(channel.stopped.is_set())
        # The service's finally block is responsible for setting cancellation
        # and retaining its lock while this still-running task finishes.
        cancelled.set()
        completed.set()
        self.assertEqual(await task, 'finished')

    async def test_native_failure_is_preserved_and_watcher_is_removed(self):
        channel = Channel()
        completed = asyncio.Event()

        async def work():
            await completed.wait()
            raise ValueError('empty drawing')

        task = asyncio.create_task(work())
        request = asyncio.create_task(wait_native_request(task, channel.receive, threading.Event()))
        for _ in range(5):
            await asyncio.sleep(0)
        completed.set()
        with self.assertRaisesRegex(ValueError, 'empty drawing'):
            await request
        self.assertTrue(channel.stopped.is_set())

    async def test_channel_failure_is_propagated_without_abandoning_native_work(self):
        completed = asyncio.Event()

        async def receive():
            raise OSError('connection failure')

        task = asyncio.create_task(completed.wait())
        with self.assertRaisesRegex(OSError, 'connection failure'):
            await wait_native_request(task, receive, threading.Event())
        self.assertFalse(task.done())
        completed.set()
        await task

    async def test_remaining_protocol_message_is_consumed_before_disconnect(self):
        channel = Channel()
        cancelled = threading.Event()
        completed = asyncio.Event()
        task = asyncio.create_task(completed.wait())
        request = asyncio.create_task(wait_native_request(task, channel.receive, cancelled))
        channel.messages.put_nowait({'type': 'http.request', 'body': b'', 'more_body': False})
        channel.messages.put_nowait({'type': 'http.disconnect'})
        for _ in range(10):
            await asyncio.sleep(0)
        self.assertEqual(channel.reads, 2)
        self.assertTrue(cancelled.is_set())
        completed.set()
        await request


if __name__ == '__main__':
    unittest.main()

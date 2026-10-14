import queue
import threading
import time
import unittest
from asr_lifecycle import Session, SessionLifecycle


class ObservedQueue(queue.Queue):
    def __init__(self):
        super().__init__()
        self.timeouts = []

    def get(self, block=True, timeout=None):
        self.timeouts.append(timeout)
        return super().get(block, timeout)


class LifecycleTests(unittest.TestCase):
    def test_busy_session_waits_for_finish_notification_and_idle_starts_after_work(self):
        commands = ObservedQueue()
        commands.put({'action': 'start', 'language': 'en-US'})
        completed = []
        def start(command):
            session = Session(threading.Event(), threading.Event(), time.monotonic())
            def finish():
                time.sleep(.12)  # Longer than the idle interval: busy work must survive.
                session.done.set()
                completed.append(time.monotonic())
                commands.put({'action': 'session-finished'})
            threading.Thread(target=finish).start()
            return session
        loop = SessionLifecycle(commands, start, idle_seconds=.05)
        loop.run()
        self.assertEqual(len(commands.timeouts), 3)  # start, completion, idle deadline.
        self.assertGreater(commands.timeouts[1], 119)
        self.assertGreaterEqual(time.monotonic() - completed[0], .045)
        self.assertIsNone(loop.current)

    def test_done_racing_with_stop_refreshes_idle_origin(self):
        now = [0.0]
        session = Session(threading.Event(), threading.Event(), 0)
        class RaceQueue:
            def get(self, timeout):
                now[0] = 100
                session.done.set()
                return {'action': 'stop'}
        loop = SessionLifecycle(RaceQueue(), lambda command: None, idle_seconds=30, clock=lambda: now[0])
        loop.current = session
        # Exit immediately after the raced command, recording the next idle wait.
        original = loop.commands.get
        timeouts = []
        def get(timeout):
            timeouts.append(timeout)
            if len(timeouts) == 1:
                return original(timeout)
            return {'action': 'quit'}
        loop.commands.get = get
        loop.run()
        self.assertEqual(timeouts[1], 30)
        self.assertEqual(loop.last_used, 100)

    def test_active_deadline_stops_once_then_waits_for_completion_without_polling(self):
        commands = ObservedQueue()
        session = Session(threading.Event(), threading.Event(), time.monotonic())
        loop = SessionLifecycle(commands, lambda command: None, session_seconds=.02)
        loop.current = session
        runner = threading.Thread(target=loop.run)
        runner.start()
        self.assertTrue(session.stop.wait(1))
        commands.put({'action': 'quit'})
        runner.join(timeout=1)
        self.assertFalse(runner.is_alive())
        self.assertEqual(len(commands.timeouts), 2)
        self.assertIsNone(commands.timeouts[1])

    def test_stop_and_policy_commands_wake_busy_work_without_unloading_it(self):
        commands = ObservedQueue()
        session = Session(threading.Event(), threading.Event(), time.monotonic())
        loop = SessionLifecycle(commands, lambda command: None)
        loop.current = session
        initial_idle_origin = loop.last_used
        for command in [{'action': 'idle-policy', 'idleReleaseSeconds': 60},
                        {'action': 'stop'}, {'action': 'session-finished'}, {'action': 'quit'}]:
            commands.put(command)
        loop.run()
        self.assertTrue(session.stop.is_set())
        self.assertIs(loop.current, session)
        self.assertEqual(loop.idle_seconds, 60)
        self.assertEqual(loop.last_used, initial_idle_origin)
        self.assertEqual(commands.timeouts[2:], [None, None])


if __name__ == '__main__':
    unittest.main()

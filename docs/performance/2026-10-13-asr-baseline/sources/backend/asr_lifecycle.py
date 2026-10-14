"""Event-driven ASR session/idle deadlines; no model or microphone imports."""
from dataclasses import dataclass
import queue
import time


@dataclass
class Session:
    stop: object
    done: object
    started: float


class SessionLifecycle:
    def __init__(self, commands, start_session, idle_seconds=1800, session_seconds=120,
                 clock=time.monotonic):
        self.commands = commands
        self.start_session = start_session
        self.idle_seconds = idle_seconds
        self.session_seconds = session_seconds
        self.clock = clock
        self.current = None
        self.last_used = clock()

    def settle(self):
        # Completion can race with any command, including stop/policy changes.
        # Every path must reset the idle origin to the actual end of work.
        if self.current and self.current.done.is_set():
            self.current = None
            self.last_used = self.clock()

    def run(self):
        while True:
            self.settle()
            now = self.clock()
            if self.current:
                if self.current.stop.is_set():
                    timeout = None  # Await completion or a command, without polling.
                else:
                    timeout = max(0, self.session_seconds - (now - self.current.started))
            else:
                timeout = self.idle_seconds - (now - self.last_used)
                if timeout <= 0:
                    return
            try:
                command = self.commands.get(timeout=timeout)
            except queue.Empty:
                if self.current:
                    self.current.stop.set()  # Single active-session deadline.
                continue
            self.settle()
            action = command.get('action')
            if action == 'idle-policy':
                value = command.get('idleReleaseSeconds')
                if type(value) is int and 30 <= value <= 86400:
                    self.idle_seconds = value
            elif action == 'quit':
                return
            elif action == 'stop' and self.current:
                self.current.stop.set()
            elif action == 'start' and not self.current and command.get('language') in ['zh-CN', 'en-US']:
                self.current = self.start_session(command)
            # session-finished only wakes this loop. The actual done event,
            # never a caller-supplied ID, establishes which session completed.

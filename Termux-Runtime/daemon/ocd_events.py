"""Thread-safe bounded event log; no daemon dependencies."""
import collections
import threading
import time

# ------------------------------------------------------------------ event log
class EventLog:
    """Ordered, size-capped event log with cursor + long-poll reads."""

    def __init__(self, cap_bytes=4 * 1024 * 1024):
        self.cv = threading.Condition()
        self.items = collections.deque()
        self.sizes = collections.deque()
        self.seq = 0
        self.total = 0
        self.cap = cap_bytes

    def append(self, type_, **fields):
        with self.cv:
            self.seq += 1
            ev = {"seq": self.seq, "t": round(time.time(), 3), "type": type_}
            ev.update(fields)
            sz = 96 + len(fields.get("data", ""))
            self.items.append(ev)
            self.sizes.append(sz)
            self.total += sz
            while self.total > self.cap and len(self.items) > 1:
                self.items.popleft()
                self.total -= self.sizes.popleft()
            self.cv.notify_all()
            return ev

    def read(self, since=0, wait_ms=0, limit=2000):
        deadline = time.time() + wait_ms / 1000.0
        with self.cv:
            while self.seq <= since:
                left = deadline - time.time()
                if left <= 0:
                    break
                self.cv.wait(left)
            first = self.items[0]["seq"] if self.items else self.seq + 1
            truncated = since + 1 < first and self.seq > since
            start = max(0, since + 1 - first)
            evs = [self.items[i] for i in range(start, min(len(self.items), start + limit))]
            nxt = evs[-1]["seq"] if evs else max(since, self.seq if not self.items else since)
            if not evs and self.seq > since:
                nxt = self.seq
            return {"events": evs, "next": nxt, "truncated": truncated, "latest": self.seq}



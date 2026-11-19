"""How busy this machine is: memory in use and CPU over the last minute, read from Linux's /proc.

The sidebar asks every so often and shows a warning only while either one is high. On a system
without /proc (macOS, Windows) there's nothing to read and the portal shows nothing.
"""

import time
from collections import deque
from pathlib import Path

# Above this share (percent) of memory or CPU, the app warns.
WARN_AT = 75
# CPU is averaged over this many seconds, so a short build spike doesn't raise the warning.
WINDOW = 60.0


class MachineLoad:
    def __init__(self, proc="/proc", *, clock=time.monotonic, window=WINDOW):
        self.proc = Path(proc)
        self.clock = clock
        self.window = window
        # (time, busy jiffies, total jiffies) from /proc/stat, oldest first.
        self.samples = deque()
        if self.available:
            # A starting point, so the first reading already has a CPU share.
            self.samples.append((clock(), *self._cpu_counters()))

    @property
    def available(self):
        return (self.proc / "meminfo").is_file() and (self.proc / "stat").is_file()

    def _memory(self):
        info = {}
        for line in (self.proc / "meminfo").read_text().splitlines():
            key, _, rest = line.partition(":")
            parts = rest.split()
            if parts:
                info[key] = int(parts[0]) * 1024
        total = info["MemTotal"]
        # Used means what programs hold: total minus what the kernel could hand out now (cache included).
        used = total - info.get("MemAvailable", info.get("MemFree", 0))
        return {"used": used, "total": total, "percent": round(100 * used / total) if total else 0}

    def _cpu_counters(self):
        for line in (self.proc / "stat").read_text().splitlines():
            if line.startswith("cpu "):
                values = [int(v) for v in line.split()[1:]]
                idle = values[3] + (values[4] if len(values) > 4 else 0)  # idle + iowait
                total = sum(values[:8])  # guest time is already counted in user/nice
                return total - idle, total
        raise ValueError("no cpu line in /proc/stat")

    def read(self):
        """Memory now, and CPU busy share since the oldest sample within the window."""
        now = self.clock()
        busy, total = self._cpu_counters()
        self.samples.append((now, busy, total))
        # Keep one sample at or before the window's start, so the average spans the full minute (longer
        # after a quiet spell with nobody asking).
        while len(self.samples) > 2 and self.samples[1][0] <= now - self.window:
            self.samples.popleft()
        _, busy0, total0 = self.samples[0]
        spent = total - total0
        cpu = round(100 * (busy - busy0) / spent) if spent > 0 else None
        return {"memory": self._memory(), "cpu": {"percent": cpu}, "warn_at": WARN_AT}

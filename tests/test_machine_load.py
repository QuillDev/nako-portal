"""Machine load: memory and CPU use for the sidebar's high-load warning, read from /proc."""

from __future__ import annotations

import pytest
from portal.machine_load import MachineLoad

GIB = 1024**3


class FakeProc:
    """A /proc with just meminfo and stat, and a clock the test moves."""

    def __init__(self, path):
        self.path = path
        self.now = 1000.0
        self.busy = 0
        self.idle = 0
        path.mkdir()
        self.memory(total_gib=128, available_gib=32)
        self.cpu(busy=0, idle=0)

    def memory(self, *, total_gib, available_gib):
        kb = lambda gib: int(gib * GIB / 1024)  # noqa: E731
        (self.path / "meminfo").write_text(
            f"MemTotal:       {kb(total_gib)} kB\nMemFree:         {kb(1)} kB\nMemAvailable:   {kb(available_gib)} kB\n"
        )

    def cpu(self, *, busy, idle):
        """Add `busy` and `idle` jiffies to the counters."""
        self.busy += busy
        self.idle += idle
        user, system = self.busy // 2, self.busy - self.busy // 2
        (self.path / "stat").write_text(f"cpu  {user} 0 {system} {self.idle} 0 0 0 0 0 0\ncpu0 1 2 3 4\n")

    def load(self):
        return MachineLoad(self.path, clock=lambda: self.now)


@pytest.fixture
def proc(tmp_path):
    return FakeProc(tmp_path / "proc")


def test_memory_in_use_leaves_out_what_the_kernel_can_reclaim(proc):
    proc.memory(total_gib=125, available_gib=26)
    memory = proc.load().read()["memory"]
    assert memory == {"used": 99 * GIB, "total": 125 * GIB, "percent": 79}


def test_cpu_is_the_busy_share_over_the_last_minute(proc):
    load = proc.load()
    # A busy burst, then a calm minute: only the last minute counts.
    proc.now += 30
    proc.cpu(busy=900, idle=100)
    load.read()
    proc.now += 60
    proc.cpu(busy=250, idle=750)
    load.read()
    proc.now += 5
    proc.cpu(busy=0, idle=0)
    assert load.read()["cpu"]["percent"] == 25


def test_the_first_reading_already_has_a_cpu_share(proc):
    load = proc.load()
    proc.now += 2
    proc.cpu(busy=60, idle=40)
    assert load.read()["cpu"]["percent"] == 60


def test_no_proc_means_nothing_to_read(tmp_path):
    assert MachineLoad(tmp_path / "missing").available is False



@pytest.mark.asyncio
async def test_the_app_reads_it_signed_in_only(world, proc):
    world.portal.machine_load = proc.load()
    response = await world.http.get(world.url("/api/machine-load"))
    assert response.status == 401
    await world.sign_up()
    me = await (await world.http.get(world.url("/api/me"))).json()
    assert me["machine_load"] is True
    body = await (await world.http.get(world.url("/api/machine-load"))).json()
    assert body["memory"]["percent"] == 75
    assert body["warn_at"] == 75


@pytest.mark.asyncio
async def test_where_nothing_can_be_read_the_app_hears_so(world):
    await world.sign_up()
    me = await (await world.http.get(world.url("/api/me"))).json()
    assert me["machine_load"] is False
    assert (await world.http.get(world.url("/api/machine-load"))).status == 404

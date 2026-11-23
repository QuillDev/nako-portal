"""Owner-initiated local restart. The portal, not a chat turn, owns the durable plan."""
import asyncio
import time
from contextlib import suppress


class RestartPanel:
    def __init__(self, portal):
        self.portal = portal
        self.lock = asyncio.Lock()

    def plan(self):
        return self.portal.store.meta('gateway_restart_plan', {'phase': 'idle', 'threads': {}})

    def save(self, plan):
        self.portal.store.set_meta('gateway_restart_plan', plan)

    async def lifecycle(self, app):
        task = asyncio.create_task(self.watch())
        try:
            yield
        finally:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task

    async def snapshot(self):
        if not self.portal.hub.connected:
            return None
        return await self.portal.hub.backend.restart_work()

    async def request(self, body):
        async with self.lock:
            plan = self.plan()
            live = await self.snapshot()
            if body is not None:
                if not isinstance(body, dict):
                    raise ValueError('Invalid action')
                action = body.get('action')
                if action == 'start' and plan['phase'] in ('idle', 'done', 'failed') and live:
                    if self.portal.ops.running():
                        raise ValueError('Another machine job is running')
                    plan = {'phase': 'waiting', 'instance': live['instance'], 'threads': {}}
                elif action == 'cancel' and plan['phase'] == 'waiting' and not plan['threads']:
                    plan = {'phase': 'idle', 'threads': {}}
                elif action in ('pause', 'pause-all') and plan['phase'] == 'waiting' and live:
                    rows = [r for r in live['work'] if r.get('turn') and
                            (action == 'pause-all' or r['turn'] == body.get('turn'))]
                    if not rows:
                        raise ValueError('That turn is no longer active')
                    for row in rows:
                        if row['turn'] in plan['threads']:
                            continue
                        record = {**row, 'status': 'Needs review'}
                        plan['threads'][row['turn']] = record
                        self.save(plan)
                        record['status'] = await self.portal.hub.backend.restart_thread(row, False)
                        self.save(plan)
                    live = await self.snapshot()
                else:
                    raise ValueError('This restart action is no longer available')
                self.save(plan)
            return {**plan, 'online': live is not None, 'work': live['work'] if live else []}

    async def tick(self):
        async with self.lock:
            plan = self.plan()
            phase = plan['phase']
            if phase not in ('waiting', 'restarting', 'resuming'):
                return
            live = await self.snapshot()
            if phase == 'waiting' and live and live['instance'] == plan['instance'] and not live['work']:
                # Persist intent before launch: never restart a second time after a lost reply.
                plan.update(phase='restarting', started=time.time())
                self.save(plan)
                await self.portal.ops.start('restart')
                return
            if live and live['instance'] != plan['instance']:
                for record in plan['threads'].values():
                    if record['status'] == 'Resume queued':
                        record['status'] = await self.portal.hub.backend.restart_thread(record, 'check')
                        self.save(plan)
                        continue
                    if record['status'] != 'Pause requested':
                        continue
                    # A lost acknowledgement is not permission to resend.
                    record['status'] = 'Needs review'
                    self.save(plan)
                    record['status'] = await self.portal.hub.backend.restart_thread(record, True)
                    self.save(plan)
                plan['phase'] = 'resuming' if any(r['status'] == 'Resume queued' for r in plan['threads'].values()) else 'done'
                self.save(plan)
            elif phase == 'restarting' and time.time() - plan['started'] > 300:
                plan.update(phase='failed', error='A new gateway did not reconnect within five minutes. Check the gateway before retrying.')
                self.save(plan)

    async def watch(self):
        while True:
            await asyncio.sleep(1)
            try:
                await self.tick()
            except ConnectionError:
                continue
            except Exception as exc:  # noqa: BLE001 - Record job failures without stopping the watchdog.
                plan = self.plan()
                plan.update(phase='failed', error=str(exc))
                self.save(plan)

from types import SimpleNamespace


async def test_owner_can_pause_one_thread_and_resume_it_only_after_gateway_replacement(world):
    a = {'title': 'Release', 'session': 'one', 'turn': 'alpha'}
    b = {'title': 'Invoices', 'session': 'two', 'turn': 'beta'}
    live = world.hermes.restart_snapshot
    live['work'] = [a, b]
    jobs = []
    async def start(kind):
        jobs.append(kind)
    world.portal.ops = SimpleNamespace(start=start, running=lambda: False, gateway_changed=lambda _: None)
    endpoint = '/api/gateway/restart'
    async def post(action, **body):
        return await world.post(endpoint, dict(action=action, **body))
    assert (await post('start')).status == 401
    await world.sign_up()
    assert (await (await post('start')).json())['phase'] == 'waiting'
    assert (await (await post('cancel')).json())['phase'] == 'idle'
    await post('start')
    assert (await (await post('pause', turn='alpha')).json())['work'] == [b]
    await world.portal.restart_panel.tick()
    assert not jobs
    live['work'].clear()
    await world.portal.restart_panel.tick()
    assert jobs == ['restart']
    await world.portal.restart_panel.tick()
    assert ('resumed', 'one') not in world.hermes.received
    live['instance'] = 'second'
    await world.portal.restart_panel.tick()
    await world.portal.restart_panel.tick()
    result = await (await world.http.get(world.url(endpoint))).json()
    assert result['phase'] == 'done'
    assert result['threads']['alpha']['status'] == 'Resumed'
    assert [r for r in world.hermes.received if r[0] == 'resumed'] == [('resumed', 'one')]


async def test_restart_panel_rejects_invalid_actions_and_busy_jobs(world):
    a = {'title': 'Release', 'session': 'one', 'turn': 'alpha'}
    b = {'title': 'Invoices', 'session': 'two', 'turn': 'beta'}
    world.hermes.restart_snapshot['work'] = [a, b]
    busy = {'running': True}
    world.portal.ops = SimpleNamespace(start=lambda kind: None, running=lambda: busy['running'], gateway_changed=lambda _: None)
    await world.sign_up()

    # Cannot start while another machine job is running.
    assert (await world.post('/api/gateway/restart', {'action': 'start'})).status == 400
    busy['running'] = False
    assert (await world.post('/api/gateway/restart', {'action': 'start'})).status == 200

    # Unknown turn and unknown action are refused.
    assert (await world.post('/api/gateway/restart', {'action': 'pause', 'turn': 'missing'})).status == 400
    assert (await world.post('/api/gateway/restart', {'action': 'bogus'})).status == 400

    # pause-all pauses every active turn and blocks cancel afterwards.
    paused = await (await world.post('/api/gateway/restart', {'action': 'pause-all'})).json()
    assert set(paused['threads']) == {'alpha', 'beta'}
    assert paused['work'] == []
    assert (await world.post('/api/gateway/restart', {'action': 'cancel'})).status == 400


async def test_restart_panel_times_out_if_gateway_never_replaces(world, monkeypatch):
    import time as time_mod

    now = [1000.0]
    monkeypatch.setattr(time_mod, 'time', lambda: now[0])
    world.hermes.restart_snapshot['work'] = []
    jobs = []

    async def start(kind):
        jobs.append(kind)

    world.portal.ops = SimpleNamespace(start=start, running=lambda: False, gateway_changed=lambda _: None)
    await world.sign_up()
    assert (await world.post('/api/gateway/restart', {'action': 'start'})).status == 200

    await world.portal.restart_panel.tick()
    assert jobs == ['restart']
    assert (await (await world.http.get(world.url('/api/gateway/restart'))).json())['phase'] == 'restarting'

    # Still within the 5-minute window: remains restarting.
    now[0] += 250.0
    await world.portal.restart_panel.tick()
    assert (await (await world.http.get(world.url('/api/gateway/restart'))).json())['phase'] == 'restarting'

    # Past 5 minutes without a new instance: fails with a clear message.
    now[0] += 60.0
    await world.portal.restart_panel.tick()
    state = await (await world.http.get(world.url('/api/gateway/restart'))).json()
    assert state['phase'] == 'failed'
    assert 'five minutes' in state['error']


async def test_restart_panel_polls_queued_resumes_until_done(world):
    world.hermes.restart_snapshot['work'] = [{'title': 'Release', 'session': 'one', 'turn': 'alpha'}]
    jobs = []
    checks = []

    async def start(kind):
        jobs.append(kind)

    async def restart_thread(row, resume):
        if resume is False:
            world.hermes.restart_snapshot['work'] = []
            return 'Pause requested'
        if resume is True:
            return 'Resume queued'
        checks.append(row['turn'])
        return 'Resume queued' if len(checks) == 1 else 'Resumed'

    world.hermes.restart_thread = restart_thread
    await world.gateway.stop(world.hub)
    await world.gateway.start(world.hub)
    world.portal.ops = SimpleNamespace(start=start, running=lambda: False, gateway_changed=lambda _: None)
    await world.sign_up()
    await world.post('/api/gateway/restart', {'action': 'start'})
    await world.post('/api/gateway/restart', {'action': 'pause', 'turn': 'alpha'})
    await world.portal.restart_panel.tick()
    assert jobs == ['restart']

    world.hermes.restart_snapshot['instance'] = 'second'
    await world.portal.restart_panel.tick()
    state = await (await world.http.get(world.url('/api/gateway/restart'))).json()
    assert state['phase'] == 'resuming'
    assert state['threads']['alpha']['status'] == 'Resume queued'

    await world.portal.restart_panel.tick()
    state = await (await world.http.get(world.url('/api/gateway/restart'))).json()
    assert state['phase'] == 'resuming'

    await world.portal.restart_panel.tick()
    state = await (await world.http.get(world.url('/api/gateway/restart'))).json()
    assert state['phase'] == 'done'
    assert state['threads']['alpha']['status'] == 'Resumed'
    assert checks == ['alpha', 'alpha']


async def test_restart_panel_waits_when_gateway_is_offline(world):
    world.hermes.restart_snapshot['work'] = [{'title': 'Release', 'session': 'one', 'turn': 'alpha'}]
    jobs = []

    async def start(kind):
        jobs.append(kind)

    world.portal.ops = SimpleNamespace(start=start, running=lambda: False, gateway_changed=lambda _: None)
    await world.sign_up()
    await world.post('/api/gateway/restart', {'action': 'start'})
    await world.gateway.stop(world.hub)
    await world.portal.restart_panel.tick()
    assert jobs == []
    state = await (await world.http.get(world.url('/api/gateway/restart'))).json()
    assert state['phase'] == 'waiting' and state['online'] is False

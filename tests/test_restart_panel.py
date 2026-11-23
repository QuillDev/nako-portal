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

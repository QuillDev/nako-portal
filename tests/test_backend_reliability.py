"""Regressions for backend revocation, replay and event-loop responsiveness."""
import asyncio
import base64
import contextlib
import contextvars
import hashlib
import importlib.util
import json
import sqlite3
import sys
import threading
import types
from pathlib import Path

import aiohttp
import pytest
from conftest import ORIGIN, ROOT, next_message, until
from portal import hub as hub_module
from portal.hub import Hub
from portal.mesh import MIRROR_STATE, mirror_skills, read_skill_files, skill_manifest
from portal.offline import Offline
from portal.store import LOGIN_RENEW_INTERVAL, LOGIN_TTL, Store


def load_plugin():
    spec = importlib.util.spec_from_file_location("backend_reliability_plugin", ROOT / "__init__.py")
    plugin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(plugin)
    return plugin


@pytest.mark.parametrize("missing", [True, False])
def test_removing_a_provider_key_only_ignores_missing_files(tmp_path, monkeypatch, missing):
    plugin = load_plugin()
    config = types.ModuleType("hermes_cli.config")
    config.remove_env_value = lambda name: None
    monkeypatch.setitem(sys.modules, "hermes_cli.config", config)

    def remove(*args, **kwargs):
        if missing:
            raise FileNotFoundError("no .env")
        raise PermissionError("read-only .env")

    backend = types.SimpleNamespace(
        _home=lambda: tmp_path,
        _provider_for_key=lambda slug, **kwargs: {"env_vars": ["API_KEY"]},
        _scoped=remove,
    )
    with contextlib.nullcontext() if missing else pytest.raises(PermissionError, match="read-only"):
        plugin.HermesBackend.remove_provider_key(backend, "example")


async def test_unsupported_account_removal_remains_a_validation_error(world, monkeypatch):
    spec = importlib.util.spec_from_file_location("account_removal_test", ROOT / "provider_accounts.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    accounts = module.PluginAccounts(types.SimpleNamespace())
    await world.gateway.stop(world.hub)
    monkeypatch.setattr(world.hermes, "remove_account", lambda slug, account: accounts.remove(account))
    await world.gateway.start(world.hub)

    await world.sign_up()
    response = await world.post("/api/providers/example/accounts/account/remove")
    assert response.status == 400
    assert await response.json() == {"error": "That provider can't remove accounts here"}


async def socket_ready(http, world, **kwargs):
    ws = await http.ws_connect(world.url('/ws'), headers={'Origin': ORIGIN}, **kwargs)
    await next_message(ws, lambda frame: frame.get('kind') == 'status.synced')
    return ws


async def closed(ws):
    async def receive_close():
        while (await ws.receive()).type == aiohttp.WSMsgType.TEXT:
            pass
        assert ws.closed
    await asyncio.wait_for(receive_close(), 2)


async def test_logout_closes_all_sockets_of_only_that_login(world):
    credential = await world.sign_up()
    sockets = [await socket_ready(world.http, world) for _ in range(2)]
    other_token = world.store.start_login(credential.credential_id)
    async with aiohttp.ClientSession(cookies={'portal': other_token}) as other:
        survivor = await socket_ready(other, world)
        for ws in sockets:
            await ws.send_json({'watch': 'private-chat'})
        response = await world.post('/api/logout')
        assert response.status == 200
        await asyncio.gather(*(closed(ws) for ws in sockets))
        await survivor.send_json({'watch': 'another-chat'})
        await until(lambda: bool(world.hub.subscribers.get('another-chat')))
        await world.hub._publish('another-chat', {'kind': 'event', 'type': 'gateway.message', 'payload': {'text': 'still authorized'}})
        assert (await next_message(survivor, lambda m: m.get('type') == 'gateway.message'))['payload']['text'] == 'still authorized'
        assert 'private-chat' not in world.hub.subscribers
        await survivor.close()


async def test_passkey_removal_closes_every_login_for_the_key(world):
    removed = await world.sign_up()
    sockets = [await socket_ready(world.http, world)]
    token = world.store.start_login(removed.credential_id)
    async with aiohttp.ClientSession(cookies={'portal': token}) as other:
        sockets.append(await socket_ready(other, world))
        await world.sign_up()  # a different passkey authorizes deleting the first one
        survivor = await socket_ready(world.http, world)
        from portal.webauthn import b64url
        response = await world.post('/api/passkeys/' + b64url(removed.credential_id) + '/remove')
        assert response.status == 200
        await asyncio.gather(*(closed(ws) for ws in sockets))
        await world.hub.broadcast({'kind': 'still.connected'})
        await next_message(survivor, lambda m: m.get('kind') == 'still.connected')
        assert world.store.login(token) is None
        await survivor.close()


@pytest.mark.parametrize('cursor', [None, 0, 17])
async def test_replay_drains_more_than_fifty_rows_in_order(tmp_path, monkeypatch, cursor):
    plugin = load_plugin()
    monkeypatch.setattr(plugin, 'INBOX_POLL', 0.001)
    store = Store(tmp_path / 'portal.db')
    for i in range(123):
        store.deliver('inbox', str(i + 1))
    if cursor is not None:
        store.set_meta('inbox_pushed', cursor)
    sent = []

    class Adapter:
        async def send(self, chat, text):
            sent.append((chat, int(text)))

    task = asyncio.create_task(plugin._forward_inbox(store, Adapter()))
    try:
        await until(lambda: store.meta('inbox_pushed') == 123)
        assert sent == [('inbox', i) for i in range((cursor or 0) + 1, 124)]
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def test_replay_saves_each_success_before_a_delivery_failure(tmp_path, monkeypatch):
    plugin = load_plugin()
    monkeypatch.setattr(plugin, 'INBOX_POLL', 0)
    store = Store(tmp_path / 'portal.db')
    store.deliver('inbox', 'first')
    store.deliver('inbox', 'second')

    class Adapter:
        async def send(self, chat, text):
            if text == 'second':
                raise ConnectionError('gateway left')

    with pytest.raises(ConnectionError):
        await plugin._forward_inbox(store, Adapter())
    assert store.meta('inbox_pushed') == 1
    assert [r['text'] for r in store.inbox_after(1)] == ['second']


def test_login_reads_do_not_write_on_every_request_but_renew_and_revoke(tmp_path):
    now = [100.0]
    store = Store(tmp_path / 'portal.db', clock=lambda: now[0])
    store.add_credential(b'one', b'key', 0, 'one')
    token = store.start_login(b'one')
    before = store.db.total_changes
    for tick in range(100):
        now[0] = 100 + tick
        assert store.login(token) == b'one'
    assert store.db.total_changes == before
    now[0] = 100 + LOGIN_RENEW_INTERVAL
    assert store.login(token) == b'one'
    assert store.db.total_changes == before + 1
    now[0] += LOGIN_TTL - 1
    assert store.login(token) == b'one'
    store.remove_credential(b'one')
    assert store.login(token) is None


async def test_slow_subscriber_does_not_delay_fast_one_and_is_removed(monkeypatch):
    monkeypatch.setattr(hub_module, 'SEND_TIMEOUT', 0.1)
    hub = Hub(None)
    delivered = asyncio.Event()

    class Slow:
        async def send(self, frame):
            await asyncio.Event().wait()

    class Fast:
        async def send(self, frame):
            delivered.set()

    slow, fast = Slow(), Fast()
    for client in (slow, fast):
        hub.join(client)
        hub.watch(client, 'chat')
    task = asyncio.create_task(hub._send([slow, fast], {'kind': 'test'}))
    await asyncio.wait_for(delivered.wait(), 0.05)
    await task
    assert slow not in hub.clients
    assert hub.subscribers['chat'] == {fast}
    hub.leave(fast)
    assert hub.subscribers == {}


async def test_broadcast_concurrency_is_bounded():
    hub = Hub(None)
    active = peak = 0
    delivered = []

    class Client:
        async def send(self, frame):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(0.001)
            delivered.append(frame)
            active -= 1

    for _ in range(hub_module.SEND_CONCURRENCY * 3):
        hub.join(Client())
    await hub.broadcast({'kind': 'test'})
    assert len(delivered) == hub_module.SEND_CONCURRENCY * 3
    assert 1 < peak <= hub_module.SEND_CONCURRENCY


async def test_offline_http_read_reaches_disk_and_clears_live_progress(world, tmp_path):
    home = tmp_path / 'home'
    home.mkdir()
    with sqlite3.connect(home / 'state.db') as db:
        db.executescript("CREATE TABLE sessions (id TEXT, source TEXT, chat_id TEXT, title TEXT, parent_session_id TEXT);"
                         "CREATE TABLE messages (id INTEGER, session_id TEXT, role TEXT, content TEXT, timestamp REAL, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT);")
        db.execute("INSERT INTO sessions VALUES ('saved', 'portal', 'chat-saved', 'Saved chat', NULL)")
        db.execute("INSERT INTO messages VALUES (1, 'saved', 'assistant', 'Available offline', 123, NULL, NULL, NULL)")
    world.link.offline = Offline(home, projection=False)
    await world.sign_up()
    world.hub.running.add('saved')
    world.hub.progress['saved'] = {'text': 'stale'}
    await world.gateway.stop(world.hub)
    response = await world.http.get(world.url('/api/sessions/saved'))
    assert response.status == 200, await response.text()
    body = await response.json()
    assert body['gateway'] is False and body['running'] is False
    assert body['messages'][0]['text'] == 'Available offline'
    assert world.hub.progress == {}


async def test_skill_bytes_must_match_manifest_and_retry_next_sync(tmp_path):
    target = tmp_path / 'mirror'
    expected = b'correct skill'
    manifest = {'one/SKILL.md': hashlib.sha256(expected).hexdigest()}

    async def wrong(paths):
        return {paths[0]: base64.b64encode(b'changed in transit').decode()}

    assert await mirror_skills(target, manifest, wrong) == 0
    assert not (target / 'one/SKILL.md').exists()
    assert json.loads((target / MIRROR_STATE).read_text()) == {}

    async def correct(paths):
        return {paths[0]: base64.b64encode(expected).decode()}

    assert await mirror_skills(target, manifest, correct) == 1
    assert (target / 'one/SKILL.md').read_bytes() == expected
    assert json.loads((target / MIRROR_STATE).read_text()) == manifest
    assert await mirror_skills(target, manifest, wrong) == 0


def test_skill_scan_prunes_excluded_and_symlinked_trees_and_fetches_only_wanted(tmp_path, monkeypatch):
    for name in ('skill/SKILL.md', 'skill/data.txt', 'category/DESCRIPTION.md', 'excluded/SKILL.md', '.hidden/SKILL.md', 'node_modules/SKILL.md', 'not-a-skill.txt'):
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(name)
    (tmp_path / 'link').symlink_to(tmp_path / 'skill', target_is_directory=True)
    manifest = skill_manifest(tmp_path, ['excluded'])
    assert set(manifest) == {'skill/SKILL.md', 'skill/data.txt', 'category/DESCRIPTION.md'}
    # Downloading one file must not open/hash unrelated files, even a huge skill tree.
    original = Path.read_bytes

    def read(path):
        if path.name != 'data.txt':
            raise AssertionError('unrelated file read')
        return original(path)

    monkeypatch.setattr(Path, 'read_bytes', read)
    got = read_skill_files(tmp_path, ['skill/data.txt', '../escape', 'excluded/SKILL.md', 'link/SKILL.md'], ['excluded'])
    assert got == {'skill/data.txt': base64.b64encode(b'skill/data.txt').decode()}


async def test_skill_disk_writes_do_not_block_the_event_loop(tmp_path, monkeypatch):
    writing, release = threading.Event(), threading.Event()
    original = Path.write_bytes

    def slow_write(path, data):
        writing.set()
        assert release.wait(2)
        return original(path, data)

    monkeypatch.setattr(Path, 'write_bytes', slow_write)
    data = b'skill'

    async def fetch(paths):
        return {paths[0]: base64.b64encode(data).decode()}

    task = asyncio.create_task(mirror_skills(tmp_path, {'a/SKILL.md': hashlib.sha256(data).hexdigest()}, fetch))
    try:
        await until(writing.is_set)
        assert not task.done()
    finally:
        release.set()
    assert await task == 1


@pytest.mark.parametrize('operation', ['set', 'remove'])
async def test_credential_write_keeps_request_profile_during_switch(tmp_path, monkeypatch, operation):
    plugin = load_plugin()
    home = tmp_path / 'main'
    other = tmp_path / 'other'
    for path in (home, other):
        path.mkdir()
        (path / '.env').write_text('API_KEY=old\nALT_KEY=old\n')
    scope = contextvars.ContextVar('test_home')
    constants = types.ModuleType('hermes_constants')
    constants.set_hermes_home_override = scope.set
    constants.reset_hermes_home_override = scope.reset
    monkeypatch.setitem(sys.modules, 'hermes_constants', constants)
    config = types.ModuleType('hermes_cli.config')

    def save(name, value):
        path = Path(scope.get()) / '.env'
        path.write_text(path.read_text() + f'{name}={value}\n')

    def remove(name):
        path = Path(scope.get()) / '.env'
        path.write_text(''.join(line for line in path.read_text().splitlines(True) if not line.startswith(name + '=')))

    config.save_env_value, config.remove_env_value = save, remove
    monkeypatch.setitem(sys.modules, 'hermes_cli.config', config)
    validating, resume = threading.Event(), threading.Event()

    class Backend(plugin.HermesBackend):
        def homes(self):
            return {'default': home, 'other': other}

        def providers(self, *, home=None):
            assert home == tmp_path / 'main'
            validating.set()
            assert resume.wait(2)
            return [{'slug': 'example', 'kind': 'key', 'env_var': 'API_KEY', 'env_vars': ['API_KEY', 'ALT_KEY']}]

    backend = Backend(None, home)
    call = backend.set_provider_key if operation == 'set' else backend.remove_provider_key
    args = ('example', 'new') if operation == 'set' else ('example',)
    task = asyncio.create_task(asyncio.to_thread(call, *args))
    try:
        await until(validating.is_set)
        backend.profile = 'other'
    finally:
        resume.set()
    await task
    assert (other / '.env').read_text() == 'API_KEY=old\nALT_KEY=old\n'
    assert (home / '.env').read_text() == ('API_KEY=old\nALT_KEY=old\nAPI_KEY=new\n' if operation == 'set' else '')


async def test_cancel_during_token_exchange_never_persists_account(tmp_path, monkeypatch):
    monkeypatch.setitem(sys.modules, 'httpx', types.ModuleType('httpx'))
    spec = importlib.util.spec_from_file_location('provider_accounts_reliability', ROOT / 'provider_accounts.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    exchanging, release = threading.Event(), threading.Event()
    persisted = tmp_path / 'credentials.json'

    def exchange(http, code):
        exchanging.set()
        assert release.wait(2)
        return {'access_token': 'secret'}

    routes = types.SimpleNamespace(_CANCELLED=object(), _codex_poll_authorization=lambda *a: 'code', _codex_exchange_tokens=exchange)
    monkeypatch.setattr(module, '_routes', lambda: routes)

    class Accounts(module.CodexAccounts):
        def _link(self, tokens, target):
            persisted.write_text(json.dumps(tokens))
            return {'outcome': 'added'}

    accounts = Accounts()
    state = {'status': 'pending', 'cancelled': False}
    accounts._attempts['login'] = state
    task = asyncio.create_task(asyncio.to_thread(accounts._wait, 'login', state, None, contextlib.nullcontext))
    try:
        await until(exchanging.is_set)
        accounts.cancel('login')
    finally:
        release.set()
    await task
    assert not persisted.exists()
    assert state['status'] == 'cancelled'


async def test_restart_sqlite_reads_leave_event_loop_responsive(tmp_path, monkeypatch):
    plugin = load_plugin()
    with sqlite3.connect(tmp_path / 'state.db') as db:
        db.executescript("CREATE TABLE sessions (id TEXT, session_key TEXT, title TEXT, source TEXT, ended_at REAL);"
                         "CREATE TABLE session_admissions (target_session_id TEXT, admission_id TEXT, status TEXT);")
        db.execute("INSERT INTO sessions VALUES ('one', 'key-one', 'Work', 'portal', NULL)")
        db.execute("INSERT INTO session_admissions VALUES ('one', 'turn-one', 'started')")
    reading, release = threading.Event(), threading.Event()

    class Backend(plugin.HermesBackend):
        def homes(self):
            return {'default': tmp_path}

        def _read(self, *args):
            reading.set()
            assert release.wait(2)
            return super()._read(*args)

    adapter = types.SimpleNamespace(gateway_runner=types.SimpleNamespace(_describe_active_work=list))
    backend = Backend(adapter, tmp_path)
    task = asyncio.create_task(backend.restart_work())
    try:
        await until(reading.is_set)
        assert not task.done()
    finally:
        release.set()
    result = await task
    assert result['work'] == [{'session': 'one', 'key': 'key-one', 'title': 'Work', 'turn': 'turn-one', 'profile': 'default'}]


async def test_compatibility_status_identifies_standalone_server():
    pytest.importorskip('fastapi')
    from dashboard.plugin_api import status
    assert await status() == {'running': False, 'served_by': 'standalone'}


async def test_logout_also_closes_a_socket_dropped_by_the_hub(world):
    await world.sign_up()
    ws = await socket_ready(world.http, world)
    for client in list(world.hub.clients):
        world.hub.leave(client)
    assert not world.hub.clients
    assert (await world.post('/api/logout')).status == 200
    await closed(ws)


async def test_new_thread_persists_cwd_before_first_prompt(tmp_path, monkeypatch):
    plugin = load_plugin()
    directory = tmp_path / 'project'
    directory.mkdir()
    config = types.ModuleType('gateway.config')
    config.Platform = str
    sessions = types.ModuleType('gateway.session')
    sessions.SessionSource = lambda **fields: types.SimpleNamespace(**fields)
    monkeypatch.setitem(sys.modules, 'gateway.config', config)
    monkeypatch.setitem(sys.modules, 'gateway.session', sessions)
    saved = tmp_path / 'routing.json'

    class SessionStore:
        def get_or_create_session(self, source, touch_activity=False):
            assert source.profile == 'work'
            return types.SimpleNamespace(session_key='work:portal:dm:chat', session_id='session')

        def set_session_metadata(self, key, name, value):
            saved.write_text(json.dumps({key: {name: value}}))

    backend = plugin.HermesBackend(types.SimpleNamespace(_session_store=SessionStore()), tmp_path)
    backend.profile = 'work'
    assert await backend.new_thread('chat', None, str(directory)) == 'session'
    assert json.loads(saved.read_text()) == {'work:portal:dm:chat': {'terminal_cwd': str(directory)}}
    with pytest.raises(ValueError, match='Working directory'):
        await backend.new_thread('missing', None, str(tmp_path / 'missing'))


async def test_file_wait_has_a_finite_deadline(tmp_path):
    with pytest.raises(TimeoutError):
        await until((tmp_path / 'never-created').exists, timeout=0.01)


async def test_logout_during_handshake_cannot_register_a_revoked_socket(world, monkeypatch):
    from aiohttp import web

    await world.sign_up()
    prepared, release = asyncio.Event(), asyncio.Event()
    original = web.WebSocketResponse.prepare

    async def prepare(ws, request):
        result = await original(ws, request)
        if request.path == '/ws':
            prepared.set()
            await release.wait()
        return result

    monkeypatch.setattr(web.WebSocketResponse, 'prepare', prepare)
    connecting = asyncio.create_task(world.http.ws_connect(world.url('/ws'), headers={'Origin': ORIGIN}))
    try:
        await asyncio.wait_for(prepared.wait(), 2)
        assert (await world.post('/api/logout')).status == 200
    finally:
        release.set()
    ws = await connecting
    await closed(ws)
    assert not world.hub.clients


def test_profile_selection_is_captured_before_resolving_homes(tmp_path):
    plugin = load_plugin()

    class Backend(plugin.HermesBackend):
        def homes(self):
            self.profile = 'other'
            return {'default': tmp_path / 'main', 'other': tmp_path / 'other'}

    backend = Backend(None, tmp_path)
    assert backend._home() == tmp_path / 'main'


async def test_file_allowlist_serves_opened_and_concurrently_delivered_files(world, tmp_path):
    initial = [tmp_path / f'init_{i}.png' for i in range(4)]
    later = [tmp_path / f'later_{i}.png' for i in range(4)]
    secret = tmp_path / 'unlisted.png'
    for i, path in enumerate((*initial, *later, secret)):
        path.write_bytes(f'img-{i}'.encode())

    sid = world.hermes.add_session(
        '20261024_060606_ababab',
        'gallery',
        messages=[('assistant', '\n'.join(f'MEDIA:{p}' for p in initial))],
    )
    await world.sign_up()

    opened = await world.http.get(world.url(f'/api/sessions/{sid}'))
    assert opened.status == 200

    responses = await asyncio.gather(
        *(world.http.get(world.url('/api/file'), params={'session': sid, 'path': str(p)}) for p in initial)
    )
    assert [r.status for r in responses] == [200] * len(initial)
    assert [await r.read() for r in responses] == [p.read_bytes() for p in initial]

    # Newly delivered files requested concurrently all resolve and serve their exact bytes.
    world.hermes._row(sid, 'assistant', '\n'.join(f'MEDIA:{p}' for p in later))
    responses = await asyncio.gather(
        *(world.http.get(world.url('/api/file'), params={'session': sid, 'path': str(p)}) for p in later)
    )
    assert [r.status for r in responses] == [200] * len(later)
    assert [await r.read() for r in responses] == [p.read_bytes() for p in later]

    refused = await world.http.get(world.url('/api/file'), params={'session': sid, 'path': str(secret)})
    assert refused.status == 404


async def test_mid_turn_session_rotation_routes_approval_stream_and_completion_to_new_session(world, monkeypatch):
    monkeypatch.setattr(hub_module, 'TURN_SESSION_TTL', 0.05)
    parent = world.hermes.add_session('20261024_070707_cdcdcd', 'before compaction')
    chat = world.hermes.sessions[parent]['chat']
    await world.sign_up()
    ws = await socket_ready(world.http, world)
    await ws.send_json({'watch': parent})
    await until(lambda: parent in world.hub.subscribers)

    await world.hub.turn_started(chat)
    await world.hub.outgoing(chat, 'm1', 'working before compaction')
    while True:
        frame = await asyncio.wait_for(ws.receive_json(), 2)
        if frame.get('kind') == 'event' and frame.get('type') == 'gateway.message':
            assert frame['session'] == parent
            assert frame['payload']['text'] == 'working before compaction'
            break

    # Simulate context compaction rotating the chat to a child session mid-turn without any /command.
    child = world.hermes.add_session('20261024_070708_efefef', 'after compaction', chat=chat)
    world.hermes.sessions[parent]['chat'] = None
    await ws.send_json({'watch': child})
    await until(lambda: child in world.hub.subscribers)

    # Once the short streaming TTL expires, live outgoing text follows the child session without any /command.
    await asyncio.sleep(0.06)
    await world.hub.outgoing(chat, 'm2', 'continuing in child')
    while True:
        frame = await asyncio.wait_for(ws.receive_json(), 2)
        if frame.get('kind') == 'event' and frame.get('type') == 'gateway.message':
            assert frame['session'] == child
            assert frame['payload']['text'] == 'continuing in child'
            break

    # A second rotation is picked up immediately by ask() and turn_finished() without waiting for the TTL.
    child2 = world.hermes.add_session('20261024_070709_010101', 'after second compaction', chat=chat)
    world.hermes.sessions[child]['chat'] = None
    await ws.send_json({'watch': child2})
    await until(lambda: child2 in world.hub.subscribers)

    await world.hub.ask(chat, {'id': 'req-1', 'method': 'approval', 'params': {'command': 'ls', 'choices': ['once']}})
    while True:
        frame = await asyncio.wait_for(ws.receive_json(), 2)
        if frame.get('kind') == 'request':
            assert frame['session'] == child2
            assert frame['request']['id'] == 'req-1'
            break
    await world.hub.settle('req-1')

    await world.hub.turn_finished(chat, 'success')
    saw_status = saw_complete = False
    while not (saw_status and saw_complete):
        frame = await asyncio.wait_for(ws.receive_json(), 2)
        if frame.get('kind') == 'status' and frame.get('session') == child2 and frame.get('status') == 'done':
            saw_status = True
        if frame.get('kind') == 'event' and frame.get('type') == 'message.complete' and frame.get('session') == child2:
            saw_complete = True
    assert parent not in world.hub.running
    assert child not in world.hub.running
    assert child2 not in world.hub.running
    await ws.close()


def test_readonly_pool_sees_wal_writes_allows_checkpoints_survives_replacement_and_cross_thread_reads(tmp_path):
    from concurrent.futures import ThreadPoolExecutor

    plugin = load_plugin()
    main_home = tmp_path / 'main'
    other_home = tmp_path / 'other'
    main_home.mkdir()
    other_home.mkdir()

    def init_db(db_path, rows):
        conn = sqlite3.connect(db_path)
        conn.execute('PRAGMA journal_mode=WAL')
        conn.execute('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, source TEXT)')
        conn.executemany('INSERT INTO sessions VALUES (?, ?, ?)', rows)
        conn.commit()
        return conn

    main_writer = init_db(main_home / 'state.db', [('s1', 'first', 'portal')])
    other_writer = init_db(other_home / 'state.db', [('o1', 'other-first', 'portal')])

    class Backend(plugin.HermesBackend):
        def homes(self):
            return {'default': main_home, 'other': other_home}

    backend = Backend(None, main_home)
    try:
        assert backend.title_of('s1') == 'first'

        # Concurrent WAL write is visible immediately on the next read, and idle pooled
        # connections never hold a read mark that blocks WAL truncation checkpoints.
        main_writer.execute("INSERT INTO sessions VALUES ('s2', 'second-wal', 'portal')")
        main_writer.commit()
        assert backend.title_of('s2') == 'second-wal'
        assert main_writer.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchall()[0][0] == 0

        # Cross-thread concurrent reads across multiple profiles return exact rows.
        def read_profile(i):
            prof = 'default' if i % 2 == 0 else 'other'
            sid = 's2' if prof == 'default' else 'o1'
            rows = backend._read('SELECT title FROM sessions WHERE id=?', (sid,), prof)
            return rows[0][0]

        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(read_profile, range(40)))
        assert results == ['second-wal' if i % 2 == 0 else 'other-first' for i in range(40)]

        # Profile switch reads the active profile's state.db immediately.
        backend.profile = 'other'
        assert backend.title_of('o1') == 'other-first'
        assert backend.title_of('s1') is None
        backend.profile = 'default'

        # Atomic replacement of state.db (new inode) never reads stale rows from the unlinked inode.
        main_writer.close()
        replacement = main_home / 'state.db.new'
        w_new = init_db(replacement, [('s1', 'replaced-db', 'portal')])
        w_new.close()
        replacement.replace(main_home / 'state.db')
        assert backend.title_of('s1') == 'replaced-db'
        assert backend.title_of('s2') is None

        # Deleting state.db returns empty results cleanly, and recreating it works immediately.
        (main_home / 'state.db').unlink()
        assert backend.title_of('s1') is None
        w_recreated = init_db(main_home / 'state.db', [('s3', 'recreated', 'portal')])
        w_recreated.close()
        assert backend.title_of('s3') == 'recreated'

        # Closing releases pooled connections while remaining safe if a late read arrives.
        backend.close()
        assert backend.title_of('s3') == 'recreated'
    finally:
        other_writer.close()
        backend.close()


def test_homes_cache_tracks_config_and_profile_lifecycle_edits(tmp_path, monkeypatch):
    plugin = load_plugin()
    root = tmp_path / 'hermes'
    profiles_root = root / 'profiles'
    elsewhere_root = root / 'profiles_run_elsewhere'
    root.mkdir()
    cfg_path = root / 'config.yaml'
    cfg_path.write_text('multiplex: false\n')

    # Stand-in modules shaped like hermes_cli.config and hermes_cli.profiles where functions
    # belong to their own modules (matching real Hermes, unlike ad-hoc test monkeypatches).
    config_mod = types.ModuleType('hermes_cli.config')
    profiles_mod = types.ModuleType('hermes_cli.profiles')
    hermes_cli_pkg = types.ModuleType('hermes_cli')
    hermes_cli_pkg.config = config_mod
    hermes_cli_pkg.profiles = profiles_mod

    def get_config_path():
        return cfg_path

    def load_config():
        return {'gateway': {'multiplex_profiles': 'multiplex: true' in cfg_path.read_text()}}

    def get_profile_dir(name):
        return root if name == 'default' else profiles_root / name

    def _get_profiles_root():
        return profiles_root

    def profiles_to_serve(*, multiplex):
        if not multiplex:
            return [('default', root)]
        out = [('default', root)]
        if profiles_root.is_dir():
            for entry in sorted(profiles_root.iterdir()):
                if not entry.is_dir():
                    continue
                if (entry / '.profile_deleted').exists() or (entry / 'gateway.parked').exists():
                    continue
                if (elsewhere_root / f'{entry.name}.json').exists():
                    continue
                if (entry / 'config.yaml').exists() and 'standalone: true' in (entry / 'config.yaml').read_text():
                    continue
                if any((entry / m).exists() for m in ('config.yaml', '.env', 'state.db')):
                    out.append((entry.name, entry))
        return out

    for fn in (get_config_path, load_config):
        fn.__module__ = config_mod.__name__
    for fn in (get_profile_dir, _get_profiles_root, profiles_to_serve):
        fn.__module__ = profiles_mod.__name__
    config_mod.get_config_path = get_config_path
    config_mod.load_config = load_config
    profiles_mod.get_profile_dir = get_profile_dir
    profiles_mod._get_profiles_root = _get_profiles_root
    profiles_mod.profiles_to_serve = profiles_to_serve
    monkeypatch.setitem(sys.modules, 'hermes_cli', hermes_cli_pkg)
    monkeypatch.setitem(sys.modules, 'hermes_cli.config', config_mod)
    monkeypatch.setitem(sys.modules, 'hermes_cli.profiles', profiles_mod)

    backend = plugin.HermesBackend(None, root)
    try:
        assert backend.homes() == {'default': root}

        # Enabling multiplex_profiles in config.yaml picks up profiles immediately.
        work = profiles_root / 'work'
        work.mkdir(parents=True)
        (work / 'config.yaml').write_text('standalone: false\n')
        cfg_path.write_text('multiplex: true\n')
        assert backend.homes() == {'default': root, 'work': work}

        # Parking, unparking, standalone flag, tombstone, and run-elsewhere markers all take effect immediately.
        (work / 'gateway.parked').write_text('')
        assert backend.homes() == {'default': root}
        (work / 'gateway.parked').unlink()
        assert backend.homes() == {'default': root, 'work': work}

        (work / 'config.yaml').write_text('standalone: true\n')
        assert backend.homes() == {'default': root}
        (work / 'config.yaml').write_text('standalone: false\n')
        assert backend.homes() == {'default': root, 'work': work}

        elsewhere_root.mkdir()
        (elsewhere_root / 'work.json').write_text('{}')
        assert backend.homes() == {'default': root}
        (elsewhere_root / 'work.json').unlink()
        assert backend.homes() == {'default': root, 'work': work}

        # Adding a second profile via another identity marker appears immediately.
        research = profiles_root / 'research'
        research.mkdir()
        assert backend.homes() == {'default': root, 'work': work}
        (research / '.env').write_text('')
        assert backend.homes() == {'default': root, 'work': work, 'research': research}

        # Disabling multiplex_profiles collapses back to default immediately.
        cfg_path.write_text('multiplex: false\n')
        assert backend.homes() == {'default': root}
    finally:
        backend.close()


def test_store_prunes_expired_auth_rows_and_keeps_group_updates_atomic(tmp_path):
    from portal.store import LOGIN_TTL, SETUP_TTL, Store

    now = [1000.0]
    store = Store(tmp_path / 'portal.db', clock=lambda: now[0])
    store.add_credential(b'cred-1', b'key-1', 0, 'laptop')

    old_login = store.start_login(b'cred-1')
    old_setup = store.new_setup_link()
    assert store.login(old_login) == b'cred-1'
    assert store.setup_link_valid(old_setup) is True

    # After expiry, issuing a new login or setup link prunes expired rows automatically.
    now[0] += max(LOGIN_TTL, SETUP_TTL) + 10
    fresh_login = store.start_login(b'cred-1')
    fresh_setup = store.new_setup_link()
    assert store.login(old_login) is None
    assert store.login(fresh_login) == b'cred-1'
    assert store.setup_link_valid(old_setup) is False
    assert store.setup_link_valid(fresh_setup) is True
    assert store._run('SELECT COUNT(*) FROM logins')[0][0] == 1
    assert store._run('SELECT COUNT(*) FROM setup_links')[0][0] == 1

    # Group membership join, rename clash guard, and atomic deletion stay consistent.
    g1 = store.create_group('Alpha', 'blue')
    g2 = store.create_group('Beta', 'green')
    store.set_chat_group('chat-a', g1['id'])
    store.set_chat_group('chat-b', g2['id'])
    assert store.chat_groups() == {'chat-a': g1, 'chat-b': g2}

    with pytest.raises(ValueError, match="already a group"):
        store.update_group(g1['id'], name='beta')
    renamed = store.update_group(g1['id'], name='Gamma', color='purple')
    assert store.chat_groups()['chat-a'] == renamed

    store.delete_group(g1['id'])
    assert store.chat_groups() == {'chat-b': g2}
    assert store._run('SELECT COUNT(*) FROM chat_group_members WHERE group_id=?', (g1['id'],))[0][0] == 0




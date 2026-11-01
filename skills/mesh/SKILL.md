---
name: mesh
description: "Use when work must run on another of the user's machines. Mesh tools, ids, setup."
version: 1.0.0
author: QuillDev
license: MIT
metadata:
  hermes:
    tags: [mesh, machines, remote, portal]
---

# The Nako mesh

The user runs Hermes on more than one machine, for example a server, a Windows desktop and a MacBook. The mesh joins them so an agent on one machine can hand work to another. The Nako Portal plugin provides it on every machine.

## The picture

One machine is the **hub**. It's usually the always-on server, and its portal is the one the user reads. Every other machine is a **node**. Each node keeps one connection open to the hub at the hub portal's own address (https, the same one the user opens in a browser), so it works from any network.

```
            laptop
              |
 desktop --- hub --- homelab
```

Machines never talk to each other directly. Everything goes through the hub, including node-to-node calls. A node that is off or asleep simply shows as offline.

A task on another machine is a **normal chat on that machine**, run by that machine's own Hermes with its own tools: terminal, files, apps, computer use. The user can watch it live in the portal. It shows up there under the machine's name, and they can steer it, stop it or answer it.

## When to use it

Use another machine **only when the work has to happen there**: its files, its apps, its screen, its hardware, or its local network. Do everything else on the machine you're on. Don't call a machine just to see how it's doing, and don't route plain thinking or web research through it.

## Names and ids

- Machines have short names (`laptop`, `desktop`). The hub has one too (often its hostname). `mesh_machines` lists them.
- A chat anywhere in the mesh is `mesh.<machine>.<session id>`, for example `mesh.desktop.20261101_140000_ab12cd`. Every mesh tool takes and returns ids in this form. The hub's own chats are `mesh.<hub name>.<id>`.

## The tools

| Tool | What it does |
|---|---|
| `mesh_machines` | Who's in the mesh, the hub first: online or not, OS, whether its gateway is up, its Hermes version and commit, how many tasks it's running |
| `mesh_run(machine, prompt, title?, cwd?, wait_seconds?)` | Start a new chat on that machine with your prompt as its first message |
| `mesh_send(session, text, wait_seconds?)` | Send into an existing chat (a follow-up, or a steer if it's busy) |
| `mesh_read(session, wait_seconds?)` | Where a chat stands: running or done, its latest reply, its latest tool calls with the start of each result, and anything it's `waiting_on`. Works while that machine's gateway is down: it says so, and when the chat last moved |
| `mesh_threads(machine, limit?)` | The chats on that machine, newest first, so you can pick one up |
| `mesh_answer(session, request, choice / answers)` | Answer an approval (`choice`) or a question (`answers` by question id) a chat is waiting on |
| `mesh_stop(session)` | Stop the chat's running turn |
| `mesh_restart_gateway(machine, wait_seconds?)` | Restart a machine's gateway through its portal server (works when the gateway is down). Waits until it's back |
| `mesh_update(machine, channel?, wait_seconds?)` | Update a machine's Hermes: its portal server runs `hermes update --yes` apart from the gateway, then restarts the gateway. Returns the version before and after, whether it matches the hub, and the end of the log |

`wait_seconds` (max 600) makes the call wait for the reply instead of returning right away. It returns early if the chat stops to ask something.

## How a task usually goes

1. `mesh_machines`. Is the machine online, and is its Hermes up (`gateway: true`)? If it's online with the gateway down, `mesh_restart_gateway` it. If it's offline, tell the user. Don't queue work for an offline machine.
2. `mesh_run` with a **self-contained brief**. The other machine knows nothing about your conversation. Give it the goal, paths on *that* machine, what done looks like, and what to send back. Give it a short title.
3. Follow it with `mesh_read`, using `wait_seconds` for short jobs or checking back for long ones. Report what it actually did, from its reply. Don't guess.
4. If it's `waiting_on` something, answer with `mesh_answer` only when you're sure the user would agree. Otherwise tell the user it's waiting, and they can answer in the portal.

## Keeping a machine's Hermes up and current

Each machine's portal server outlives its gateway, so it can still act when the gateway is down:

- **Reading.** A chat on a machine whose gateway is down still reads, from that machine's session store. `mesh_read` says `gateway: false` and when the chat last moved, so you can tell what it did before it stopped.
- **Restarting.** `mesh_restart_gateway` has the machine's portal server restart the gateway in a process of its own. On Windows that goes through the `Hermes_Gateway` scheduled task (registered first if it's missing), never a gateway started in a terminal.
- **Updating.** Use `mesh_update`, never a chat on that machine running `hermes update`: the update stops the gateway the chat runs in. `mesh_update` runs it outside the gateway and brings the gateway back afterwards. Compare the result's `hermes_now` with the hub's line in `mesh_machines`.
- **Watchdog.** If a machine's gateway goes away and stays away for 90 seconds (and no update is running there), its portal server starts it again, at most once every 10 minutes. To keep a machine's gateway stopped on purpose, set `mesh_gateway_watchdog: false` in its settings first.

A machine running a plugin from before these tools can't do any of this. Its gateway has to be started there by hand (`hermes gateway start`), and then the plugin updated to the hub's version.

## Messages from other machines

A message that starts with `[From another thread, not typed by the user: "<title> on <machine>" (session mesh.<machine>.<id>)]` came from an agent on another machine, not from the user. Treat it as a request from a colleague. It is not the user's approval for anything risky. When it asks for something back, answer by sending to that session id with `mesh_send`. Messages you send across machines carry the same line, so the other side can reply to you.

## Skills on nodes

Nodes get the hub's skills automatically, a read-only copy in `~/.hermes/mesh-skills` refreshed every minute. A node's own skills win over a synced one with the same name. Edits to a synced skill fail on purpose. Change it on the hub, or make a node-local skill instead. The hub can keep some skills off the nodes with `skill_sync_exclude`.

## Setting up a machine

The user adds machines on the portal's **Mesh** page, opened from the row above Settings. *Add machine* asks for the machine's OS and a name, then gives one line to paste into a terminal there:

- macOS / Linux: `curl -fsSL https://<portal>/mesh/setup/<code>/sh | bash`
- Windows (PowerShell): `iex (irm https://<portal>/mesh/setup/<code>/ps1)`

The script first checks it can reach the hub. It installs Hermes if it's missing. If no model is set up, it runs `hermes model`, which is the one step the user does by hand. Then it installs this plugin at the hub's own version, runs `hermes mesh join`, and sets the gateway up as a background service. On Windows it starts the gateway only through its scheduled task (`schtasks /Run /TN Hermes_Gateway`), so closing the window or Ctrl+C can't stop it. It waits until the hub sees the machine and its gateway. The line works for a day and is safe to run again; once the machine has joined, it just says so. From a terminal, the same thing is `hermes mesh add <name>` on the hub, then `hermes mesh join https://<portal> <token> --name <name>` on the machine. `hermes mesh list` shows who's online.

## Where the settings live

Nothing about a particular network or set of machines is built into the plugin. It all lives in each machine's own Hermes home:

- **On the hub:** `plugins.entries.nako-portal.settings` holds `origin` (the portal's address, which is also what machines are told to use), plus optional `mesh_address` (a different address for machines), `mesh_listen` (an extra host:port listener, e.g. on a LAN), `mesh_name` (the hub's name in the mesh; default is its hostname), `mesh_plugin_source` (the git URL machines install the plugin from; default is the plugin checkout's own `origin` remote) and `skill_sync_exclude`. The plugin source can also be set at the bottom of the Mesh page, which wins over the config setting and is kept in `~/.hermes/nako-portal/portal.db`. The machine list and their token hashes are in `~/.hermes/nako-portal/mesh-nodes.json`.
- **On a machine:** `mesh_hub` (the hub portal's address), `mesh_name` and optional `mesh_gateway_watchdog` (default on) in the same settings block, `NAKO_MESH_TOKEN` in `~/.hermes/.env`, and `~/.hermes/mesh-skills` in `skills.external_dirs`.

## Moving the hub

To give the hub a new address, or move it to a new host:

1. If it's a new host, set up Hermes and this plugin there, and copy the old hub's `~/.hermes/nako-portal/` folder over. It holds the machines' tokens, so they keep working.
2. Point the portal at its new address: `hermes config set plugins.entries.nako-portal.settings.origin https://<new address>`, then `hermes gateway restart`.
3. On each machine: `hermes mesh join https://<new address>` (no token needed; it keeps its own), then `hermes gateway restart`.

That's it. A machine that can't be reached that way can also just be removed on the Mesh page and added again with a fresh setup line.

## When something's wrong

- **Machine offline.** Its gateway isn't running or it can't reach the hub. On that machine, check `hermes gateway status`, `~/.hermes/logs/gateway.log` and `~/.hermes/nako-portal/server.log` (look for `joined the mesh` or `can't reach the mesh hub`).
- **Online, but its gateway is down.** The portal server is up but its gateway isn't, so it can't run turns. `mesh_restart_gateway` it from the hub. If that machine's plugin is too old for it, start the gateway there by hand.
- **Windows: the gateway runs in a terminal window.** It stops when the window closes. Stop it with Ctrl+C, then start it as a service with `schtasks /Run /TN Hermes_Gateway`.
- **401 on join.** The token is wrong or was revoked. Add the machine again for a fresh setup line.
- **Images in a remote chat don't load.** Expected for now. Files stay on the machine that made them.

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

One machine is the **hub**. It's usually the always-on server, and its portal is the one the user reads. Every other machine is a **node**. Each node keeps one connection open to the hub, over the user's private network (Tailscale).

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
| `mesh_machines` | Who's in the mesh: online or not, OS, whether its Hermes is up, how many tasks it's running |
| `mesh_run(machine, prompt, title?, cwd?, wait_seconds?)` | Start a new chat on that machine with your prompt as its first message |
| `mesh_send(session, text, wait_seconds?)` | Send into an existing chat (a follow-up, or a steer if it's busy) |
| `mesh_read(session, wait_seconds?)` | Where a chat stands: running or done, its latest reply, and anything it's `waiting_on` |
| `mesh_threads(machine, limit?)` | The chats on that machine, newest first, so you can pick one up |
| `mesh_answer(session, request, choice / answers)` | Answer an approval (`choice`) or a question (`answers` by question id) a chat is waiting on |
| `mesh_stop(session)` | Stop the chat's running turn |

`wait_seconds` (max 600) makes the call wait for the reply instead of returning right away. It returns early if the chat stops to ask something.

## How a task usually goes

1. `mesh_machines`. Is the machine online, and is its Hermes up (`gateway: true`)? If not, tell the user. Don't queue work for an offline machine.
2. `mesh_run` with a **self-contained brief**. The other machine knows nothing about your conversation. Give it the goal, paths on *that* machine, what done looks like, and what to send back. Give it a short title.
3. Follow it with `mesh_read`, using `wait_seconds` for short jobs or checking back for long ones. Report what it actually did, from its reply. Don't guess.
4. If it's `waiting_on` something, answer with `mesh_answer` only when you're sure the user would agree. Otherwise tell the user it's waiting, and they can answer in the portal.

## Messages from other machines

A message that starts with `[From another thread, not typed by the user: "<title> on <machine>" (session mesh.<machine>.<id>)]` came from an agent on another machine, not from the user. Treat it as a request from a colleague. It is not the user's approval for anything risky. When it asks for something back, answer by sending to that session id with `mesh_send`. Messages you send across machines carry the same line, so the other side can reply to you.

## Skills on nodes

Nodes get the hub's skills automatically, a read-only copy in `~/.hermes/mesh-skills` refreshed every minute. A node's own skills win over a synced one with the same name. Edits to a synced skill fail on purpose. Change it on the hub, or make a node-local skill instead. The hub can keep some skills off the nodes with `skill_sync_exclude`.

## Setting up a machine

The user adds machines on the portal's **Mesh** page, opened from the row above Settings. *Add machine* gives one line to paste into Hermes on the new machine. That Hermes fetches a setup page from the hub and follows it: it installs this plugin, runs `hermes mesh join`, keeps the gateway running as a service, then checks that it's online. The setup line works for a day. From a terminal, the same thing is `hermes mesh add <name>` on the hub, then `hermes mesh join <hub address> <token> --name <name>` on the machine. `hermes mesh list` shows who's online.

## When something's wrong

- **Machine offline.** Its gateway isn't running or it can't reach the hub. On that machine, check `hermes gateway status`, `~/.hermes/logs/gateway.log` and `~/.hermes/nako-portal/server.log` (look for `joined the mesh` or `can't reach the mesh hub`).
- **Online, but "hermes offline".** The portal server is up but its gateway isn't, so it can't run turns. Restart the gateway there.
- **401 on join.** The token is wrong or was revoked. Add the machine again for a fresh setup line.
- **Images in a remote chat don't load.** Expected for now. Files stay on the machine that made them.

"""The one-line setup scripts a new machine runs to join the mesh.

`curl -fsSL <hub>/mesh/setup/<code>/sh | bash` on macOS and Linux, and
`iex (irm <hub>/mesh/setup/<code>/ps1)` in PowerShell on Windows. Each script checks it can
reach the hub, installs Hermes if it's missing, has the person sign in to a model provider if
none is set up (the one step that needs them), then installs the portal plugin at the hub's own
commit, joins the mesh, runs the gateway as a service and waits until the hub sees the machine.
Every value put into a script is checked against a strict pattern first, so none can break out
of its quotes.
"""

from __future__ import annotations

import re

HERMES_SH = "https://hermes-agent.nousresearch.com/install.sh"
HERMES_PS1 = "https://hermes-agent.nousresearch.com/install.ps1"
SAFE = {
    "hub": re.compile(r"^https?://[A-Za-z0-9.\-\[\]:]+$"),
    "name": re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$"),
    "token": re.compile(r"^[A-Za-z0-9_-]{20,100}$"),
    "status": re.compile(r"^https?://[A-Za-z0-9.\-\[\]:/_-]+$"),
    "source": re.compile(r"^(https://|git@|ssh://)[A-Za-z0-9.@:/_~-]+$"),
    "ref": re.compile(r"^([0-9a-f]{40})?$"),
}


def _checked(**values):
    for key, value in values.items():
        if not SAFE[key].match(value):
            raise ValueError(f"unsafe {key} for a setup script: {value!r}")
    return values


def shell_script(*, hub, name, token, status, source, ref):
    v = _checked(hub=hub, name=name, token=token, status=status, source=source, ref=ref or "")
    ref_flag = f" --ref {v['ref']}" if v["ref"] else ""
    return f"""#!/usr/bin/env bash
# Joins this machine to a Nako mesh as "{v['name']}". Served once by the hub; safe to run again.
set -eu
HUB='{v['hub']}'
NAME='{v['name']}'
STATUS='{v['status']}'

say() {{ printf '\\n\\033[1m==> %s\\033[0m\\n' "$*"; }}
fail() {{ printf '\\n\\033[31mx %s\\033[0m\\n' "$*" >&2; exit 1; }}

say "Checking that this machine can reach the hub at $HUB"
curl -fsS --max-time 10 "$STATUS" >/dev/null 2>&1 || fail "Can't reach $HUB from this machine. Is it online, and is that address right?"

export PATH="$HOME/.local/bin:$PATH"
if ! command -v hermes >/dev/null 2>&1; then
  say "Installing Hermes"
  curl -fsSL {HERMES_SH} | bash -s -- --non-interactive || fail "The Hermes installer failed (see its log above)"
  hash -r
  command -v hermes >/dev/null 2>&1 || fail "Hermes installed, but 'hermes' isn't on PATH. Open a new terminal and run this line again."
fi

if ! hermes config get model.provider >/dev/null 2>&1; then
  say "Pick a model and sign in to its provider (this is the one step that needs you)"
  [ -r /dev/tty ] || fail "No terminal to sign in from. Run this line in a terminal window."
  hermes model </dev/tty || fail "Model setup didn't finish"
  hermes config get model.provider >/dev/null 2>&1 || fail "No model is set up yet. Run 'hermes model', then this line again."
fi

say "Installing the Nako Portal plugin"
hermes plugins install {v['source']}{ref_flag} --enable --yes-deps --force || fail "Installing the plugin failed"

say "Joining the mesh as $NAME"
hermes mesh join "$HUB" '{v['token']}' --name "$NAME" || fail "Joining the mesh failed"

say "Running the Hermes gateway as a background service"
hermes gateway install --if-missing --start-on-login --no-start-now || fail "Installing the gateway service failed"
hermes gateway restart || hermes gateway start || fail "Starting the gateway failed"

say "Waiting for the hub to see this machine"
for _ in $(seq 1 36); do
  if curl -fsS --max-time 10 "$STATUS" 2>/dev/null | grep -q '"online": true'; then
    printf '\\n\\033[32m✓ %s joined the mesh.\\033[0m Run hermes to chat here, or hand it work from the hub.\\n' "$NAME"
    exit 0
  fi
  sleep 5
done
fail "The hub hasn't seen $NAME after 3 minutes. Check ~/.hermes/logs/gateway.log and ~/.hermes/nako-portal/server.log"
"""


def powershell_script(*, hub, name, token, status, source, ref):
    v = _checked(hub=hub, name=name, token=token, status=status, source=source, ref=ref or "")
    ref_args = f" --ref {v['ref']}" if v["ref"] else ""
    return f"""# Joins this machine to a Nako mesh as "{v['name']}". Served once by the hub; safe to run again.
& {{
$ErrorActionPreference = 'Stop'
$Hub = '{v['hub']}'
$Name = '{v['name']}'
$Status = '{v['status']}'

function Say($m) {{ Write-Host "`n==> $m" -ForegroundColor Cyan }}
function Fail($m) {{ Write-Host "`nx $m" -ForegroundColor Red; throw $m }}
function Refresh-Path {{ if ($env:OS -ne 'Windows_NT') {{ return }}; $env:Path = [Environment]::GetEnvironmentVariable('Path','User') + ';' + [Environment]::GetEnvironmentVariable('Path','Machine') }}

Say "Checking that this machine can reach the hub at $Hub"
try {{ Invoke-RestMethod -Uri $Status -TimeoutSec 10 | Out-Null }} catch {{ Fail "Can't reach $Hub from this machine. Is it online, and is that address right?" }}

Refresh-Path
if (-not (Get-Command hermes -ErrorAction SilentlyContinue)) {{
  Say 'Installing Hermes'
  & ([scriptblock]::Create((Invoke-RestMethod '{HERMES_PS1}'))) -NonInteractive
  Refresh-Path
  if (-not (Get-Command hermes -ErrorAction SilentlyContinue)) {{ Fail "Hermes installed, but 'hermes' isn't on PATH. Open a new PowerShell window and run this line again." }}
}}

$ErrorActionPreference = 'Continue'
hermes config get model.provider *> $null
if ($LASTEXITCODE -ne 0) {{
  Say 'Pick a model and sign in to its provider (this is the one step that needs you)'
  hermes model
  hermes config get model.provider *> $null
  if ($LASTEXITCODE -ne 0) {{ Fail "No model is set up yet. Run 'hermes model', then this line again." }}
}}

Say 'Installing the Nako Portal plugin'
hermes plugins install {v['source']}{ref_args} --enable --yes-deps --force
if ($LASTEXITCODE -ne 0) {{ Fail 'Installing the plugin failed' }}

Say "Joining the mesh as $Name"
hermes mesh join $Hub '{v['token']}' --name $Name
if ($LASTEXITCODE -ne 0) {{ Fail 'Joining the mesh failed' }}

Say 'Running the Hermes gateway as a background service'
hermes gateway install --if-missing --start-on-login --no-start-now
if ($LASTEXITCODE -ne 0) {{ Fail 'Installing the gateway service failed' }}
hermes gateway restart
if ($LASTEXITCODE -ne 0) {{ hermes gateway start; if ($LASTEXITCODE -ne 0) {{ Fail 'Starting the gateway failed' }} }}

Say 'Waiting for the hub to see this machine'
for ($i = 0; $i -lt 36; $i++) {{
  try {{ if ((Invoke-RestMethod -Uri $Status -TimeoutSec 10).online) {{ Write-Host "`n$([char]0x2713) $Name joined the mesh. Run hermes to chat here, or hand it work from the hub." -ForegroundColor Green; return }} }} catch {{ }}
  Start-Sleep -Seconds 5
}}
Fail "The hub hasn't seen $Name after 3 minutes. Check $env:USERPROFILE\\.hermes\\logs\\gateway.log and $env:USERPROFILE\\.hermes\\nako-portal\\server.log"
}}
"""

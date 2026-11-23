"""The one-line setup scripts a new machine runs to join the mesh.

`curl -fsSL <hub>/mesh/setup/<code>/sh | bash` on macOS and Linux, and
`iex (irm <hub>/mesh/setup/<code>/ps1)` in PowerShell on Windows. Each script checks it can
reach the hub, installs Hermes if it's missing, has the person sign in to a model provider if
none is set up (the one step that needs them), then installs the portal plugin at the hub's own
commit, joins the mesh, runs the gateway as a service and waits until the hub sees the machine
and its gateway. On Windows the gateway is only ever started through its scheduled task, never
in the script's own window, where closing it or Ctrl+C would stop it.
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
    "agent": re.compile(r"^[a-z][a-z0-9_-]{0,31}$"),
    "ref": re.compile(r"^([0-9a-f]{40})?$"),
}


def _checked(**values):
    for key, value in values.items():
        if not SAFE[key].match(value):
            raise ValueError(f"unsafe {key} for a setup script: {value!r}")
    return values


def shell_script(*, hub, name, token, status, source, ref, agent="hermes"):
    v = _checked(hub=hub, name=name, token=token, status=status, source=source, ref=ref or "", agent=agent)
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
if ! command -v {v['agent']} >/dev/null 2>&1; then
  say "Installing Hermes"
  curl -fsSL {HERMES_SH} | bash -s -- --non-interactive || fail "The Hermes installer failed (see its log above)"
  hash -r
  command -v {v['agent']} >/dev/null 2>&1 || fail "Hermes installed, but '{v['agent']}' isn't on PATH. Open a new terminal and run this line again."
fi

if ! {v['agent']} config get model.provider >/dev/null 2>&1; then
  say "Pick a model and sign in to its provider (this is the one step that needs you)"
  [ -r /dev/tty ] || fail "No terminal to sign in from. Run this line in a terminal window."
  {v['agent']} model </dev/tty || fail "Model setup didn't finish"
  {v['agent']} config get model.provider >/dev/null 2>&1 || fail "No model is set up yet. Run '{v['agent']} model', then this line again."
fi

say "Installing the Nako Portal plugin"
{v['agent']} plugins install {v['source']}{ref_flag} --enable --yes-deps --force || fail "Installing the plugin failed"

say "Joining the mesh as $NAME"
{v['agent']} mesh join "$HUB" '{v['token']}' --name "$NAME" || fail "Joining the mesh failed"

say "Running the Hermes gateway as a background service"
{v['agent']} gateway install --if-missing --start-on-login --no-start-now || fail "Installing the gateway service failed"
{v['agent']} gateway restart || {v['agent']} gateway start || fail "Starting the gateway failed"

say "Waiting for the hub to see this machine and its gateway"
for _ in $(seq 1 36); do
  if curl -fsS --max-time 10 "$STATUS" 2>/dev/null | grep -q '"gateway": true'; then
    printf '\\n\\033[32m✓ %s joined the mesh.\\033[0m Run {v['agent']} to chat here, or hand it work from the hub.\\n' "$NAME"
    exit 0
  fi
  sleep 5
done
fail "The hub hasn't seen $NAME after 3 minutes. Check ~/.{v['agent']}/logs/gateway.log and ~/.{v['agent']}/nako-portal/server.log"
"""


def powershell_script(*, hub, name, token, status, source, ref, agent="hermes"):
    v = _checked(hub=hub, name=name, token=token, status=status, source=source, ref=ref or "", agent=agent)
    ref_args = f" --ref {v['ref']}" if v["ref"] else ""
    return f"""# Joins this machine to a Nako mesh as "{v['name']}". Served once by the hub; safe to run again.
& {{
$ErrorActionPreference = 'Stop'
$Hub = '{v['hub']}'
$Name = '{v['name']}'
$Status = '{v['status']}'
$Task = '{v['agent'].capitalize()}_Gateway'

function Say($m) {{ Write-Host "`n==> $m" -ForegroundColor Cyan }}
function Fail($m) {{ Write-Host "`nx $m" -ForegroundColor Red; throw $m }}
function Refresh-Path {{ if ($env:OS -ne 'Windows_NT') {{ return }}; $env:Path = [Environment]::GetEnvironmentVariable('Path','User') + ';' + [Environment]::GetEnvironmentVariable('Path','Machine') }}

Say "Checking that this machine can reach the hub at $Hub"
try {{ Invoke-RestMethod -Uri $Status -TimeoutSec 10 | Out-Null }} catch {{ Fail "Can't reach $Hub from this machine. Is it online, and is that address right?" }}

Refresh-Path
if (-not (Get-Command {v['agent']} -ErrorAction SilentlyContinue)) {{
  Say 'Installing Hermes'
  & ([scriptblock]::Create((Invoke-RestMethod '{HERMES_PS1}'))) -NonInteractive
  Refresh-Path
  if (-not (Get-Command {v['agent']} -ErrorAction SilentlyContinue)) {{ Fail "Hermes installed, but '{v['agent']}' isn't on PATH. Open a new PowerShell window and run this line again." }}
}}

$ErrorActionPreference = 'Continue'
{v['agent']} config get model.provider *> $null
if ($LASTEXITCODE -ne 0) {{
  Say 'Pick a model and sign in to its provider (this is the one step that needs you)'
  {v['agent']} model
  {v['agent']} config get model.provider *> $null
  if ($LASTEXITCODE -ne 0) {{ Fail "No model is set up yet. Run '{v['agent']} model', then this line again." }}
}}

Say 'Installing the Nako Portal plugin'
{v['agent']} plugins install {v['source']}{ref_args} --enable --yes-deps --force
if ($LASTEXITCODE -ne 0) {{ Fail 'Installing the plugin failed' }}

Say "Joining the mesh as $Name"
{v['agent']} mesh join $Hub '{v['token']}' --name $Name
if ($LASTEXITCODE -ne 0) {{ Fail 'Joining the mesh failed' }}

Say 'Running the Hermes gateway as a background service'
{v['agent']} gateway install --if-missing --start-on-login --no-start-now
if ($LASTEXITCODE -ne 0) {{ Fail 'Installing the gateway service failed' }}
# Only ever through the scheduled task: `{v['agent']} gateway start` can run it in this window, where
# closing the window or Ctrl+C stops it.
schtasks /Query /TN $Task *> $null
if ($LASTEXITCODE -ne 0) {{ Fail "The $Task scheduled task isn't registered, so the gateway can't run in the background. Run '{v['agent']} gateway install', then this line again." }}
{v['agent']} gateway stop *> $null
schtasks /Run /TN $Task | Out-Null
if ($LASTEXITCODE -ne 0) {{ Fail "Starting the $Task scheduled task failed" }}

Say 'Waiting for the hub to see this machine and its gateway'
for ($i = 0; $i -lt 36; $i++) {{
  try {{
    $seen = Invoke-RestMethod -Uri $Status -TimeoutSec 10
    if ($seen.online -and $seen.gateway) {{ Write-Host "`n$([char]0x2713) $Name joined the mesh. Run {v['agent']} to chat here, or hand it work from the hub." -ForegroundColor Green; return }}
  }} catch {{ }}
  Start-Sleep -Seconds 5
}}
$state = (schtasks /Query /TN $Task /FO LIST /V | Select-String 'Status|Last Run|Last Result') -join '; '
Fail "The hub hasn't seen $Name's gateway after 3 minutes ($Task task: $state). Check $env:USERPROFILE\\.{v['agent']}\\logs\\gateway.log and $env:USERPROFILE\\.{v['agent']}\\nako-portal\\server.log"
}}
"""

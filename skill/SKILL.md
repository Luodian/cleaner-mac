---
name: mac-cleanup
description: Routine cleanup and health check of a Mac with the cmac command (cleaner-mac). Use when asked to clean the Mac, free disk space, find out why macOS feels slow or stutters, show CPU, memory or disk use, or review login items and background processes.
---

# Mac cleanup

Measure first, remove only what the owner agrees to, then report what changed in numbers. One pass; do not repeat a measurement unless something changed.

If `~/.config/cleaner-mac/notes.md` exists, read it first: it holds this machine's own rules and takes precedence over this file.

## Rules

- `cmac` owns the list of what is removable. Do not delete cache folders by hand.
- Never touch the foreground desktop: no focus changes, no raised windows. Quit an app with `osascript -e 'tell application "X" to quit'`, reopen it with `open -g -j -a X`.
- No `sudo`. When a step needs it, give the owner the exact command to run in another terminal, writing its output to a file you can read.
- zsh traps: `log` is a zsh builtin, so call `/usr/bin/log`. zsh does not split `$pids`; use an array or `${=pids}`.

## 1. Measure

```bash
cmac stats --json      # CPU, memory, swap, disk, network, battery, busiest processes
cmac scan --json       # every removable item: id, tier, size in KB, undo, note
uptime
```

## 2. Disk

```bash
cmac clean --yes --no-analysis --only <id,id>   # remove the ids the owner agreed to
cmac undo                                       # put the latest removal back
cmac purge --yes                                # delete what is held; only when the owner asks for the space
```

- You are the reviewer here, so pass `--no-analysis` and do the review yourself: before removing anything, tell the owner what each id is, its size, its `note`, and whether `undo` is true. Remove only after they say yes.
- `tier: "safe"` with `undo: true`: the files are moved to `~/.cleaner-mac/removed`, not deleted. The disk space comes back only after `cmac purge`. Say so in the report.
- `tier: "safe"` with `undo: false` (`uv-prune`, `pnpm-prune`, `brew-cleanup`): a command that cannot be undone. Name these separately when asking.
- `tier: "ask"`: never removed by the tool. List the largest entries inside each (`du -sh <dir>/* | sort -rh | head`) and ask, with sizes.
- Outside the tool, ask before touching anything under `~/Library/Application Support`, `~/Library/Containers`, `~/Library/Group Containers`, or project folders.
- Never: `~/.ssh`, credential folders, agent config folders (`~/.claude`, `~/.codex`), anything under `/System` or `/Library`, Time Machine snapshots.

A person runs the same tool without an agent: `cmac` scans and shows one line of choices where Tab takes the main one; cleaning first has a small model review the list, then asks.

## 3. Processes and stutter

Run this part when the Mac feels slow.

```bash
ps -p "$(pgrep -x WindowServer)" -o etime,time,rss,comm
ps -axo comm | awk -F/ '{print $NF}' | sort | uniq -c | sort -rn | head -10
pmset -g therm
/usr/bin/log show --last 5m --style compact --predicate 'process == "launchd" AND eventMessage CONTAINS "Successfully spawned"' | awk '{print $NF}' | sort | uniq -c | sort -rn | head -5
/usr/bin/log show --last 10m --style compact --predicate 'process == "WindowServer" AND eventMessage CONTAINS "timed out fence"' | grep -c fence
ls -t /Library/Logs/DiagnosticReports | head -10
```

- WindowServer CPU time divided by uptime above about 15%, or resident memory above 1.5 GB, after a week or more of uptime: recommend a restart. Nothing else resets it.
- A service spawned more than about 10 times in 5 minutes is crash-looping. Name it and why (`/usr/bin/log show --predicate 'process == "<name>" AND messageType >= 16'`). System agents cannot be stopped under System Integrity Protection; report them.
- `timed out fence` lines are dropped frames. A burst at the instant of an audio route change (headphones connecting) is expected; a steady count is not.
- `*.cpu_resource.diag` and `*.diag` files from the last day name processes the system itself flagged.
- Do not stop at "resources look fine": a Mac can stutter with free memory, no heat and an idle GPU. Ask whether it is the pointer, window animation or typing; a Bluetooth mouse is a separate line of inquiry.

Deeper sampling needs the owner: `sudo powermetrics --samplers tasks,interrupts,gpu_power,thermal -i 2000 -n 5 --show-process-energy -o /tmp/powermetrics.txt`. Do not run heavy commands of your own while it samples; they show up as `DEAD_TASKS`.

## 4. Login items

```bash
osascript -e 'tell application "System Events" to get the name of every login item'
launchctl print-disabled gui/$(id -u) | grep -v com.apple
ls ~/Library/LaunchAgents /Library/LaunchAgents /Library/LaunchDaemons
```

- Report login items and launch agents that are new since the last run. Turn one off with `launchctl disable gui/$(id -u)/<label>` (reversible with `enable`) only when the owner agrees, and write down the `enable` line for them.
- A disabled agent cannot be started by opening its app: mouse and keyboard tools do nothing until the label is enabled again and loaded (`launchctl bootstrap gui/$(id -u) <plist>`). Say so before disabling one.
- Leave the owner's own scheduled jobs alone. `/Library/LaunchDaemons` needs `sudo`; list it, do not change it.
- After a Homebrew upgrade or cleanup, start each Homebrew-installed runtime once (`node -v`, `python3 -V`): a shared library bump breaks the ones that were not upgraded with it.

## 5. Report

Lead with free disk before and after, and how much is held for undo. Then a short table: what was removed, its size, and whether it can be undone. Then the questions (large items that need a yes), each with its size. Then anything unhealthy from section 3 with the number that shows it. Skip sections where nothing was found.

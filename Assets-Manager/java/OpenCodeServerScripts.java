package com.opencode.mobile;

/** Auditable shell payloads run inside Termux by OpenCodeServer. Arguments are positional. */
final class OpenCodeServerScripts {
    // ---------------------------------------------------------------- scripts run INSIDE Termux (bash)
    // Arguments are passed positionally ($1...), never spliced into the script text: no quoting/injection problems.
    /** $1 workspace, $2 port, $3 password. Starts the server detached, records its pid. Exit codes: 127 no executable, 20 workspace unusable, 21 cd failed. */
    static final String START_SCRIPT =
            "PFX=\"${PREFIX:-/data/data/com.termux/files/usr}\"\n"
                    + "oc=\"$(command -v opencode 2>/dev/null)\"; [ -n \"$oc\" ] || oc=\"$PFX/bin/opencode\"\n"
                    + "[ -x \"$oc\" ] || { echo 'OPENCODE_NOT_FOUND' >&2; exit 127; }\n"
                    + "agentdir=\"$HOME/.config/opencode/agents\"; planfile=\"$agentdir/plan.md\"; mkdir -p \"$agentdir\"\n"
                    + "if [ ! -e \"$planfile\" ]; then tmp=\"$planfile.tmp.$$\"; cat > \"$tmp\" <<'OCSI_PLAN_AGENT'\n"
                    + "---\n"
                    + "description: Read-only planning agent for OpenCode SI\n"
                    + "mode: primary\n"
                    + "permission:\n"
                    + "  edit: deny\n"
                    + "  bash: ask\n"
                    + "  external_directory: deny\n"
                    + "---\n"
                    + "You are the Plan agent in OpenCode SI. Analyze the user's request and the current project. Produce a clear, ordered implementation plan, note risks and tests, and ask questions when requirements are ambiguous. Do not modify project files. Do not claim to have executed commands or changed files. Shell commands require explicit approval.\n"
                    + "OCSI_PLAN_AGENT\n"
                    + "mv -- \"$tmp\" \"$planfile\"; fi\n"
                    + "ws=\"$1\"\n"
                    + "{ [ -d \"$ws\" ] && [ -r \"$ws\" ] && [ -w \"$ws\" ]; } || { echo \"WORKSPACE_INACCESSIBLE: $ws\" >&2; exit 20; }\n"
                    + "cd \"$ws\" || { echo 'CD_FAILED' >&2; exit 21; }\n"
                    + "sd=\"$HOME/.opencode-si\"; mkdir -p \"$sd\"; pf=\"$sd/opencode-server.pid\"; log=\"$sd/opencode-server.log\"; port=\"$2\"; wantws=\"$(readlink -f \"$1\" 2>/dev/null)\"\n"
                    + "# Preserve the previous owner record until the actual server process is found alive.\n"
                    + "if command -v setsid >/dev/null 2>&1; then OPENCODE_SERVER_PASSWORD=\"$3\" nohup setsid \"$oc\" serve --hostname 127.0.0.1 --port \"$port\" >\"$log\" 2>&1 </dev/null &\n"
                    + "else OPENCODE_SERVER_PASSWORD=\"$3\" nohup \"$oc\" serve --hostname 127.0.0.1 --port \"$port\" >\"$log\" 2>&1 </dev/null &\n"
                    + "fi\n"
                    + "launch_pid=$!; pid=; i=0\n"
                    + "matches_server() { p=\"$1\"; [ -r \"/proc/$p/cmdline\" ] || return 1; cmd=\"$(tr '\\0' ' ' < \"/proc/$p/cmdline\" 2>/dev/null)\"; first=\"${cmd%% *}\"; case \"$first\" in */nohup|nohup|*/setsid|setsid|*/sh|sh|*/env|env) return 1;; esac; case \"$cmd\" in *\"$oc\"*serve*\"--port $port\"*|*\"$oc\"*serve*\"--port=$port\"*) ;; *) return 1;; esac; cwd=\"$(readlink -f \"/proc/$p/cwd\" 2>/dev/null)\"; [ -n \"$wantws\" ] && [ \"$cwd\" = \"$wantws\" ] || return 1; fd=\"$(readlink \"/proc/$p/fd/1\" 2>/dev/null)\"; [ \"$fd\" = \"$log\" ] || [ \"$fd\" = \"$log (deleted)\" ] || return 1; return 0; }\n"
                    + "find_server_pid() { for f in /proc/[0-9]*/cmdline; do p=\"${f#/proc/}\"; p=\"${p%/cmdline}\"; [ \"$p\" != \"$$\" ] || continue; [ \"$p\" = \"$launch_pid\" ] && continue; if matches_server \"$p\"; then printf '%s\\n' \"$p\"; return 0; fi; done; return 1; }\n"
                    + "# setsid/nohup implementations may fork, so $! can be a short-lived launcher rather than OpenCode.\n"
                    + "while [ \"$i\" -lt 12 ]; do\n"
                    + "  if matches_server \"$launch_pid\"; then pid=\"$launch_pid\"; break; fi\n"
                    + "  found=\"$(find_server_pid 2>/dev/null)\"; if [ -n \"$found\" ]; then pid=\"$found\"; break; fi\n"
                    + "  sleep 0.25; i=$((i+1))\n"
                    + "done\n"
                    + "[ -n \"$pid\" ] || { echo 'SERVER_PROCESS_EXITED: OpenCode exited before ownership could be recorded.' >&2; tail -n 40 \"$log\" >&2; exit 22; }\n"
                    + "# Only use process-group signalling when /proc confirms this process owns its session.\n"
                    + "stat=\"$(cat \"/proc/$pid/stat\" 2>/dev/null)\"; rest=\"${stat##*) }\"; set -- $rest; pgid=\"$3\"; sid=\"$4\"; grp=single; if [ \"$pgid\" = \"$pid\" ] && [ \"$sid\" = \"$pid\" ]; then grp=group; fi\n"
                    + "tmp=\"$pf.tmp.$$\"; printf '%s\\n%s\\n%s\\n' \"$pid\" \"$grp\" \"$ws\" > \"$tmp\" && mv -f \"$tmp\" \"$pf\"\n"
                    + "echo \"LAUNCHED pid=$pid workspace=$ws\"\n";

    /** $1 workspace. Read-only probe used by the setup wizard. */
    static final String PROBE_SCRIPT =
            "PFX=\"${PREFIX:-/data/data/com.termux/files/usr}\"\n"
                    + "oc=\"$(command -v opencode 2>/dev/null)\"; [ -n \"$oc\" ] || oc=\"$PFX/bin/opencode\"\n"
                    + "echo \"OC_PATH=$oc\"\n"
                    + "if [ -x \"$oc\" ]; then echo OC_EXEC=1; v=\"$(\"$oc\" --version 2>&1 | head -n 1)\"; echo \"OC_VERSION=$v\"; else echo OC_EXEC=0; fi\n"
                    + "ws=\"$1\"\n"
                    + "if [ -d \"$ws\" ] && [ -r \"$ws\" ] && [ -w \"$ws\" ]; then echo WS=ok; elif [ -d \"$ws\" ]; then echo WS=noaccess; else echo WS=missing; fi\n";

    /** $1 port. Stops ONLY the process recorded by our own start script, after re-checking /proc/<pid>/cmdline. */
    static final String STOP_SCRIPT =
            "sd=\"$HOME/.opencode-si\"; pf=\"$sd/opencode-server.pid\"\n"
                    + "[ -f \"$pf\" ] || { echo NO_PIDFILE; exit 3; }\n"
                    + "pid=\"$(sed -n 1p \"$pf\")\"; grp=\"$(sed -n 2p \"$pf\")\"\n"
                    + "case \"$pid\" in ''|*[!0-9]*) echo BAD_PIDFILE; exit 3;; esac\n"
                    + "[ -r \"/proc/$pid/cmdline\" ] || { echo NOT_RUNNING; rm -f \"$pf\"; exit 0; }\n"
                    + "cmd=\"$(tr '\\0' ' ' < \"/proc/$pid/cmdline\")\"\n"
                    + "case \"$cmd\" in *opencode*serve*\"--port $port\"*|*opencode*serve*\"--port=$port\"*) ;; *) echo \"NOT_OURS: $cmd\"; exit 4;; esac\n"
                    + "if [ \"$grp\" = group ]; then kill -TERM -- \"-$pid\" 2>/dev/null; else kill -TERM \"$pid\" 2>/dev/null; fi\n"
                    + "i=0; while [ $i -lt 12 ] && [ -d \"/proc/$pid\" ]; do sleep 0.5; i=$((i+1)); done\n"
                    + "if [ -d \"/proc/$pid\" ]; then if [ \"$grp\" = group ]; then kill -KILL -- \"-$pid\" 2>/dev/null; else kill -KILL \"$pid\" 2>/dev/null; fi; echo KILLED; else echo STOPPED; fi\n"
                    + "rm -f \"$pf\"\n";

    /** Verifies that the live server on $1 is the exact process recorded by our launcher and is running in $2. */
    static final String OWNERSHIP_SCRIPT =
            "port=\"$1\"; sd=\"$HOME/.opencode-si\"; pf=\"$sd/opencode-server.pid\"; log=\"$sd/opencode-server.log\"; want=\"$(readlink -f \"$2\" 2>/dev/null)\"\n"
                    + "[ -n \"$want\" ] || { echo NOT_OWNED; exit 0; }\n"
                    + "is_server() { p=\"$1\"; [ -r \"/proc/$p/cmdline\" ] || return 1; cmd=\"$(tr '\\0' ' ' < \"/proc/$p/cmdline\" 2>/dev/null)\"; case \"$cmd\" in *opencode*serve*\"--port $port\"*|*opencode*serve*\"--port=$port\"*) return 0;; *) return 1;; esac; }\n"
                    + "cwd_of() { readlink -f \"/proc/$1/cwd\" 2>/dev/null; }\n"
                    + "log_matches() { p=\"$1\"; fd=\"$(readlink \"/proc/$p/fd/1\" 2>/dev/null)\"; [ \"$fd\" = \"$log\" ] || [ \"$fd\" = \"$log (deleted)\" ]; }\n"
                    + "recorded_workspace_matches() { rw=\"$(sed -n 3p \"$pf\" 2>/dev/null)\"; [ -n \"$rw\" ] || return 1; rw=\"$(readlink -f \"$rw\" 2>/dev/null)\"; [ -n \"$rw\" ] && [ \"$rw\" = \"$want\" ]; }\n"
                    + "pid_candidate() { p=\"$1\"; is_server \"$p\" || return 1; cwd=\"$(cwd_of \"$p\")\"; if [ \"$cwd\" = \"$want\" ]; then printf '%s\\n' \"$p|$cwd|0\"; return 0; fi; if log_matches \"$p\" || recorded_workspace_matches; then printf '%s\\n' \"$p|$cwd|1\"; return 0; fi; return 1; }\n"
                    + "# Legacy recovery: if the PID record was lost, discover a unique server by exact port+command+cwd.\n"
                    + "scan_candidate() { p=\"$1\"; is_server \"$p\" || return 1; cwd=\"$(cwd_of \"$p\")\"; if [ \"$cwd\" != \"$want\" ] && ! log_matches \"$p\"; then return 1; fi; stat=\"$(cat \"/proc/$p/stat\" 2>/dev/null)\"; rest=\"${stat##*) }\"; set -- $rest; pgid=\"$3\"; [ -n \"$pgid\" ] || return 1; printf '%s\\n' \"$p|$cwd|$(log_matches \"$p\" && echo 1 || echo 0)|$pgid\"; }\n"
                    + "pid=\"$(sed -n 1p \"$pf\" 2>/dev/null)\"; record=\"\"; case \"$pid\" in ''|*[!0-9]*) pid=\"\";; esac\n"
                    + "if [ -n \"$pid\" ]; then record=\"$(pid_candidate \"$pid\" 2>/dev/null)\" || record=\"\"; fi\n"
                    + "if [ -z \"$record\" ]; then count=0; seen_groups=\" \"; for f in /proc/[0-9]*/cmdline; do p=\"${f#/proc/}\"; p=\"${p%/cmdline}\"; x=\"$(scan_candidate \"$p\" 2>/dev/null)\" || continue; group=\"${x##*|}\"; case \"$seen_groups\" in *\" $group \"*) continue;; esac; seen_groups=\"$seen_groups$group \"; record=\"$x\"; count=$((count+1)); done; [ \"$count\" -eq 1 ] || { echo NOT_OWNED; exit 0; }; fi\n"
                    + "IFS='|' read -r pid cwd logowned <<EOF\n$record\nEOF\n"
                    + "stat=\"$(cat \"/proc/$pid/stat\" 2>/dev/null)\"; rest=\"${stat##*) }\"; set -- $rest; pgid=\"$3\"; grp=single; [ \"$pgid\" = \"$pid\" ] && grp=group; printf '%s\\n%s\\n%s\\n' \"$pid\" \"$grp\" \"$want\" > \"$pf\"\n"
                    + "printf 'OWNED_PID=%s\\nOWNED_CWD=%s\\nOWNED_LOG=%s\\n' \"$pid\" \"$cwd\" \"$logowned\"\n";

    static final String LOG_SCRIPT = "tail -n 40 \"$HOME/.opencode-si/opencode-server.log\" 2>&1 || echo '(no server log yet)'\n";

}

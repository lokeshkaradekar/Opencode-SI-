/* agent.js — AgentInterface + OpenCodeAdapter (Phase 9), session recovery (Phase 16)
   and the AI screen. The UI only talks to the interface, so another agent
   (Claude, Codex, custom, remote) can replace OpenCode without UI changes.

   Chat goes to the OFFICIAL OpenCode agent through the OpenCode server that the app starts in Termux
   (Bridge.agentStart/agentSend/agentStatus -> NativeBridge -> OpenCodeAgent -> `opencode serve`). The UI shows the
   server's own message log (tool calls and their real results); nothing is scripted here.
   Plan/Build only chooses which of OpenCode's own agents handles the next message (Plan asks for the server's plan
   agent); the app does not enforce read-only itself and reports whatever the server actually does.
   Transcript: OpenCode keeps it. Only the session id, the task state and a small task index are cached locally, and the
   visible transcript is re-read from OpenCode after a restart, so no copy of the conversation is written to the
   WebView's storage. */
(function (g) {
  'use strict';
  var h = UI.h;
  // Tasks are server-owned. There is deliberately no elapsed-time cutoff: a slow model call,
  // large code generation, build or dependency install remains live until OpenCode reports a result
  // or the user explicitly presses Stop.
  var appInBackground = false;
  // In-memory transcript cache survives route changes and WebView view re-mounts. OpenCode remains
  // the durable source of truth; this cache prevents a blank chat while the server history is reloaded.
  var transcriptCache = Object.create(null);

  function setBackgroundState(background) {
    background = !!background;
    if (background === appInBackground) return;
    appInBackground = background;
    var now = Date.now();
    var agent = g.Agent;
    var rec = agent && agent.activeActivity;
    if (!rec) return;
    if (background) {
      if (!rec.backgroundSince) rec.backgroundSince = now;
    } else if (rec.backgroundSince) {
      rec.backgroundMs = (rec.backgroundMs || 0) + Math.max(0, now - rec.backgroundSince);
      rec.backgroundSince = 0;
    }
  }

  function foregroundTaskElapsed(rec, now) {
    if (!rec) return 0;
    now = now || Date.now();
    var start = rec.startedAt || rec.ts || now;
    var backgroundMs = rec.backgroundMs || 0;
    if (rec.backgroundSince) backgroundMs += Math.max(0, now - rec.backgroundSince);
    return Math.max(0, now - start - backgroundMs);
  }

  function currentProjectPath() {
    var p = g.State && g.State.project && g.State.project.path;
    return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
  }
  function sessionPathMatches(session, path) {
    // Non-native/dev adapters may not expose a path; native projects must match exactly.
    return !path || !!(session && session.projectPath && String(session.projectPath).replace(/\\/g, '/').replace(/\/+$/, '') === path);
  }

  /* ---------- interface ---------- */
  function AgentInterface() {}
  ['startSession', 'sendMessage', 'cancel', 'resume', 'getStatus', 'getTools', 'getHistory'].forEach(function (m) {
    AgentInterface.prototype[m] = function () { throw new Error(m + ' not implemented'); };
  });

  /* ---------- OpenCode adapter ---------- */
  function OpenCodeAdapter() {
    this.id = 'opencode';
    this.name = 'OpenCode';
    this.key = '-';                                // project id the state belongs to
    this.session = null;                           // {id, projectId, task, steps, stepsDone, status, modified, reply, changes}
    this.history = [];
    this.status = 'idle';                          // idle | working | error
    this.activity = [];
    this.activeActivity = null;
    this.lastApplied = null;
    this.runId = 0;
    this.taskId = 0;             // bumped once per task (sendMessage/resume); identifies WHICH task a poll is for
    this.pollingTaskId = null;   // the task the live poll loop is currently watching
    this.activePollRun = null;   // the runId the live poll loop was started under
    this.activePollPromise = null;
    this.pollNudged = false;
    this.lastLiveTranscriptSyncAt = 0; // throttle full history reads during active polling
    this.planUnavailable = false;
    this.permissionMode = 'allow-project';
    this.permissionConfirmed = false;
    this.permissionModeLoaded = false; // Loaded from the native preference store before the first task.
  }
  OpenCodeAdapter.prototype = Object.create(AgentInterface.prototype);
  OpenCodeAdapter.prototype.constructor = OpenCodeAdapter;

  var P = OpenCodeAdapter.prototype;

  P.k = function (name) { return name + ':' + this.key; };

  P.setBackgroundState = function (background) { setBackgroundState(background); };

  // Reconcile on foreground: wake an existing poll loop, or create one if WebView timers
  // were suspended and the loop disappeared. Never start two pollers for the same task.
  P.onForeground = function () {
    if (!this.session || !this.session.id || this.status !== 'working') return Promise.resolve();
    var rec = this.activeActivity;
    if (!rec) {
      for (var i = this.history.length - 1; i >= 0; i--) {
        if (this.history[i] && this.history[i].role === 'activity') { rec = this.history[i]; break; }
      }
    }
    if (this.activePollPromise && this.activePollRun === this.runId) {
      this.pollNudged = true;
      return this.activePollPromise;
    }
    if (rec) return this.poll(rec, this.taskId || ++this.taskId);
    return Promise.resolve();
  };

  /* OpenCode's task-status endpoint reports tool progress, not every assistant message.
     Refresh the server-owned transcript during polling as well as when a project is opened.
     Merge only messages missing from the local in-memory view; preserve activity/system cards
     and insert new conversation messages before the live activity card. */
  P.syncLiveTranscript = function (sessionId, run) {
    var self = this;
    if (!sessionId || Bridge.mode !== 'native' || typeof Bridge.agentHistory !== 'function') return Promise.resolve(false);
    return Bridge.agentHistory(sessionId).then(function (msgs) {
      if ((run !== undefined && self.runId !== run) || !Array.isArray(msgs)) return false;
      var counts = Object.create(null);
      function key(role, text) { return role + '\u0000' + String(text || ''); }
      self.history.forEach(function (m) {
        if (m && (m.role === 'user' || m.role === 'agent')) {
          var k = key(m.role, m.text); counts[k] = (counts[k] || 0) + 1;
        }
      });
      var missing = [];
      msgs.forEach(function (m) {
        if (!m || (m.role !== 'user' && m.role !== 'agent') || !String(m.text || '').trim()) return;
        var k = key(m.role, m.text);
        if (counts[k] > 0) counts[k]--;
        else missing.push({ role: m.role, text: String(m.text), ts: Date.now() });
      });
      if (!missing.length) return false;
      var at = self.activeActivity ? self.history.indexOf(self.activeActivity) : -1;
      if (at < 0) at = self.history.length;
      Array.prototype.splice.apply(self.history, [at, 0].concat(missing));
      if (self.key) transcriptCache[String(self.key)] = self.history.slice();
      Bus.emit('agent');
      return true;
    }).catch(function () {
      // Transcript sync is best-effort. A transient history endpoint failure must never stop
      // the authoritative task-status poll or turn a healthy running task into a failure.
      return false;
    });
  };

  /* Switch to a project: restores its chat, checkpoint and pending proposal. */
  P.load = function (projectId) {
    this.runId++;
    // Cache the outgoing project before changing the key; otherwise navigating to Home and
    // reopening a project can accidentally associate the old transcript with the new project.
    if (this.key && this.history && this.history.length) transcriptCache[String(this.key)] = this.history.slice();
    this.key = projectId;
    this.planUnavailable = false;
    this.status = 'idle';
    this.activity = [];
    this.activeActivity = null;
    this.lastApplied = null;
    this.lastLiveTranscriptSyncAt = 0;
    // This is deliberately memory-only (no plaintext transcript in localStorage); OpenCode remains
    // the durable source of truth while the cached copy avoids a blank screen during a route change.
    var self = this, key = String(projectId);
    this.session = Persist.get(this.k('session'), null);
    this.history = transcriptCache[key] ? transcriptCache[key].slice() : [];
    Persist.del(this.k('history'));                 // older builds cached the whole chat in plaintext: remove it
    Persist.del(this.k('pending'));                  // older builds persisted a review-proposal queue: remove it
    Bus.emit('agent');
    var s = this.session;
    if (s && s.id && Bridge.mode === 'native') {
      var restored = Bridge.agentHistory(s.id).then(function (msgs) {
        if (String(self.key) !== key) return;
        self.history = msgs.map(function (m) { return { role: m.role, text: m.text, ts: Date.now() }; });
        transcriptCache[key] = self.history.slice();
        Bus.emit('agent');
      }, function () {
        // Keep the cached transcript visible during a transient daemon/server failure. Do not
        // silently erase a conversation merely because history could not be fetched this time.
        if (String(self.key) === key && self.history.length) Bus.emit('agent');
      });
      if (s.status === 'running') {                  // the app was restarted while a task ran: find out what really happened
        this.status = 'working';
        var rrec = newActivity();
        this.activeActivity = rrec;
        // Wait for the transcript restore above to settle first, so its "history still empty" guard sees the
        // real state and isn't short-circuited by this record landing first.
        restored.then(function () {
          if (self.key !== key) return;
          // Restore the transcript first, then append the live activity row and start polling.
          // Starting poll before transcript restoration could finish first and leave a stale
          // Thinking row appended after the final assistant response.
          self.history.push(rrec);
          Bus.emit('agent');
          self.poll(rrec, ++self.taskId);
        });
      }
    }
  };

  P.save = function () {
    if (this.key && this.history) transcriptCache[String(this.key)] = this.history.slice();
    Persist.set(this.k('session'), this.session);   // id + task state only; the transcript stays in OpenCode
    Bus.emit('agent');
  };

  /* Permanently remove app-side state for a deleted project. Project IDs are folder names, so
     re-creating the same name must not inherit the deleted folder's OpenCode session or task index. */
  P.resetProjectData = function (projectId) {
    if (!projectId) return;
    ['session:', 'tasks:', 'mode:', 'history:', 'pending:', 'tabs:'].forEach(function (prefix) {
      Persist.del(prefix + projectId);
    });
    if (String(this.key) === String(projectId)) {
      // Invalidate outstanding polling callbacks before clearing the in-memory chat.
      this.runId++;
      this.status = 'idle';
      this.session = null;
      this.history = [];
      this.activity = [];
      this.activeActivity = null;
      this.lastApplied = null;
      Bus.emit('agent');
    }
  };
  /* Start a fresh chat without deleting project files or the server-side historical session. */
  P.restartChat = function () {
    if (this.status === 'working' || (this.session && this.session.status === 'running')) {
      var busy = new Error('Wait for the current task to finish or stop it before restarting the chat.');
      busy.code = 'TASK_RUNNING';
      return Promise.reject(busy);
    }
    this.runId++; // invalidate delayed polling/history callbacks from the old chat
    Persist.del(this.k('session'));
    Persist.del(this.k('history'));
    Persist.del(this.k('pending'));
    this.session = null;
    this.history = [];
    this.status = 'idle';
    this.activity = [];
    this.activeActivity = null;
    this.lastApplied = null;
    Bus.emit('agent');
    UI.toast('New chat ready. Project files and task archive are unchanged.');
    return Promise.resolve(true);
  };

  P.push = function (msg) { msg.ts = Date.now(); this.history.push(msg); transcriptCache[String(this.key)] = this.history.slice(); this.save(); };
  P.getStatus = function () { return this.status; };
  // Called by the native Activity lifecycle and document visibility events.
  P.setBackgroundState = setBackgroundState;
  P.getHistory = function () { return this.history; };
  P.getTools = function () { return ['read', 'search', 'write', 'run']; };

  /* Plan/Build is a per-project choice; it decides which of OpenCode's own agents handles the next message. */
  Object.defineProperty(P, 'mode', {
    get: function () { return Persist.get(this.k('mode'), 'build') === 'plan' ? 'plan' : 'build'; },
    set: function (m) {
      Persist.set(this.k('mode'), m === 'plan' ? 'plan' : 'build');
      Bus.emit('agent');
    }
  });

  Object.defineProperty(P, 'canResume', {
    get: function () {
      var s = this.session;
      return !!(s && s.task && !s.resumeBlocked && sessionPathMatches(s, currentProjectPath()) && (s.status === 'cancelled' || s.status === 'interrupted' || s.status === 'failed' || s.status === 'uncertain') && this.status !== 'working');
    }
  });

  var TOOL_MAP = { list_files: 'read', read_file: 'read', search: 'search', write_file: 'write', run_command: 'run' };

  /* Before creating or continuing an agent session, force the official OpenCode server to use
     the currently selected SI project. Otherwise the model can write to a stale custom workspace
     while the Files tab lists a different directory. Never send a task if alignment/recovery fails. */
  P.prepareWorkspace = function () {
    if (Bridge.mode !== 'native' || !State.project || !State.project.id || typeof Bridge.opencodeSetWorkspace !== 'function') {
      return Promise.resolve();
    }
    return Bridge.opencodeSetWorkspace('project').then(function () {
      if (typeof OpenCode === 'undefined' || typeof OpenCode.ensure !== 'function') return;
      return OpenCode.ensure(true).then(function (st) {
        if (!st || st.state !== 'READY') {
          var e = new Error(st && st.message ? st.message : 'OpenCode is not ready in the selected project workspace.');
          e.code = st && st.code ? st.code : 'WORKSPACE_NOT_READY';
          throw e;
        }
        if (st.workspaceVerified === false && st.managed !== true) {
          var mismatch = new Error('OpenCode could not verify that it is using the selected project folder. The task was not sent, to avoid creating files in another folder.');
          mismatch.code = 'WORKSPACE_UNVERIFIED';
          throw mismatch;
        }
      });
    });
  };

  P.startSession = function () {
    var self = this;
    return Bridge.agentStart().then(function (r) {
      self.session = { id: r.sessionId, projectId: State.project.id, projectPath: currentProjectPath(), task: null, steps: [], stepsDone: 0, status: 'idle', modified: [], reply: '', snapshot: null };
      return self.session;
    });
  };

  /* The agent runs inside the daemon and acts through real tools. Here we only poll its REAL action log;
     nothing in the UI is scripted. Every file/command shown was actually executed (or actually failed). */
  /* Activity record: one per task, lives inline in Agent.history (not a free-floating block), so it survives
     drawList() rebuilds, keeps its own expand/collapse choice, and never mixes with another task's steps.
     phase is derived ONLY from real fields the backend gives us (no invented "Planning"/"Testing"/etc):
       'thinking'  - status running, zero steps yet (true: the agent hasn't acted on anything yet)
       'acting'    - at least one step; label comes from the latest step's real tool+arg
       'done' | 'failed' | 'cancelled' | 'uncertain' - the session's own terminal state */
  function newActivity() {
    var now = Date.now();
    return { role: 'activity', ts: now, startedAt: now, backgroundMs: 0, backgroundSince: appInBackground ? now : 0, phase: 'thinking', steps: [], progress: [], expanded: false, error: null };
  }

  /* Recover the visible live card from adapter state before drawing. The transcript array is mutable and
     some WebView redraws can happen after native status/header events rather than after a history append.
     Never leave the header saying working while the live activity row is absent or buried above newer rows. */
  P.ensureActiveActivity = function () {
    if (this.status !== 'working') return null;
    var rec = this.activeActivity;
    if (rec && (rec.phase === 'thinking' || rec.phase === 'acting') && this.history.indexOf(rec) < 0) {
      // Reinsert the same object so the existing poll keeps updating the row we render.
      this.history.push(rec);
    }
    if (!rec || (rec.phase !== 'thinking' && rec.phase !== 'acting')) {
      rec = null;
      for (var i = this.history.length - 1; i >= 0; i--) {
        var item = this.history[i];
        if (item && item.role === 'activity' && (item.phase === 'thinking' || item.phase === 'acting')) { rec = item; break; }
      }
    }
    if (!rec) { rec = newActivity(); this.history.push(rec); }
    else {
      var at = this.history.indexOf(rec);
      if (at < 0) this.history.push(rec);
      else if (at !== this.history.length - 1) { this.history.splice(at, 1); this.history.push(rec); }
    }
    this.activeActivity = rec;
    return rec;
  };

  P.sendMessage = function (text) {
    var self = this;
    if (!text || !String(text).trim() || this.status === 'working') return Promise.resolve();
    if (!this.permissionModeLoaded && Bridge.getPermissionMode) {
      return Bridge.getPermissionMode().then(function (x) { self.permissionMode = x.mode || 'allow-project'; self.permissionModeLoaded = true; return self.sendMessage(text); })
        .catch(function () { self.permissionModeLoaded = true; return self.sendMessage(text); });
    }
    if (this.permissionMode === 'ask-each-time' && !this.permissionConfirmed) {
      return UI.confirm('Approve this task?', 'OpenCode may read or change project files and run tools. Continue with this task?', 'Approve', false).then(function (ok) {
        if (!ok) return;
        self.permissionConfirmed = true;
        return self.sendMessage(text).then(function (v) { self.permissionConfirmed = false; return v; }, function (e) { self.permissionConfirmed = false; throw e; });
      });
    }
    var selectedPath = currentProjectPath();
    var priorPathMismatch = !!(this.session && this.session.projectId === State.project.id && selectedPath && !sessionPathMatches(this.session, selectedPath));
    if (priorPathMismatch) {
      // OpenCode sessions are bound to the directory where they were created. Changing the server cwd
      // does not move an existing session. Never reuse a same-name session from a different folder.
      this.history = [];
      this.push({ role: 'system', text: 'The selected project folder changed. A new OpenCode session will be used for ' + selectedPath + '; the previous session remains in OpenCode history.' });
    }
    this.push({ role: 'user', text: text });
    this.lastLiveTranscriptSyncAt = 0;
    this.status = 'working';
    this.activity = [];
    var rec = newActivity();
    this.activeActivity = rec;
    this.history.push(rec);
    var taskId = ++this.taskId;
    this.save();
    var sameProject = this.session && this.session.projectId === State.project.id && this.session.status !== 'closed' && sessionPathMatches(this.session, selectedPath);
    var ready = this.prepareWorkspace().then(function () { return sameProject ? null : self.startSession(); });
    function begin() {
      var s = self.session;
      s.task = text; s.steps = []; s.stepsDone = 0; s.status = 'running'; s.resumeBlocked = false; s.mode = self.mode; s.modified = []; s.reply = '';
      self.save();
      return Bridge.agentSend(s.id, text, self.mode, self.permissionMode, self.permissionConfirmed);
    }
    return ready.then(begin).catch(function (e) {
      // The session belongs to a folder OpenCode is no longer in: nothing was sent, so a fresh session is safe.
      if (e && e.code === 'SESSION_NOT_FOUND') return self.startSession().then(begin);
      throw e;
    }).then(function () { return self.poll(rec, taskId); }).catch(function (e) { self.fail(e, rec); });
  };

  P.resume = function () {
    var self = this, s = this.session;
    if (!this.canResume) return Promise.resolve();
    this.lastLiveTranscriptSyncAt = 0;
    this.status = 'working';
    var rec = newActivity();
    this.activeActivity = rec;
    this.history.push(rec);
    var taskId = ++this.taskId;
    // Navigation away from a project does not stop the native OpenCode task. The saved UI state can
    // therefore say failed/uncertain while the same session is still genuinely RUNNING in the native
    // task registry. Never send a second "continue" message until we have checked the authoritative
    // task status: doing so is rejected as TASK_RUNNING and leaves the UI in an error loop.
    return this.prepareWorkspace().then(function () {
      return Bridge.agentStatus(s.id, 0);
    }).then(function (st) {
      st = st || {};
      if (st.state === 'RUNNING') {
        s.status = 'running';
        self.push({ role: 'system', text: 'The previous task is still running. Reconnecting to its progress instead of starting it again.' });
        return self.poll(rec, taskId);
      }
      if (st.state === 'SUCCESS') {
        s.status = 'running';
        self.push({ role: 'system', text: 'The previous task has already finished. Recovering its result.' });
        return self.finish(st, rec);
      }
      // A terminal/uncertain task may be continued normally. The native layer will reject a duplicate
      // if it still owns a live task, but the RUNNING preflight above handles the ordinary navigation case.
      // A plain "continue" repeatedly lets a stalled model rewrite its checklist without doing
      // the requested work. Give terminal tasks an execution-oriented continuation instruction.
      // This is only sent after status confirms the previous turn is not RUNNING or SUCCESS.
      self.push({ role: 'system', text: 'Resuming the task with an implementation check.' });
      return Bridge.agentResume(s.id).then(function () {
        s.status = 'running';
        return self.poll(rec, taskId);
      });
    }).catch(function (e) { self.fail(e, rec); });
  };

  /* Each call to poll() owns one run (self.runId) and, while that run is current, one task
     (self.pollingTaskId). A second signal for the SAME task (e.g. a native "opencode.task" event
     arriving while our own loop is already watching it) must never start a competing run: that
     would bump runId and silently orphan the real in-flight request, leaving status === 'working'
     forever with no poll loop left alive to resolve it. Giving each task its own id (taskId, bumped
     once per sendMessage/resume, independent of runId) lets callers tell "a new task truly started"
     apart from "a stale or duplicate signal for the task we're already polling". */
  P.poll = function (rec, taskId) {
    if (taskId !== undefined && taskId === this.pollingTaskId && this.runId === this.activePollRun) {
      // Same task, already being watched by a live loop: just nudge it to check sooner instead of
      // spawning a second loop. The woken() check inside tick() consumes this exactly once.
      this.pollNudged = true;
      return this.activePollPromise || Promise.resolve();
    }
    var self = this, run = ++this.runId, s = this.session, fails = 0;
    this.activePollRun = run;
    this.pollingTaskId = taskId !== undefined ? taskId : this.pollingTaskId;
    this.pollNudged = false;
    function mapStep(st) { return { tool: TOOL_MAP[st.tool] || 'run', arg: st.arg, state: st.done ? (st.ok ? 'done' : 'failed') : 'running', error: st.error || null }; }
    function wait(ms) {
      // A nudge (real native completion event) collapses the remaining delay so we don't wait out
      // a full 1.5s tick after already being told the task is done.
      return new Promise(function (r) {
        var done = false;
        var t = setTimeout(function () { if (!done) { done = true; r(); } }, ms);
        (function check() {
          if (done) return;
          if (self.runId !== run) { done = true; clearTimeout(t); r(); return; }
          if (self.pollNudged) { self.pollNudged = false; done = true; clearTimeout(t); r(); return; }
          setTimeout(check, 50);
        })();
      });
    }
    function tick() {
      if (self.runId !== run) return Promise.resolve();
      return Bridge.agentStatus(s.id, 0).then(function (st) {
        fails = 0;
        if (self.runId !== run) return;
        // Status polling alone does not carry intermediate assistant messages. Refresh the real
        // conversation before rendering this tick, so explanations produced during long tool calls
        // appear immediately instead of only after leaving/reopening the project.
        // The event stream supplies live public-text deltas. A full transcript fetch every 1.5s
        // adds repeated HTTP/JSON work without improving tool status. Refresh immediately on the
        // first tick and at most every 5s while running; always refresh on a terminal status.
        var now = Date.now();
        var shouldSyncTranscript = !self.lastLiveTranscriptSyncAt ||
          now - self.lastLiveTranscriptSyncAt >= 5000 || st.state !== 'RUNNING';
        var transcriptSync = shouldSyncTranscript
          ? (self.lastLiveTranscriptSyncAt = now, self.syncLiveTranscript(s.id, run))
          : Promise.resolve(false);
        return transcriptSync.then(function () {
          if (self.runId !== run) return;
          // A RUNNING status is authoritative: do not cancel a legitimate server task solely because
        // a wall-clock/foreground timer expired. Some providers legitimately take several minutes.
        // Keep polling and preserve the manual Stop action. Actual status API failures are handled below.
        self.activity = st.steps.map(mapStep);
        if (rec) {
          rec.steps = self.activity;
          var liveSignals = (rec.progress || []).filter(function (e) { return e && (e.kind === 'stream' || e.kind === 'activity-signal'); });
          rec.progress = (Array.isArray(st.activity) ? st.activity : (rec.progress || [])).filter(function (e) { return !e || (e.kind !== 'stream' && e.kind !== 'activity-signal'); }).concat(liveSignals);
          rec.phase = self.activity.length || rec.progress.length ? 'acting' : 'thinking';
          self.activeActivity = rec;
        }
        s.steps = self.activity.map(function (a) { return { tool: a.tool, arg: a.arg }; });
        s.stepsDone = s.steps.length;
        Bus.emit('agent');
          if (st.state === 'RUNNING') return wait(1500).then(tick);
          return self.finish(st, rec);
        });
      }, function (e) {
        // A status read can fail while the server restarts or the app was frozen: keep watching a few times before giving up.
        if (self.runId !== run) return;
        // Keep the live task and activity page available during temporary server/Android
        // transport outages. Retry indefinitely with a capped backoff; never turn elapsed time
        // alone into a failed task or ask the user to Resume the same still-running work.
        fails++;
        if (rec) { rec.notice = 'Connection interrupted. Reconnecting to OpenCode; the task has not been cancelled.'; Bus.emit('agent'); }
        return wait(Math.min(10000, 1500 + fails * 1000)).then(tick);
      });
    }
    this.activePollPromise = tick().catch(function (e) { self.fail(e, rec); }).then(function (r) {
      if (self.runId === run) { self.activePollPromise = null; self.activePollRun = null; }
      return r;
    });
    return this.activePollPromise;
  };

  P.finish = function (st, rec) {
    var s = this.session;
    st = st || {};
    st.steps = Array.isArray(st.steps) ? st.steps : [];
    st.changes = Array.isArray(st.changes) ? st.changes : [];
    st.summary = Array.isArray(st.summary) ? st.summary : [];
    st.snapshot = st.snapshot || null;
    s.snapshot = st.snapshot || s.snapshot;
    s.modified = st.changes.map(function (c) { return c && c.path ? c.path : ''; }).filter(Boolean);
    // Some server versions omit the changes array even though their real tool log contains successful writes.
    // Merge those real write paths so the user can locate the files in Files after the task.
    (rec && rec.steps ? rec.steps : []).forEach(function (step) {
      if (step && step.tool === 'write' && step.state === 'done' && step.arg && s.modified.indexOf(step.arg) < 0) s.modified.push(step.arg);
    });
    if (st.state === 'CANCELLED') { s.status = 'cancelled'; this.status = 'idle'; if (rec) rec.phase = 'cancelled'; this.push({ role: 'system', text: 'Stopped. Work already done stays on disk; you can resume or undo.' }); }
    else if (st.state === 'UNCERTAIN') {
      s.status = 'uncertain'; this.status = 'idle'; if (rec) rec.phase = 'uncertain';
      this.push({ role: 'system', text: (st.error && st.error.message) || 'The outcome of this task is not known. Check the changed files, then continue the session.' });
    }
    else if (st.state === 'FAILED') {
      s.status = 'failed'; this.status = 'error';
      if (rec) { rec.phase = 'failed'; rec.error = st.error ? st.error.message : 'The agent failed.'; }
      var failure = { message: st.error ? st.error.message : 'The agent failed.', details: st.error ? (st.error.details || st.error.code) : null, code: st.error && st.error.code };
      var classified = Errors.classify(failure, failure.code);
      this.history.push({ role: 'error', err: classified, code: failure.code, ts: Date.now() });
    }
    else if (st.state === 'SUCCESS' || st.state === 'DONE' || st.state === 'COMPLETED' || st.state === 'success') {
      s.status = 'done'; this.status = 'idle'; if (rec) rec.phase = 'done';
    } else {
      // Unknown server states must never be silently displayed as successful completion.
      s.status = 'uncertain'; this.status = 'idle'; if (rec) { rec.phase = 'uncertain'; rec.error = 'The server returned an unrecognized task state: ' + String(st.state || '(missing)'); }
    }
    if (st.reply) {
      // A terminal transcript sync may already have delivered this exact final assistant reply.
      // Avoid showing it twice, but allow identical replies in separate turns.
      var lastUser = -1;
      for (var hi = this.history.length - 1; hi >= 0; hi--) {
        if (this.history[hi] && this.history[hi].role === 'user') { lastUser = hi; break; }
      }
      var replyAlreadySynced = this.history.slice(lastUser + 1).some(function (m) {
        return m && m.role === 'agent' && m.text === st.reply;
      });
      if (!replyAlreadySynced) this.history.push({ role: 'agent', text: st.reply, ts: Date.now() });
    }
    // Verified summary generated from the real action log (not from the model's words).
    var lines = (st.summary || []);
    if (lines.length || st.changes.length) {
      this.history.push({
        role: 'system', text: 'What actually happened:\n' + (lines.join('\n') || st.changes.length + ' file(s) changed'),
        applied: !!st.snapshot, ts: Date.now(), summaryLines: lines, changedPaths: s.modified, ranSteps: (rec && rec.steps) || []
      });
    }
    this.lastApplied = st.snapshot && (st.changes.length || lines.length) ? { snapshot: st.snapshot } : null;
    if (!rec || this.activeActivity === rec) this.activeActivity = null;
    s.status = s.status === 'running' ? 'done' : s.status;
    this.recordTask(st);
    this.save();
    // Refresh the real tree after every finished agent run: servers differ in whether they report a changes array.
    Bus.emit('files');
  };

  /* Persistent, per-project AI task index: metadata only (the task label already lives in the session record),
     never the conversation. The source of truth for the transcript stays inside OpenCode. */
  P.taskHistory = function () {
    var list = Persist.get(this.k('tasks'), []);
    return Object.prototype.toString.call(list) === '[object Array]' ? list : [];
  };

  P.recordTask = function (st) {
    var s = this.session;
    if (!s || !s.id) return;
    var rec = {
      id: s.id, at: Date.now(), task: String(s.task || '').slice(0, 200), mode: s.mode || this.mode,
      state: st && st.state ? st.state : 'UNCERTAIN', steps: (s.steps || []).length,
      changes: st && st.changes ? st.changes.length : (s.modified || []).length, snapshot: (st && st.snapshot) || null
    };
    var list = this.taskHistory().filter(function (r) { return r && r.id !== rec.id; });
    list.unshift(rec);
    Persist.set(this.k('tasks'), list.slice(0, 30));
    // Keep Home ordering tied to real recent agent work, not only folder mtime.
    var meta = Persist.get('project-meta', {});
    meta[this.key] = meta[this.key] || {};
    meta[this.key].lastOpened = Date.now();
    Persist.set('project-meta', meta);
  };

  /* Open an existing OpenCode session from the workspace task list: transcript + outcome come from the server. */
  P.openSession = function (id) {
    var self = this;
    this.runId++;
    this.status = 'idle';
    this.activity = [];
    this.activeActivity = null;
    this.lastApplied = null;
    this.history = [];
    this.session = { id: id, projectId: this.key, projectPath: null, task: null, steps: [], stepsDone: 0, status: 'idle', modified: [], reply: '', snapshot: null };
    this.save();
    var hist = Bridge.agentHistory(id).then(function (msgs) {
      self.history = msgs.map(function (m) { return { role: m.role, text: m.text, ts: Date.now() }; });
      for (var i = self.history.length - 1; i >= 0; i--) { if (self.history[i].role === 'user') { self.session.task = self.history[i].text; break; } }
    }, function () { /* session gone or server down: leaves the chat empty */ });
    var stat = Bridge.agentStatus(id, 0).then(function (st) {
      var s = self.session;
      s.snapshot = st.snapshot || null;
      s.modified = (st.changes || []).map(function (c) { return c.path; });
      s.steps = (st.steps || []).map(function (x) { return { tool: x.tool, arg: x.arg }; });
      s.stepsDone = s.steps.length;
      if (st.state === 'RUNNING') { s.status = 'running'; self.status = 'working'; }
      else s.status = st.state === 'CANCELLED' ? 'cancelled' : st.state === 'UNCERTAIN' ? 'uncertain' : st.state === 'FAILED' ? 'failed' : 'done';
    }, function () { /* cannot read the outcome now: the transcript still opens */ });
    return Promise.all([hist, stat]).then(function () {
      if (self.session.status === 'running') {
        // Reopened running sessions need their own visible activity record too. Without it,
        // the header can say "working" while the chat contains no Thinking/Working card.
        var rec = newActivity();
        self.activeActivity = rec;
        rec.steps = (self.session.steps || []).map(function (x) {
          return { tool: TOOL_MAP[x.tool] || 'run', arg: x.arg, state: 'running', error: null };
        });
        rec.phase = rec.steps.length ? 'acting' : 'thinking';
        self.history.push(rec);
        self.save();
        Bus.emit('agent');
        return self.poll(rec, ++self.taskId);
      }
      self.save();
    });
  };

  P.cancel = function () {
    if (this.status !== 'working') return Promise.resolve();
    var s = this.session;
    // Only the server can stop the run. If this OpenCode version cannot abort, say so instead of pretending.
    return s ? Bridge.agentCancel(s.id).then(function () { UI.toast('Stop requested'); }, function (e) { UI.toast(e.message, 'bad'); }) : Promise.resolve();   // poll() sees CANCELLED
  };

  /* Development mock only (dev.html): pretend the app was killed mid-task. */
  P.simulateKill = function () { this.runId++; this.status = 'idle'; this.save(); };

  P.fail = function (e, rec) {
    this.runId++;
    // An unsupported Plan agent is a capability mismatch discovered before anything was sent - not an
    // interrupted or failed task. The mode control's own note (drawHead) already explains this and switches
    // the UI back to Build; raising it again as a generic error card here would be the same message twice,
    // once as a clear explanation and once as "Something unexpected went wrong". Fall back quietly instead.
    if (e && e.code === 'AGENT_UNAVAILABLE') {
      this.status = 'idle';
      this.planUnavailable = true;
      if (this.session) {
        this.session.resumeBlocked = true;
        if (this.session.status === 'running') this.session.status = 'idle';
      }
      this.mode = 'build';
      if (rec) { this.history = this.history.filter(function (m) { return m !== rec; }); }
      this.save();
      return;
    }
    this.status = 'error';
    if (this.session && this.session.status === 'running') this.session.status = 'failed';
    if (rec) { rec.phase = 'failed'; rec.error = e && e.message; }
    var err = Errors.classify({ message: e.message, details: e.details }, e.code);
    this.push({ role: 'error', err: err });
  };

  /* Undo = restore the whole project to the snapshot the daemon took before the agent's first change. */
  P.undo = function () {
    var self = this, la = this.lastApplied;
    if (!la || !la.snapshot) return Promise.resolve();
    return UI.confirm('Undo the agent\u2019s changes?', 'Restores the project to how it was before this task. Edits you made since then are also undone (a safety snapshot is taken first).', 'Undo', true).then(function (ok) {
      if (!ok) return;
      return Bridge.snapshotRollback(la.snapshot, true).then(function (r) {
        self.lastApplied = null;
        self.push({ role: 'system', text: 'Restored the project (' + r.removed_count + ' added file(s) removed).' });
        Bus.emit('files');
      }).catch(function (e) { self.fail(e); });
    });
  };

  /* Undo a past task from the workspace task list, using the snapshot recorded with it. */
  P.undoTask = function (snapshotId) {
    var self = this;
    if (!snapshotId) return Promise.resolve();
    return UI.confirm('Undo this task\u2019s changes?', 'Restores the project to how it was before that task. Edits made since then are also undone (a safety snapshot is taken first).', 'Undo', true).then(function (ok) {
      if (!ok) return;
      return Bridge.snapshotRollback(snapshotId, true).then(function (r) {
        UI.toast('Restored the project (' + r.removed_count + ' added file(s) removed)');
        Bus.emit('files');
      }, function (e) { UI.toast(e.message, 'bad'); });
    });
  };

  var Agent = new OpenCodeAdapter();

  /* The native side emits "opencode.task" once per task end, keyed only by sessionId (every message in a
     chat reuses the same session, so this event cannot say WHICH task finished). Android delivery is not
     guaranteed to be prompt or exactly-once (background throttling, GC pauses), so a delayed or duplicate
     event from an already-finished task can arrive after the NEXT task has started and is still genuinely
     running. Reading it lets the UI reconcile sooner than the next 1.5s poll tick - but it must never be
     allowed to start a second, competing poll loop: Agent.poll() already treats a same-task nudge as "wake
     the existing loop", never a reason to bump runId and orphan the one actually in flight. */
  if (Bridge.on) {
    Bridge.on('opencode.task', function (d) {
      if (!d || !Agent.session || d.sessionId === undefined || Agent.session.id === null || Agent.session.id === undefined) return;
      if (String(d.sessionId) !== String(Agent.session.id)) return;
      if (Agent.status === 'working') {
        // Keep the inline activity record attached when the native completion event wakes polling.
        var rec = null;
        for (var i = Agent.history.length - 1; i >= 0; i--) { if (Agent.history[i].role === 'activity') { rec = Agent.history[i]; break; } }
        Agent.poll(rec, Agent.pollingTaskId);
      } else Bus.emit('agent');
    });
  }

  // Recovery events are observable: show why SI is attempting a stall abort, without exposing prompts or reasoning.
  if (Bridge.on) Bridge.on('opencode.task.recovery', function (d) {
    if (!d || !Agent.session || String(d.sessionId || '') !== String(Agent.session.id || '')) return;
    var rec = Agent.activeActivity || Agent.ensureActiveActivity();
    if (!rec) return;
    if (!rec.progress) rec.progress = [];
    rec.progress.push({
      kind: 'activity-signal', signal: 'stall-recovery',
      label: d.phase === 'ABORT_REQUESTED' ? 'Recovering stalled agent' : 'Agent recovery',
      detail: String(d.reason || 'The agent stopped producing session updates.') +
        ' Silent for ' + Math.round((Number(d.silentForMs) || 0) / 1000) + 's; threshold ' +
        Math.round((Number(d.thresholdMs) || 0) / 1000) + 's.',
      state: 'running', time: Date.now()
    });
    Bus.emit('agent');
  });

  // Reasoning tokens are never exposed. Their arrival becomes a concise live status so the
  // activity page can show that generation is active instead of staying blank on "Thinking".
  if (Bridge.on) Bridge.on('opencode.progress.activity', function (d) {
    if (!d || !Agent.session || String(d.sessionId || '') !== String(Agent.session.id || '') || Agent.status !== 'working') return;
    var rec = Agent.activeActivity || Agent.ensureActiveActivity();
    if (!rec) return;
    if (!rec.progress) rec.progress = [];
    var signal = rec.progress.filter(function (e) { return e && e.kind === 'activity-signal' && e.signal === 'reasoning'; })[0];
    if (!signal) {
      signal = { kind: 'activity-signal', signal: 'reasoning', label: 'Analyzing request', detail: 'OpenCode is actively generating a response. Private reasoning text is hidden; public progress summaries, file edits and commands will appear here.', state: 'running', time: Date.now() };
      rec.progress.push(signal);
    }
    signal.time = Number(d.time) || Date.now();
    signal.state = 'running';
    rec.phase = 'acting';
    Bus.emit('agent');
  });

  // Live stream of ordinary assistant text deltas from OpenCode's event API. This deliberately
  // ignores reasoning fields: only public text that OpenCode would show as assistant output is streamed.
  if (Bridge.on) Bridge.on('opencode.progress.delta', function (d) {
    if (!d || !Agent.session || String(d.sessionId || '') !== String(Agent.session.id || '') || Agent.status !== 'working') return;
    var rec = Agent.activeActivity || Agent.ensureActiveActivity();
    if (!rec) return;
    var key = String(d.messageId || '') + ':' + String(d.partId || '');
    if (!rec.streamParts) rec.streamParts = Object.create(null);
    if (!rec.streamGate) rec.streamGate = Object.create(null);
    rec.streamParts[key] = (rec.streamParts[key] || '') + String(d.delta || '');

    // Fail closed: the event endpoint can label internal analysis-like text as an ordinary
    // text part on some server/model combinations. Only stream text explicitly authored as
    // a user-facing progress update. Buffer until the prefix is fully verified; never briefly
    // render unclassified tokens and never fall back to displaying an unmarked part.
    var raw = rec.streamParts[key];
    var trimmed = raw.replace(/^\s+/, '');
    var prefix = 'Progress update:';
    if (rec.streamGate[key] === undefined) {
      if (prefix.toLowerCase().indexOf(trimmed.toLowerCase()) === 0 && trimmed.length < prefix.length) return;
      if (trimmed.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()) rec.streamGate[key] = true;
      else rec.streamGate[key] = false;
    }
    if (rec.streamGate[key] !== true) return;

    // Keep one live card per verified public progress message; token deltas update in place.
    var label = 'Progress update';
    var live = (rec.progress || []).filter(function (e) { return e && e.kind === 'stream' && e.streamKey === key; })[0];
    if (!rec.progress) rec.progress = [];
    if (!live) {
      live = { kind: 'stream', streamKey: key, label: label, detail: '', state: 'running', time: Date.now() };
      rec.progress.push(live);
    }
    live.detail = trimmed.slice(prefix.length).replace(/^\s+/, '');
    live.time = Date.now();
    (rec.progress || []).forEach(function (e) {
      if (e && e.kind === 'activity-signal' && e.signal === 'reasoning') {
        e.state = 'done';
        e.label = 'Analysis update received';
        e.detail = 'OpenCode has started sending public assistant text below.';
      }
    });
    rec.phase = 'acting';
    Agent.activity = rec.steps || [];
    Bus.emit('agent');
  });

  /* ---------- AI screen ---------- */
  var TOOL_LABEL = { read: 'Read', write: 'Write', search: 'Search', run: 'Run' };
  var PROMPTS = ['Guard against invalid time steps', 'Add a test for lerp', 'Update the README'];
  // Reusable, review-oriented task starters. These populate the composer; they never auto-send.
  var TASK_TEMPLATES = [
    { title: 'Fix a bug', text: 'Investigate this bug before changing code. Reproduce it, identify the root cause, implement the smallest safe fix, and run relevant tests. Report files changed and test results.\n\nBug: ' },
    { title: 'Add a feature', text: 'Inspect the existing architecture first. Implement this feature consistently with current patterns, add or update tests, and run the relevant checks. Do not rewrite unrelated code. Summarize files changed and verification results.\n\nFeature: ' },
    { title: 'Review code', text: 'Review this project for correctness, security, and maintainability. Do not modify files yet. List findings by severity with file paths and line references, explain impact, and suggest fixes.\n\nFocus: ' },
    { title: 'Write tests', text: 'Inspect the implementation and existing test conventions. Add focused tests for expected behavior, edge cases, and failure paths. Do not change production code unless a test exposes a clear bug; explain any such change. Run the relevant tests and report actual results.\n\nTarget: ' },
    { title: 'Prepare release', text: 'Perform a release-readiness review. Check version consistency, build/assets, tests, documentation, and known risks. Do not publish or push anything. Run available checks and report each as passed, failed, or not run.\n\nRelease notes/context: ' }
  ];
  var CUSTOM_TEMPLATE_KEY = 'agent-custom-task-templates-v1';
  function customTaskTemplates() {
    var items = Persist.get(CUSTOM_TEMPLATE_KEY, []);
    if (!Array.isArray(items)) return [];
    return items.filter(function (x) { return x && typeof x.title === 'string' && typeof x.text === 'string'; })
      .slice(0, 20).map(function (x) { return { title: x.title.slice(0, 60), text: x.text.slice(0, 4000), custom: true }; });
  }
  function saveCustomTaskTemplates(items) { Persist.set(CUSTOM_TEMPLATE_KEY, items.slice(0, 20)); }

  function errActions(msg, isLast) {
    if (!isLast) return [];
    var e = msg.err, out = [];
    var code = String(msg.code || '');
    // When the persistent OpenCode banner above the chat is already showing this same
    // startup/setup failure with its own Retry/Details, do not repeat those two buttons
    // here. The message text and "project files are safe" line still render; only the
    // second, redundant action pair is suppressed. Any other error category is unaffected.
    var bannerShowingSameState = (e.category === 'SERVER' || e.category === 'SETUP') &&
      OpenCode.status && OpenCode.status.state !== 'READY';
    if (e.category === 'SETUP' && !bannerShowingSameState) out.push(h('button', { class: 'btn small primary', onclick: function () { OpenCode.setupSheet(); } }, 'Open setup'));
    if ((e.category === 'SERVER' || e.category === 'SETUP') && !bannerShowingSameState) out.push(h('button', { class: 'btn small', onclick: function () { OpenCode.ensure(true); } }, 'Retry start'), h('button', { class: 'btn small', onclick: OpenCode.openSheet }, 'Details'));
    else if (e.domain === 'provider') {
      out.push(h('button', { class: 'btn small primary', onclick: OpenCode.modelSheet }, 'Change model'));
    } else {
      out.push(h('button', { class: 'btn small primary', onclick: function () { Router.setTab('health'); Health.run(); } }, 'Diagnose'));
    }
    return out;
  }

  function renderReply(text) {
    if (!g.ReplyRenderer || typeof g.ReplyRenderer.renderReply !== 'function') {
      throw new Error('Reply renderer module was not loaded');
    }
    return g.ReplyRenderer.renderReply(text);
  }

  function render(el) {
    var list = h('div', { class: 'chat-list', role: 'log', 'aria-live': 'polite' });
    var banner = h('div', { class: 'chat-banner' });
    var head = h('div', { class: 'chat-head' });
    var modeNote = h('p', { class: 'note mode-note' });
    var dock = h('div', { class: 'chat-dock' });
    var input = h('textarea', { class: 'chat-input', rows: 1, placeholder: 'Reply to OpenCode…', enterkeyhint: 'send', 'aria-label': 'Message to the agent' });
    var sendBtn = h('button', { class: 'btn primary icon-btn', 'aria-label': 'Send', title: 'Send (Ctrl/\u2318 + Enter)' });
    // Composer tools menu: folds Task templates / Permissions / Usage-cost into one
    // overflow button instead of three permanently-visible labeled buttons, so the
    // chat list gets the vertical space back. None of the three actions themselves
    // changed; they are only reached one tap deeper now.
    var toolsMenuBtn = h('button', { class: 'icon-btn flat composer-tools-btn', type: 'button', 'aria-label': 'More tools', title: 'Task templates, permissions, usage and cost', onclick: function () {
      var sheet = UI.sheet({ title: 'Tools', body: h('div', { class: 'menu-list' },
        h('button', { class: 'menu-item', type: 'button', onclick: function () { sheet.close(); openTaskTemplates(); } }, h('span', { class: 'ico-wrap' }, UI.icon('file', 20)), 'Task templates'),
        h('button', { class: 'menu-item', type: 'button', onclick: function () { sheet.close(); openPermissionModes(); } }, h('span', { class: 'ico-wrap' }, UI.icon('shield', 20)), 'Permissions'),
        h('button', { class: 'menu-item', type: 'button', onclick: function () { sheet.close(); openUsage(); } }, h('span', { class: 'ico-wrap' }, UI.icon('report', 20)), 'Usage / cost')
      ) });
    } }, UI.icon('more', 18));

    function openPermissionModes() {
      var modes = [
        { id: 'ask-each-time', name: 'Ask each time', detail: 'Confirm before every new agent task.' },
        { id: 'allow-project', name: 'Allow within project', detail: 'Require the server workspace to follow the open project.' },
        { id: 'full-auto', name: 'Full-auto', detail: 'No extra task confirmation; OpenCode server permissions still apply.' }
      ];
      var body = h('div', { class: 'menu-list' }, modes.map(function (m) {
        var selected = Agent.permissionMode === m.id;
        return h('button', { class: 'menu-item' + (selected ? ' on' : ''), type: 'button', 'aria-pressed': selected ? 'true' : 'false', onclick: function () {
          Bridge.setPermissionMode(m.id).then(function () { Agent.permissionMode = m.id; Agent.permissionModeLoaded = true; UI.toast('Permission mode: ' + m.name); sheet.close(); })
            .catch(function (e) { UI.toast(e.message || 'Could not save permission mode', 'bad'); });
        } }, h('span', { class: 'ico-wrap' }, UI.icon(selected ? 'check-circle' : 'circle', 20)),
          h('span', { class: 'menu-item-copy' }, h('strong', null, m.name), h('small', null, m.detail)),
          selected ? h('span', { class: 'permission-selected' }, 'Selected') : null);
      }), h('p', { class: 'muted' }, 'This controls task submission and SI bridge safeguards. OpenCode server tool permissions remain authoritative.'),
        h('button', { class: 'btn small', type: 'button', onclick: function () { sheet.close(); openAuditLog(); } }, 'View command audit log'));
      var sheet = UI.sheet({ title: 'Permission mode', body: body });
    }
    function openAuditLog() {
      Bridge.getCommandAuditLog().then(function (rows) {
        rows = Array.isArray(rows) ? rows.slice().reverse() : [];
        var body = h('div', { class: 'audit-log' }, rows.length ? rows.map(function (r) {
          var when = r.at ? new Date(r.at).toLocaleString() : 'Unknown time';
          return h('div', { class: 'audit-log-row' }, h('strong', null, String(r.action || 'Action') + ' · ' + String(r.outcome || 'unknown')),
            h('small', null, when + (r.project ? ' · ' + r.project : '')),
            r.detail ? h('p', { class: 'muted' }, String(r.detail)) : null);
        }) : [h('p', { class: 'muted' }, 'No audited actions yet.')],
          h('p', { class: 'muted' }, 'Local audit history is capped at 200 entries and excludes command text, prompts, secrets, and file contents.'));
        UI.sheet({ title: 'Command audit log', body: body });
      }).catch(function (e) { UI.toast(e.message || 'Audit log unavailable', 'bad'); });
    }
    function openUsage() {
      var sid = Agent.session && Agent.session.id;
      if (!sid) { UI.toast('Start a task to view provider usage', 'bad'); return; }
      Bridge.agentUsage(sid).then(function (u) {
        var cost = u.hasReportedCost ? String(u.reportedCost) : 'Not reported by this OpenCode server';
        var body = h('div', { class: 'usage-summary' },
          h('p', null, h('strong', null, 'Input tokens: '), String(u.inputTokens || 0)),
          h('p', null, h('strong', null, 'Output tokens: '), String(u.outputTokens || 0)),
          h('p', null, h('strong', null, 'Reasoning tokens: '), String(u.reasoningTokens || 0)),
          h('p', null, h('strong', null, 'Cache read / write: '), String(u.cacheReadTokens || 0) + ' / ' + String(u.cacheWriteTokens || 0)),
          h('p', null, h('strong', null, 'Reported cost: '), cost),
          h('p', { class: 'muted' }, 'Values come from provider/OpenCode message metadata. Missing cost is shown as unavailable; no guessed prices are used.'));
        UI.sheet({ title: 'Session usage', body: body });
      }).catch(function (e) { UI.toast(e.message || 'Usage unavailable', 'bad'); });
    }

    function openTaskTemplates() {
      function fillComposer(text) {
        input.value = text;
        input.focus();
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
      }
      function editCustomTemplate(existing, index) {
        var titleInput = h('input', { class: 'input', maxlength: '60', placeholder: 'Template name', value: existing ? existing.title : '', 'aria-label': 'Template name' });
        var textInput = h('textarea', { class: 'input', rows: 7, maxlength: '4000', placeholder: 'Prompt text. Use a short description and leave a place for the task details.', 'aria-label': 'Template prompt' });
        textInput.value = existing ? existing.text : '';
        var editor = UI.sheet({
          title: existing ? 'Edit custom template' : 'Create custom template',
          body: h('div', { class: 'task-template-editor' },
            h('label', { class: 'field' }, h('span', null, 'Name'), titleInput),
            h('label', { class: 'field' }, h('span', null, 'Prompt'), textInput),
            h('p', { class: 'muted' }, 'Stored locally on this device. Selecting a template only fills the composer; it does not send a message.')
          ),
          actions: [
            { label: 'Cancel', kind: 'ghost' },
            { label: 'Save template', kind: 'primary', keepOpen: true, onClick: function () {
              var title = titleInput.value.trim(), text = textInput.value.trim();
              if (!title || !text) { UI.toast('Enter both a name and prompt', 'bad'); return Promise.resolve(); }
              var items = customTaskTemplates();
              if (index == null && items.length >= 20) { UI.toast('You can save up to 20 custom templates', 'bad'); return Promise.resolve(); }
              var item = { title: title.slice(0, 60), text: text.slice(0, 4000) };
              if (index == null) items.push(item); else items[index] = item;
              saveCustomTaskTemplates(items);
              UI.toast('Template saved');
              editor.close();
              openTaskTemplates();
            } }
          ]
        });
      }
      var customs = customTaskTemplates();
      var body = h('div', { class: 'menu-list task-template-list' },
        h('p', { class: 'muted' }, 'Choose a starter. It fills the message box; nothing is sent until you press Send.'),
        TASK_TEMPLATES.map(function (t) {
          return h('button', { class: 'menu-item', type: 'button', onclick: function () {
            fillComposer(t.text);
            sheet.close();
          } }, h('span', { class: 'ico-wrap' }, UI.icon('file-text', 20)), t.title);
        }),
        customs.length ? h('p', { class: 'muted task-template-section' }, 'Your templates') : null,
        customs.map(function (t, index) {
          return h('div', { class: 'task-template-custom' },
            h('button', { class: 'menu-item task-template-use', type: 'button', onclick: function () { fillComposer(t.text); sheet.close(); } }, h('span', { class: 'ico-wrap' }, UI.icon('file-text', 20)), t.title),
            h('button', { class: 'icon-btn flat', type: 'button', 'aria-label': 'Edit ' + t.title, title: 'Edit template', onclick: function () { sheet.close(); editCustomTemplate(t, index); } }, UI.icon('edit', 16)),
            h('button', { class: 'icon-btn flat', type: 'button', 'aria-label': 'Delete ' + t.title, title: 'Delete template', onclick: function () {
              UI.confirm('Delete template?', 'Delete “' + t.title + '” from this device?', 'Delete', true).then(function (ok) {
                if (!ok) return;
                var current = customTaskTemplates(); current.splice(index, 1); saveCustomTaskTemplates(current);
                sheet.close(); openTaskTemplates(); UI.toast('Template deleted');
              });
            } }, UI.icon('x', 16))
          );
        }),
        h('button', { class: 'btn small', type: 'button', disabled: customs.length >= 20, onclick: function () { sheet.close(); editCustomTemplate(null, null); } }, 'Create custom template' + (customs.length >= 20 ? ' (limit reached)' : ''))
      );
      var sheet = UI.sheet({ title: 'Task templates', body: body });
    }

    // Severity order used to pick which of the two underlying states (SI task, OpenCode
    // server) drives the single combined dot. Worse state always wins so a problem on
    // either side is never hidden behind a calmer-looking dot from the other side.
    var TONE_RANK = { ok: 0, warning: 1, failed: 2 };
    var headerControlsCollapsed = false;
    function drawHead() {
      var st = Agent.status;
      head.innerHTML = '';
      var siTone = st === 'working' ? 'warning' : st === 'error' ? 'failed' : 'ok';
      var siLabel = st === 'working' ? 'working' : st === 'error' ? 'needs attention' : 'idle';
      var ocTone = OpenCode.tone();
      var ocLabel = OpenCode.label();
      // Health results are real probe results from Health.run(), not inferred from OpenCode READY.
      // A healthy local server can coexist with a failed network/provider check.
      var health = State.health || { status: 'unknown', checks: [] };
      var failedChecks = (health.checks || []).filter(function (c) { return c && c.status && c.status !== 'ok'; });
      var networkCheck = failedChecks.find(function (c) { return /network|internet|connectivity/i.test((c.key || '') + ' ' + (c.name || '')); });
      var healthFailure = health.status === 'failed' || health.status === 'warning';
      var combinedTone = TONE_RANK[ocTone] > TONE_RANK[siTone] ? ocTone : siTone;
      var statusSummary = siLabel + ' \u00b7 ' + ocLabel.toLowerCase();
      if (networkCheck) { combinedTone = networkCheck.status === 'failed' ? 'failed' : (combinedTone === 'failed' ? 'failed' : 'warning'); statusSummary = siLabel + ' \u00b7 Network ' + (networkCheck.status === 'failed' ? 'failed' : 'warning'); }
      else if (healthFailure && failedChecks.length) { combinedTone = health.status === 'failed' ? 'failed' : (combinedTone === 'failed' ? 'failed' : 'warning'); statusSummary = siLabel + ' \u00b7 ' + (failedChecks[0].name || 'Health check') + (health.status === 'failed' ? ' failed' : ' warning'); }
      // Keep the status row and controls row as two explicit elements. A real hidden
      // attribute on the controls row is more reliable in Android WebView than relying
      // on a descendant selector to hide several grid children.
      var projectName = (State.project && State.project.name) || '';
      var statusButton = h('button', {
        class: 'chip chip-btn status-head-chip', type: 'button',
        'aria-label': (headerControlsCollapsed ? 'Expand' : 'Collapse') + ' controls. Status: SI task ' + siLabel + ', OpenCode ' + ocLabel + (healthFailure ? ', health check failed or warning' : ''),
        'aria-expanded': headerControlsCollapsed ? 'false' : 'true',
        onclick: function (event) {
          if (event && event.preventDefault) event.preventDefault();
          headerControlsCollapsed = !headerControlsCollapsed;
          drawHead();
        }
      }, UI.dot(combinedTone),
        h('span', { class: 'status-head-chip-text' },
          projectName ? h('strong', {}, projectName) : null,
          (projectName ? ' \u00b7 ' : '') + statusSummary),
        UI.icon('chevron', 16));
      var controlsRow = h('div', { class: 'chat-controls-row' });
      controlsRow.hidden = headerControlsCollapsed;
      controlsRow.appendChild(h('button', { class: 'chip chip-btn model-chip', type: 'button', 'aria-label': 'Model', onclick: OpenCode.modelSheet }, OpenCode.modelLabel()));
      var chatBusy = Agent.status === 'working' || !!(Agent.session && Agent.session.status === 'running');
      controlsRow.appendChild(h('button', {
        class: 'icon-btn flat restart-chat-btn', type: 'button',
        'aria-label': 'Restart chat',
        title: chatBusy ? 'Finish or stop the current task before restarting the chat' : 'Start a fresh chat without deleting project files',
        disabled: chatBusy,
        onclick: function () {
          UI.confirm('Restart chat?', 'Start a fresh conversation for this project? The current conversation will be cleared from this screen. Project files and the saved task archive will not be deleted.', 'Restart chat', false).then(function (ok) {
            if (!ok) return;
            Agent.restartChat().catch(function (e) { UI.toast(e && e.message ? e.message : 'Could not restart chat', 'bad'); });
          });
        }
      }, UI.icon('refresh', 18)));
      controlsRow.appendChild(h('div', { class: 'seg-ctl mode-ctl', role: 'group', 'aria-label': 'Agent mode for the next message' },
        [['build', 'Build'], ['plan', 'Plan']].map(function (o) {
          return h('button', {
            class: 'seg-opt' + (Agent.mode === o[0] ? ' on' : ''),
            'aria-pressed': Agent.mode === o[0] ? 'true' : 'false',
            disabled: Agent.status === 'working' || (o[0] === 'plan' && Agent.planUnavailable),
            title: o[0] === 'plan' && Agent.planUnavailable ? 'Plan agent is not available on this OpenCode server' : '',
            onclick: function () { setMode(o[0]); drawHead(); }
          }, o[1]);
        })));
      head.appendChild(statusButton);
      head.appendChild(controlsRow);
      head.classList.toggle('controls-collapsed', headerControlsCollapsed);
      var plan = Agent.mode === 'plan';
      modeNote.hidden = !plan;
      if (plan) modeNote.textContent = 'Plan mode sends the next message to the server\u2019s Plan agent. Availability depends on the agents configured in your OpenCode server.';
      else if (Agent.planUnavailable) { modeNote.hidden = false; modeNote.textContent = 'Plan mode is unavailable because this OpenCode server does not expose a Plan agent. Build remains available.'; }
    }

    function drawBanner() {
      banner.innerHTML = '';
      var oc = OpenCode.status, ocBusy = { CHECKING_TERMUX: 1, CHECKING_SERVER: 1, STARTING_SERVER: 1, WAITING_FOR_HEALTH: 1, RESTARTING: 1, STOPPING: 1 };
      if (oc.state !== 'READY') {
        var acts = [];
        if (oc.state === 'NOT_CONFIGURED') acts.push(h('button', { class: 'btn primary', onclick: function () { OpenCode.setupSheet(); } }, 'Set up'));
        else if (!ocBusy[oc.state]) acts.push(h('button', { class: 'btn primary', onclick: function () { OpenCode.ensure(true); } }, 'Retry'));
        banner.appendChild(h('div', { class: 'resume' }, h('strong', null, 'OpenCode: ' + OpenCode.label()), h('p', { class: 'muted' }, oc.message || ''), h('div', { class: 'row' }, acts)));
      }
      if (!Agent.canResume) return;
      var s = Agent.session;
      banner.appendChild(h('div', { class: 'resume' },
        h('strong', null, s.status === 'cancelled' ? 'Task stopped' : s.status === 'uncertain' ? 'Outcome unknown' : 'Session interrupted'),
        h('p', { class: 'muted' }, s.task),
        h('ul', { class: 'ckpt' }, s.steps.map(function (st, i) {
          return h('li', { class: i < s.stepsDone ? 'done' : (i === s.stepsDone ? 'next' : '') }, (i < s.stepsDone ? '\u2713 ' : i === s.stepsDone ? '\u26a0 ' : '\u2022 ') + TOOL_LABEL[st.tool] + ' ' + st.arg);
        })),
        h('button', { class: 'btn primary', onclick: function () { Agent.resume(); } }, s.status === 'uncertain' ? 'Continue session' : 'Resume')
      ));
    }

    var PHASE_LABEL = { thinking: 'Thinking', done: 'Completed', failed: 'Failed', cancelled: 'Cancelled', uncertain: 'Outcome unknown' };
    var STEP_VERB = { read: 'Reading', write: 'Editing', search: 'Searching', run: 'Running' };

    /* The one-line summary shown collapsed: real tool+arg while a step is in flight, or the phase's
       terminal label. Never a percentage, never a step that hasn't actually started. */
    // Older app versions persisted unverified raw text in stream events. Hide those records
    // after upgrade too; only newly gated, explicitly marked public progress updates are safe.
    function isSafeActivityEvent(e) {
      return !e || e.kind !== 'stream' || (e.label === 'Progress update' && typeof e.detail === 'string');
    }
    // Only the top/collapsed activity headline is compact. Keep its first sentence,
    // then add three dots when more text exists. The expanded activity cards below
    // must retain their original full, multiline details and command output.
    function oneLineProgress(value) {
      var text = String(value || '').replace(/\s+/g, ' ').trim();
      if (!text) return '';
      var match = text.match(/^.*?[.!?](?=\s|$)/);
      if (match && match[0].length < text.length) return match[0].trim() + '...';
      return text;
    }
    function activityHeadline(rec) {
      // Do not leave users staring at a vague 'Thinking' label when the server has not
      // emitted a public event yet. Show an honest high-level phase, never private reasoning.
      if (rec.phase === 'thinking') return 'Analyzing request';
      if (rec.phase === 'acting') {
        var events = (Array.isArray(rec.progress) ? rec.progress : []).filter(isSafeActivityEvent);
        var currentEvent = events.slice().reverse().filter(function (e) { return e.state === 'running'; })[0] || events[events.length - 1];
        if (currentEvent && currentEvent.label) return currentEvent.label + (currentEvent.kind === 'activity-signal' ? '' : (currentEvent.detail ? ' · ' + oneLineProgress(currentEvent.detail) : ''));
        var running = rec.steps.filter(function (s) { return s.state === 'running'; })[0];
        var cur = running || rec.steps[rec.steps.length - 1];
        if (!cur) return 'Thinking';
        var verb = running ? STEP_VERB[cur.tool] : (cur.state === 'failed' ? STEP_VERB[cur.tool] + ' failed' : STEP_VERB[cur.tool]);
        return verb + (cur.arg ? ' \u00b7 ' + cur.arg : '');
      }
      return PHASE_LABEL[rec.phase] || 'Working';
    }

    var activityDetail = null;
    function elapsedLabel(rec) {
      var seconds = Math.max(0, Math.floor((Date.now() - (rec.startedAt || rec.ts || Date.now())) / 1000));
      var minutes = Math.floor(seconds / 60); seconds %= 60;
      return minutes ? minutes + 'm ' + seconds + 's elapsed' : seconds + 's elapsed';
    }
    function renderActivityDetailBody(rec, body) {
      if (!body || !rec) return;
      // Progress events arrive frequently while the activity sheet is open. Rebuilding the
      // whole body used to reset <details open> and send the sheet back to scrollTop=0 on
      // every event, making Command output impossible to keep expanded/read. Preserve the
      // user's disclosure and scroll state across this refresh.
      var scrollHost = body.closest ? body.closest('.sheet-body') : null;
      var savedScrollTop = scrollHost ? scrollHost.scrollTop : 0;
      var savedDetails = [];
      var oldDetails = body.querySelectorAll ? body.querySelectorAll('details.activity-event-output') : [];
      for (var di = 0; di < oldDetails.length; di++) {
        var oldPre = oldDetails[di].querySelector('pre');
        savedDetails.push({ open: oldDetails[di].open, preScrollTop: oldPre ? oldPre.scrollTop : 0 });
      }
      body.innerHTML = '';
      var live = rec.phase === 'thinking' || rec.phase === 'acting';
      body.appendChild(h('div', { class: 'activity-detail-status' },
        h('span', { class: 'activity-dot ' + (live ? 'running' : rec.phase === 'failed' ? 'failed' : 'done') }),
        h('strong', null, activityHeadline(rec)),
        h('span', { class: 'activity-detail-elapsed' }, elapsedLabel(rec))));
      body.appendChild(h('p', { class: 'activity-detail-caption' }, 'Live OpenCode activity: a live analysis status, public assistant progress summaries, file edits, commands and real output. Private internal reasoning text is never displayed.'));
      // Drop unsafe stream cards persisted by earlier app versions, as well as unmarked
      // stream content that may have been misclassified by the server's event endpoint.
      var events = (Array.isArray(rec.progress) ? rec.progress.slice() : []).filter(isSafeActivityEvent);
      // If an older server build has no event feed yet, still show its real tool status.
      if (!events.length) events = (rec.steps || []).filter(function (st) { return st.tool !== 'read'; }).map(function (st) {
        return { label: st.tool === 'write' ? 'Editing code' : 'Running command', detail: st.arg || '', state: st.state, kind: 'tool' };
      });
      if (!events.length) {
        if (live) {
          // Honest fallback when the server has not emitted public text/tool events yet. This is
          // a status summary, not fabricated model reasoning; replace it automatically once a
          // real progress update, command, edit, or other visible event arrives.
          var hasReadStep = (rec.steps || []).some(function (st) { return st && st.tool === 'read' && st.state === 'running'; });
          body.appendChild(h('section', { class: 'activity-event running activity-event-fallback' },
            h('div', { class: 'activity-event-head' }, h('span', { class: 'activity-row-dot' }, ''), h('strong', null, hasReadStep ? 'Reviewing project files' : 'Analyzing request')),
            h('pre', { class: 'activity-event-detail' }, hasReadStep
              ? 'OpenCode is reviewing project context. File-read details are summarized; public progress updates, commands, and edits will appear here as they occur.'
              : 'OpenCode is processing your request. No public progress update or tool event has arrived yet. This is a high-level status, not private internal reasoning. Public updates, commands, and file changes will replace this message when received. If it stays here for a long time, the event stream may be unavailable or the task may be stalled.')
          ));
        } else body.appendChild(h('div', { class: 'activity-detail-empty' }, 'No visible work events were returned for this task.'));
      }
      events.forEach(function (ev) {
        var state = ev.state === 'done' || ev.state === 'completed' ? 'done' : ev.state === 'failed' || ev.state === 'error' ? 'failed' : 'running';
        var card = h('section', { class: 'activity-event ' + state },
          h('div', { class: 'activity-event-head' }, h('span', { class: 'activity-row-dot' }, state === 'done' ? '\u2713' : state === 'failed' ? '\u2717' : ''), h('strong', null, ev.label || ev.tool || 'Activity'), ev.time ? h('time', null, new Date(ev.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })) : null),
          // Do not compact or truncate the lower expanded detail cards. Only the top
          // headline uses oneLineProgress(); this content remains full and multiline.
          ev.detail ? h('pre', { class: 'activity-event-detail' }, ev.detail) : null,
          ev.code ? h('details', { class: 'activity-event-output activity-event-code' }, h('summary', null, 'Code / patch'), h('pre', null, ev.code)) : null,
          ev.output ? h('details', { class: 'activity-event-output', open: state === 'running' }, h('summary', null, 'Command output'), h('pre', null, ev.output)) : null,
          ev.error ? h('pre', { class: 'activity-event-error' }, ev.error) : null);
        body.appendChild(card);
      });
      if (rec.notice) body.appendChild(h('div', { class: 'activity-notice', role: 'status' }, rec.notice));
      if (rec.phase === 'failed' && rec.error) body.appendChild(h('div', { class: 'activity-event-error' }, rec.error));
      var newDetails = body.querySelectorAll ? body.querySelectorAll('details.activity-event-output') : [];
      for (var ri = 0; ri < newDetails.length && ri < savedDetails.length; ri++) {
        newDetails[ri].open = savedDetails[ri].open;
        var newPre = newDetails[ri].querySelector('pre');
        if (newPre) newPre.scrollTop = savedDetails[ri].preScrollTop;
      }
      if (scrollHost) {
        // Restore after the DOM has recalculated its height; the timeout fallback supports
        // older Android WebViews that do not expose requestAnimationFrame consistently.
        var restoreSheetScroll = function () { if (scrollHost.isConnected) scrollHost.scrollTop = savedScrollTop; };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restoreSheetScroll);
        else setTimeout(restoreSheetScroll, 0);
      }
    }
    function openActivityDetail(rec) {
      activityDetail = { rec: rec, body: h('div', { class: 'activity-detail-page' }) };
      renderActivityDetailBody(rec, activityDetail.body);
      var sheet = UI.sheet({ title: 'Task activity', body: activityDetail.body, onClose: function () { activityDetail = null; } });
      sheet.el.classList.add('activity-detail-wrap');
    }

    function renderActivity(rec) {
      var isLive = rec.phase === 'thinking' || rec.phase === 'acting';
      var dotClass = rec.phase === 'failed' ? 'failed' : rec.phase === 'done' ? 'done' : (isLive ? 'running' : 'idle');
      var head = h('button', {
        class: 'activity-head', 'aria-expanded': rec.expanded ? 'true' : 'false',
        onclick: function () { openActivityDetail(rec); }
      },
        h('span', { class: 'activity-dot ' + dotClass }),
        h('span', { class: 'activity-text' }, activityHeadline(rec)),
        h('span', { class: 'activity-chevron' }, UI.icon('chevron', 16))
      );
      var card = h('div', { class: 'activity-card' + (rec.expanded ? ' open' : '') }, head);
      return card;
    }

    /* Structured "task finished" card: Summary / Changes / Verification, built ONLY from fields the real action
       log actually produced. Verification only appears when a run step actually happened (we show what ran and
       whether that specific step succeeded -- never a fabricated "tests passed"). */
    function renderOutcome(m, isLast) {
      var files = m.changedPaths || [];
      var ranSteps = (m.ranSteps || []).filter(function (s) { return s.tool === 'run'; });
      var parts = [h('div', { class: 'outcome-title' }, h('span', { class: 'outcome-mark', 'aria-hidden': 'true' }, '\u2713'), h('span', { class: 'outcome-heading' }, files.length || (m.summaryLines || []).length ? 'Task completed' : 'Task summary'), h('span', { class: 'outcome-status' }, 'Complete'))];
      if (m.summaryLines && m.summaryLines.length) {
        parts.push(h('div', { class: 'outcome-section' },
          h('div', { class: 'outcome-label' }, 'Changes made'),
          h('ul', { class: 'plain' }, m.summaryLines.map(function (l) { return h('li', null, l); }))));
      }
      if (files.length) {
        parts.push(h('div', { class: 'outcome-section' },
          h('div', { class: 'outcome-label' }, 'Files changed'),
          h('ul', { class: 'plain' }, files.map(function (p) { return h('li', null, h('button', { class: 'file-open-link', title: 'Open file', onclick: function () { if (g.Files && Files.openPath) Files.openPath(p); else { Router.setTab('files'); UI.toast('Select this file in the file tree to open it.'); } } }, h('code', null, p))); }))));
      }
      if (ranSteps.length) {
        parts.push(h('div', { class: 'outcome-section' },
          h('div', { class: 'outcome-label' }, 'Verification'),
          h('ul', { class: 'plain' }, ranSteps.map(function (s) { return h('li', null, (s.state === 'done' ? '\u2713 ' : s.state === 'failed' ? '\u2717 ' : '') + s.arg); }))));
      }
      var actions = [];
      if (isLast) {
        if (m.applied && Agent.lastApplied) actions.push(h('button', { class: 'btn small ghost', onclick: function () { Agent.undo(); } }, 'Undo'));
        actions.push(h('button', { class: 'btn small', onclick: function () { Router.setTab('terminal'); Terminal.exec('npm test'); } }, 'Run tests'));
        actions.push(h('button', { class: 'btn small', onclick: function () { Router.setTab('git'); } }, 'Open Git'));
      }
      if (actions.length) parts.push(h('div', { class: 'row wrap' }, actions));
      return h('div', { class: 'outcome-card' }, parts);
    }

    // The active activity card is rendered in a fixed activity dock above the composer,
    // not inline in the scrollable transcript. This keeps it visible even when the user has
    // many messages or changes Android display size/DPI.
    var activityDock = h('div', { class: 'active-activity-dock', 'aria-live': 'polite' });
    var lastHist = null, lastHistLength = -1, lastLiveRec = null, lastLiveNode = null;

    function drawActiveDock(rec) {
      activityDock.innerHTML = '';
      if (Agent.status === 'working' && rec && (rec.phase === 'thinking' || rec.phase === 'acting')) {
        activityDock.appendChild(renderActivity(rec));
      }
    }

    // While a task is running, keep the transcript bubble for the current assistant turn compact.
    // The live text belongs in the expandable "Live assistant update" activity card; duplicating the
    // entire streaming response in the transcript creates a huge blue bubble and makes activity hard to follow.
    function activeTurnPreview(text) {
      var value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
      if (!value) return '';
      var match = value.match(/^(.+?[.!?])(?:\s|$)/);
      if (match) return match[1];
      return value.length > 180 ? value.slice(0, 177).trimEnd() + '…' : value;
    }

    function drawList() {
      // Recover the active record on every redraw, but render it outside the scrollable
      // transcript so it cannot be pushed above the visible viewport by later messages.
      var liveRec = Agent.status === 'working' ? Agent.ensureActiveActivity() : null;
      if (liveRec && liveRec.phase !== 'thinking' && liveRec.phase !== 'acting') liveRec = null;
      var hist = Agent.history;
      drawActiveDock(liveRec);

      // When only the active task's progress changed, the transcript itself is unchanged.
      // Update the dock and avoid rebuilding the conversation on every poll tick.
      if (Agent.status === 'working' && lastHist === hist && hist.length === lastHistLength &&
          liveRec && liveRec === lastLiveRec) {
        return;
      }

      var nearBottom = (list.scrollHeight - list.scrollTop - list.clientHeight) < 80;
      list.innerHTML = '';
      lastLiveNode = null;
      var lastErr = -1, lastUserIndex = -1;
      hist.forEach(function (m, i) {
        if (m.role === 'error') lastErr = i;
        if (m.role === 'user') lastUserIndex = i;
      });
      if (!hist.length) {
        list.appendChild(h('div', { class: 'empty' },
          h('h2', { class: 'h2' }, State.project.name),
          h('p', { class: 'muted' }, 'Describe a change. The OpenCode agent reads your code, edits files and runs commands in your project folder; what it did is listed from its own log.'),
          h('div', { class: 'prompts' }, PROMPTS.map(function (t) { return h('button', { class: 'btn small', onclick: function () { Agent.sendMessage(t); } }, t); }))
        ));
      }
      hist.forEach(function (m, i) {
        // The currently running activity is shown in activityDock, never duplicated inline.
        if (m === liveRec && Agent.status === 'working') return;
        if (m.role === 'error') { list.appendChild(UI.errorCard(m.err, errActions(m, i === lastErr && Agent.status === 'error'))); return; }
        if (m.role === 'activity') { list.appendChild(renderActivity(m)); return; }
        if (m.role === 'system') {
          if (m.summaryLines || m.changedPaths) { list.appendChild(renderOutcome(m, i === hist.length - 1)); return; }
          list.appendChild(h('div', { class: 'msg system' }, h('span', null, m.text)));
          return;
        }
        // Only the current assistant turn is compacted while streaming. The full live stream
        // remains in the single "Live assistant update" card; after completion the full reply
        // is rendered normally in the transcript.
        var displayText = m.text;
        if (Agent.status === 'working' && m.role === 'agent' && i > lastUserIndex) {
          displayText = activeTurnPreview(m.text);
        }
        list.appendChild(h('div', { class: 'msg ' + m.role },
          h('div', { class: 'bubble' },
            h('div', { class: 'bubble-head' },
              h('span', { class: 'bubble-who' }, m.role === 'user' ? 'You' : 'SI'),
              m.ts ? h('span', { class: 'bubble-time' }, new Date(m.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })) : null),
            h('div', { class: 'bubble-text' }, m.role === 'agent' ? renderReply(displayText) : m.text))));
      });
      lastHist = hist;
      lastHistLength = hist.length;
      lastLiveRec = liveRec;
      if (nearBottom) list.scrollTop = list.scrollHeight;
    }

    function drawSend() {
      sendBtn.innerHTML = '';
      var working = Agent.status === 'working';
      sendBtn.appendChild(UI.icon(working ? 'stop' : 'send', 20));
      sendBtn.setAttribute('aria-label', working ? 'Stop' : 'Send');
      sendBtn.classList.toggle('danger', working);
    }

    function submit() {
      if (Agent.status === 'working') { Agent.cancel(); return; }
      var t = input.value.trim();
      if (!t) return;
      input.value = '';
      input.style.height = '';
      Agent.sendMessage(t);
    }
    sendBtn.addEventListener('click', submit);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } });
    input.addEventListener('input', function () { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 120) + 'px'; });

    function setMode(m) {
      if (Agent.status === 'working' || Agent.mode === m) return;
      Agent.mode = m;
      UI.toast(m === 'plan'
        ? 'Plan mode: the next message goes to OpenCode\u2019s plan agent (it plans rather than editing).'
        : 'Build mode: OpenCode\u2019s default agent may change your project.');
    }

    function redraw() {
      drawHead(); drawBanner(); drawList(); drawSend();
      if (activityDetail) renderActivityDetailBody(activityDetail.rec, activityDetail.body);
    }

    dock.appendChild(activityDock);
    dock.appendChild(h('div', { class: 'composer' }, toolsMenuBtn, input, sendBtn));
    el.appendChild(h('div', { class: 'chat' }, head, modeNote, banner, list, dock));
    redraw();

    var offs = [
      Bus.on('agent', redraw),
      Bus.on('opencode', function () { drawHead(); drawBanner(); }),
      Bus.on('state', function (p) { if (p && (p.health || p.project)) drawHead(); })
    ];
    return function () { offs.forEach(function (f) { f(); }); };
  }

  Agent.render = render;
  g.AgentInterface = AgentInterface;
  g.Agent = Agent;
})(window);

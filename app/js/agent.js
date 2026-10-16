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
  // A task may legitimately continue while Android has the screen off. Count only time
  // during which the app is foregrounded; background/suspended time must not trigger a
  // false stall cancellation when WebView timers resume. This remains a foreground safety bound.
  var TASK_STALL_TIMEOUT_MS = 5 * 60 * 1000;
  var appInBackground = false;

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
    this.planUnavailable = false; // Set only after the real server explicitly rejects the Plan agent.
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

  /* Switch to a project: restores its chat, checkpoint and pending proposal. */
  P.load = function (projectId) {
    this.runId++;
    this.key = projectId;
    this.planUnavailable = false;
    this.status = 'idle';
    this.activity = [];
    this.activeActivity = null;
    this.lastApplied = null;
    var self = this, key = projectId;
    this.session = Persist.get(this.k('session'), null);
    this.history = [];
    Persist.del(this.k('history'));                 // older builds cached the whole chat in plaintext: remove it
    Persist.del(this.k('pending'));                  // older builds persisted a review-proposal queue: remove it
    Bus.emit('agent');
    var s = this.session;
    if (s && s.id && Bridge.mode === 'native') {
      var restored = Bridge.agentHistory(s.id).then(function (msgs) {
        if (self.key !== key || self.history.length) return;
        self.history = msgs.map(function (m) { return { role: m.role, text: m.text, ts: Date.now() }; });
        Bus.emit('agent');
      }, function () { /* session gone or server down: the chat simply starts empty */ });
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

  P.push = function (msg) { msg.ts = Date.now(); this.history.push(msg); this.save(); };
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
      return !!(s && s.task && !s.resumeBlocked && (s.status === 'cancelled' || s.status === 'interrupted' || s.status === 'failed' || s.status === 'uncertain') && this.status !== 'working');
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
      self.session = { id: r.sessionId, projectId: State.project.id, task: null, steps: [], stepsDone: 0, status: 'idle', modified: [], reply: '', snapshot: null };
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
    return { role: 'activity', ts: now, startedAt: now, backgroundMs: 0, backgroundSince: appInBackground ? now : 0, phase: 'thinking', steps: [], expanded: false, error: null };
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
    if (this.status === 'working') return Promise.resolve();
    this.push({ role: 'user', text: text });
    this.status = 'working';
    this.activity = [];
    var rec = newActivity();
    this.activeActivity = rec;
    this.history.push(rec);
    var taskId = ++this.taskId;
    this.save();
    var sameProject = this.session && this.session.projectId === State.project.id && this.session.status !== 'closed';
    var ready = this.prepareWorkspace().then(function () { return sameProject ? null : self.startSession(); });
    function begin() {
      var s = self.session;
      s.task = text; s.steps = []; s.stepsDone = 0; s.status = 'running'; s.resumeBlocked = false; s.mode = self.mode; s.modified = []; s.reply = '';
      self.save();
      return Bridge.agentSend(s.id, text, self.mode);
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
    this.status = 'working';
    this.push({ role: 'system', text: 'Resuming the task.' });
    var rec = newActivity();
    this.activeActivity = rec;
    this.history.push(rec);
    var taskId = ++this.taskId;
    return this.prepareWorkspace().then(function () { return Bridge.agentResume(s.id); }).then(function () { s.status = 'running'; return self.poll(rec, taskId); })
      .catch(function (e) { self.fail(e, rec); });
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
        // A RUNNING status is authoritative: do not cancel a legitimate server task solely because
        // a wall-clock/foreground timer expired. Some providers legitimately take several minutes.
        // Keep polling and preserve the manual Stop action. Actual status API failures are handled below.
        var activeElapsed = foregroundTaskElapsed(rec, Date.now());
        if (st.state === 'RUNNING' && activeElapsed >= TASK_STALL_TIMEOUT_MS && rec && !rec.longRunningNotice) {
          rec.longRunningNotice = true;
          rec.notice = 'This task is taking longer than expected. It is still running on OpenCode; you can keep waiting or press Stop to cancel it.';
          Bus.emit('agent');
        }
        self.activity = st.steps.map(mapStep);
        if (rec) { rec.steps = self.activity; rec.phase = self.activity.length ? 'acting' : 'thinking'; self.activeActivity = rec; }
        s.steps = self.activity.map(function (a) { return { tool: a.tool, arg: a.arg }; });
        s.stepsDone = s.steps.length;
        Bus.emit('agent');
        if (st.state === 'RUNNING') return wait(1500).then(tick);
        return self.finish(st, rec);
      }, function (e) {
        // A status read can fail while the server restarts or the app was frozen: keep watching a few times before giving up.
        if (self.runId !== run) return;
        if (++fails < 6) return wait(2000).then(tick);
        throw e;
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
    if (st.reply) this.history.push({ role: 'agent', text: st.reply, ts: Date.now() });
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
    this.session = { id: id, projectId: this.key, task: null, steps: [], stepsDone: 0, status: 'idle', modified: [], reply: '', snapshot: null };
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

  /* ---------- AI screen ---------- */
  var TOOL_LABEL = { read: 'Read', write: 'Write', search: 'Search', run: 'Run' };
  var PROMPTS = ['Guard against invalid time steps', 'Add a test for lerp', 'Update the README'];

  function errActions(msg, isLast) {
    if (!isLast) return [];
    var e = msg.err, out = [];
    var code = String(msg.code || '');
    if (e.category === 'SETUP') out.push(h('button', { class: 'btn small primary', onclick: function () { OpenCode.setupSheet(); } }, 'Open setup'));
    if (e.category === 'SERVER' || e.category === 'SETUP') out.push(h('button', { class: 'btn small', onclick: function () { OpenCode.ensure(true); } }, 'Retry start'), h('button', { class: 'btn small', onclick: OpenCode.openSheet }, 'Details'));
    else if (e.domain === 'provider') {
      out.push(h('button', { class: 'btn small primary', onclick: OpenCode.modelSheet }, 'Change model'));
    } else {
      out.push(h('button', { class: 'btn small primary', onclick: function () { Router.setTab('health'); Health.run(); } }, 'Diagnose'));
    }
    return out;
  }

  /* Render model replies as readable Markdown without trusting model-provided HTML.
     All ordinary text is inserted as text nodes; only known formatting creates elements. */
  function inlineReply(parent, source) {
    var text = String(source == null ? '' : source);
    var re = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|https?:\/\/[^\s<>]+|<\/?[A-Za-z][^<>]*>)/g;
    var at = 0, match;
    while ((match = re.exec(text))) {
      if (match.index > at) parent.appendChild(document.createTextNode(text.slice(at, match.index)));
      var token = match[0], node;
      if (token.charAt(0) === '`') {
        node = document.createElement('code'); node.textContent = token.slice(1, -1);
      } else if (token.slice(0, 2) === '**' || token.slice(0, 2) === '__') {
        node = document.createElement('strong'); node.textContent = token.slice(2, -2);
      } else if (token.charAt(0) === '*' || token.charAt(0) === '_') {
        node = document.createElement('em'); node.textContent = token.slice(1, -1);
      } else if (/^https?:\/\//i.test(token)) {
        var url = token, trailing = '';
        while (/[.,!?;:)\]]$/.test(url)) { trailing = url.slice(-1) + trailing; url = url.slice(0, -1); }
        node = document.createElement('a'); node.href = url; node.textContent = url; node.target = '_blank'; node.rel = 'noopener noreferrer';
        parent.appendChild(node); if (trailing) parent.appendChild(document.createTextNode(trailing)); at = re.lastIndex; continue;
      } else {
        node = document.createElement('code'); node.className = 'inline-code'; node.textContent = token;
      }
      parent.appendChild(node); at = re.lastIndex;
    }
    if (at < text.length) parent.appendChild(document.createTextNode(text.slice(at)));
  }

  function renderReply(text) {
    var root = document.createElement('div'); root.className = 'reply-markdown';
    var lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    var paragraph = [], list = null, listType = '', codeLines = null;
    function flushParagraph() {
      if (!paragraph.length) return;
      var p = document.createElement('p'); inlineReply(p, paragraph.join(' ').trim()); root.appendChild(p); paragraph = [];
    }
    function flushList() { if (list) { root.appendChild(list); list = null; listType = ''; } }
    function flushCode() {
      var pre = document.createElement('pre'), code = document.createElement('code');
      code.textContent = codeLines.join('\n'); pre.appendChild(code); root.appendChild(pre); codeLines = null;
    }
    lines.forEach(function (line) {
      if (codeLines) { if (/^\s*```/.test(line)) flushCode(); else codeLines.push(line); return; }
      if (/^\s*```/.test(line)) { flushParagraph(); flushList(); codeLines = []; return; }
      if (!line.trim()) { flushParagraph(); flushList(); return; }
      var heading = line.match(/^\s{0,3}(#{1,4})\s+(.+)$/);
      if (heading) {
        flushParagraph(); flushList();
        var h = document.createElement('h' + Math.min(heading[1].length + 1, 5)); inlineReply(h, heading[2]); root.appendChild(h); return;
      }
      var item = line.match(/^\s*(?:[-*+]\s+|(\d+)[.)]\s+)(.*)$/);
      if (item) {
        flushParagraph();
        var type = item[1] ? 'ol' : 'ul';
        if (!list || listType !== type) { flushList(); list = document.createElement(type); listType = type; }
        var li = document.createElement('li'); inlineReply(li, item[2]); list.appendChild(li); return;
      }
      if (/^\s*[-*_]{3,}\s*$/.test(line)) { flushParagraph(); flushList(); root.appendChild(document.createElement('hr')); return; }
      flushList(); paragraph.push(line.trim());
    });
    if (codeLines) flushCode();
    flushParagraph(); flushList();
    return root;
  }

  function render(el) {
    var list = h('div', { class: 'chat-list', role: 'log', 'aria-live': 'polite' });
    var banner = h('div', { class: 'chat-banner' });
    var head = h('div', { class: 'chat-head' });
    var modeNote = h('p', { class: 'note mode-note' });
    var dock = h('div', { class: 'chat-dock' });
    var input = h('textarea', { class: 'chat-input', rows: 1, placeholder: 'Ask the agent to change something\u2026', enterkeyhint: 'send', 'aria-label': 'Message to the agent' });
    var sendBtn = h('button', { class: 'btn primary icon-btn', 'aria-label': 'Send' });

    function drawHead() {
      var st = Agent.status;
      head.innerHTML = '';
      head.appendChild(h('span', { class: 'chip' }, UI.dot(st === 'working' ? 'warning' : st === 'error' ? 'failed' : 'ok'), 'SI task \u00b7 ' + (st === 'working' ? 'working' : st === 'error' ? 'needs attention' : 'idle')));
      head.appendChild(OpenCode.chip());
      head.appendChild(h('button', { class: 'chip chip-btn', 'aria-label': 'Model', onclick: OpenCode.modelSheet }, 'Model \u00b7 ' + OpenCode.modelLabel()));
      var chatBusy = Agent.status === 'working' || !!(Agent.session && Agent.session.status === 'running');
      head.appendChild(h('button', {
        class: 'icon-btn flat restart-chat-btn',
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
      head.appendChild(h('div', { class: 'seg-ctl mode-ctl', role: 'group', 'aria-label': 'Agent mode for the next message' },
        [['build', 'Build'], ['plan', 'Plan']].map(function (o) {
          return h('button', {
            class: 'seg-opt' + (Agent.mode === o[0] ? ' on' : ''),
            'aria-pressed': Agent.mode === o[0] ? 'true' : 'false',
            disabled: Agent.status === 'working' || (o[0] === 'plan' && Agent.planUnavailable),
            title: o[0] === 'plan' && Agent.planUnavailable ? 'Plan agent is not available on this OpenCode server' : '',
            onclick: function () { setMode(o[0]); }
          }, o[1]);
        })));
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
        if (!ocBusy[oc.state]) acts.push(h('button', { class: 'btn', onclick: OpenCode.openSheet }, 'Details'));
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
    function activityHeadline(rec) {
      if (rec.phase === 'thinking') return 'Thinking';
      if (rec.phase === 'acting') {
        var running = rec.steps.filter(function (s) { return s.state === 'running'; })[0];
        var cur = running || rec.steps[rec.steps.length - 1];
        if (!cur) return 'Thinking';
        var verb = running ? STEP_VERB[cur.tool] : (cur.state === 'failed' ? STEP_VERB[cur.tool] + ' failed' : STEP_VERB[cur.tool]);
        return verb + (cur.arg ? ' \u00b7 ' + cur.arg : '');
      }
      return PHASE_LABEL[rec.phase] || 'Working';
    }

    function renderActivity(rec) {
      var isLive = rec.phase === 'thinking' || rec.phase === 'acting';
      var dotClass = rec.phase === 'failed' ? 'failed' : rec.phase === 'done' ? 'done' : (isLive ? 'running' : 'idle');
      var head = h('button', {
        class: 'activity-head', 'aria-expanded': rec.expanded ? 'true' : 'false',
        onclick: function () { rec.expanded = !rec.expanded; redraw(); }
      },
        h('span', { class: 'activity-dot ' + dotClass }),
        h('span', { class: 'activity-text' }, activityHeadline(rec)),
        h('span', { class: 'activity-chevron' }, UI.icon('chevron', 16))
      );
      var card = h('div', { class: 'activity-card' + (rec.expanded ? ' open' : '') }, head);
      if (rec.expanded) {
        var body = h('div', { class: 'activity-body' });
        if (!rec.steps.length) {
          body.appendChild(h('div', { class: 'activity-row running' }, h('span', { class: 'activity-row-dot' }), h('span', null, 'Understanding the request')));
        }
        rec.steps.forEach(function (st) {
          body.appendChild(h('div', { class: 'activity-row ' + st.state },
            h('span', { class: 'activity-row-dot' }, st.state === 'done' ? '\u2713' : st.state === 'failed' ? '\u2717' : ''),
            h('span', null, STEP_VERB[st.tool] + ' ' + st.arg)
          ));
        });
        if (rec.notice) body.appendChild(h('div', { class: 'activity-notice', role: 'status' }, rec.notice));
        if (rec.phase === 'failed' && rec.error) body.appendChild(h('div', { class: 'activity-row failed' }, h('span', { class: 'activity-row-dot' }, '\u2717'), h('span', null, rec.error)));
        card.appendChild(body);
      }
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
      var lastErr = -1;
      hist.forEach(function (m, i) { if (m.role === 'error') lastErr = i; });
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
        list.appendChild(h('div', { class: 'msg ' + m.role },
          h('div', { class: 'bubble' },
            h('div', { class: 'bubble-head' },
              h('span', { class: 'bubble-who' }, m.role === 'user' ? 'You' : 'SI'),
              m.ts ? h('span', { class: 'bubble-time' }, new Date(m.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })) : null),
            h('div', { class: 'bubble-text' }, m.role === 'agent' ? renderReply(m.text) : m.text))));
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

    function redraw() { drawHead(); drawBanner(); drawList(); drawSend(); }

    dock.appendChild(activityDock);
    dock.appendChild(h('div', { class: 'composer' }, input, sendBtn));
    el.appendChild(h('div', { class: 'chat' }, head, modeNote, banner, list, dock));
    redraw();

    var offs = [
      Bus.on('agent', redraw),
      Bus.on('opencode', function () { drawHead(); drawBanner(); })
    ];
    return function () { offs.forEach(function (f) { f(); }); };
  }

  Agent.render = render;
  g.AgentInterface = AgentInterface;
  g.Agent = Agent;
})(window);

package com.opencode.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.Handler;
import android.os.Looper;
import org.json.JSONArray;
import org.json.JSONObject;

/** Foreground notification while an OpenCode task is running. Register this service in AndroidManifest.xml. */
public final class TaskNotificationService extends Service {
    public static final String ACTION_START = "com.opencode.mobile.task.START";
    public static final String ACTION_UPDATE = "com.opencode.mobile.task.UPDATE";
    public static final String ACTION_FINISH = "com.opencode.mobile.task.FINISH";
    private static final String CHANNEL = "opencode_si_task";
    private static final int NOTIFICATION_ID = 1610;
    private static final String EXTRA_STATUS = "status";
    private static final String EXTRA_ACTIVITY = "activity";
    private static final String EXTRA_PROJECT = "project";
    private static final String EXTRA_SESSION = "session";
    private final Handler handler = new Handler(Looper.getMainLooper());
    private String sessionId = "";
    private volatile boolean pollInFlight = false;
    private long lastSuccessfulPollAt = 0L;
    private final Runnable poll = new Runnable() {
        public void run() {
            pollTask();
            if (sessionId.length() > 0) handler.postDelayed(this, 12000L);
        }
    };

    private String status = "AI task running";
    private String currentActivity = "Working on your request";
    private String project = "Open project";
    private long startedAt = System.currentTimeMillis();

    public static void start(Context c, String project, String activity, String sessionId) {
        Intent i = intent(c, ACTION_START, project, activity, "AI task running");
        i.putExtra(EXTRA_SESSION, sessionId == null ? "" : sessionId);
        launch(c, i);
    }
    public static void update(Context c, String project, String activity, String status) {
        launch(c, intent(c, ACTION_UPDATE, project, activity, status));
    }
    public static void finish(Context c, String project, String status, String activity) {
        launch(c, intent(c, ACTION_FINISH, project, activity, status));
    }
    private static Intent intent(Context c, String action, String project, String activity, String status) {
        Intent i = new Intent(c, TaskNotificationService.class).setAction(action);
        i.putExtra(EXTRA_PROJECT, safe(project, "Open project"));
        i.putExtra(EXTRA_ACTIVITY, safe(activity, "Working on your request"));
        i.putExtra(EXTRA_STATUS, safe(status, "AI task running"));
        return i;
    }
    private static void launch(Context c, Intent i) {
        try {
            if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
        } catch (RuntimeException ignored) { /* Permission/start restrictions are surfaced in diagnostics; never crash task handling. */ }
    }
    private static String safe(String s, String fallback) {
        if (s == null) return fallback;
        s = s.replace('\n', ' ').trim();
        return s.length() == 0 ? fallback : (s.length() > 100 ? s.substring(0, 97) + "..." : s);
    }
    @Override public void onCreate() {
        super.onCreate(); createChannel();
        android.content.SharedPreferences p = getSharedPreferences("opencode_si_task_notification", Context.MODE_PRIVATE);
        sessionId = p.getString(EXTRA_SESSION, "");
        project = p.getString(EXTRA_PROJECT, project);
        currentActivity = p.getString(EXTRA_ACTIVITY, currentActivity);
        startedAt = p.getLong("startedAt", System.currentTimeMillis());
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        // Every ACTION_* command is launched through startForegroundService() on API 26+.
        // Therefore even FINISH must promote immediately; otherwise Android throws
        // ForegroundServiceDidNotStartInTimeException before this branch can stop the service.
        // Use a temporary ongoing notification first, then replace it with the final notification below.
        startForeground(NOTIFICATION_ID, buildNotification(true));
        if (intent != null && ACTION_FINISH.equals(intent.getAction())) {
            project = safe(intent.getStringExtra(EXTRA_PROJECT), project);
            currentActivity = safe(intent.getStringExtra(EXTRA_ACTIVITY), "Task finished");
            status = safe(intent.getStringExtra(EXTRA_STATUS), "AI task completed");
            status = status.toLowerCase().contains("fail") || status.toLowerCase().contains("unknown")
                    ? "AI task failed" : status.toLowerCase().contains("cancel")
                    ? "AI task cancelled" : "AI task completed";
            sessionId = "";
            handler.removeCallbacks(poll);
            getSharedPreferences("opencode_si_task_notification", Context.MODE_PRIVATE).edit()
                    .remove(EXTRA_SESSION).remove(EXTRA_PROJECT).remove(EXTRA_ACTIVITY).remove("startedAt").apply();
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(NOTIFICATION_ID, buildNotification(false));
            stopForeground(false);
            stopSelf();
            return START_NOT_STICKY;
        }

        if (intent != null) {
            String action = intent.getAction();
            if (ACTION_START.equals(action)) {
                startedAt = System.currentTimeMillis();
                sessionId = safe(intent.getStringExtra(EXTRA_SESSION), "");
                lastSuccessfulPollAt = 0L;
                handler.removeCallbacks(poll);
            } else if (intent.getStringExtra(EXTRA_SESSION) != null) {
                sessionId = safe(intent.getStringExtra(EXTRA_SESSION), sessionId);
            }
            project = safe(intent.getStringExtra(EXTRA_PROJECT), project);
            currentActivity = safe(intent.getStringExtra(EXTRA_ACTIVITY), currentActivity);
            status = safe(intent.getStringExtra(EXTRA_STATUS), status);
            persistState(); // Persist only after the new intent's values have been applied.
            if (sessionId.length() > 0) {
                handler.removeCallbacks(poll);
                handler.postDelayed(poll, ACTION_START.equals(action) ? 2500L : 12000L);
            }
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(NOTIFICATION_ID, buildNotification(true));
        } else if (sessionId.length() > 0) {
            handler.removeCallbacks(poll);
            handler.postDelayed(poll, 3000L);
        }
        return START_STICKY;
    }
    private void createChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel c = new NotificationChannel(CHANNEL, "OpenCode SI task progress", NotificationManager.IMPORTANCE_LOW);
            c.setDescription("Persistent status while OpenCode SI runs an AI task");
            c.setShowBadge(false);
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.createNotificationChannel(c);
        }
    }
    private Notification buildNotification(boolean ongoing) {
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getActivity(this, 1610, open, flags);
        String elapsed = elapsed(System.currentTimeMillis() - startedAt);
        String title = ongoing ? "OpenCode SI — Working in background" : "OpenCode SI — " + status;
        String body = "Status: " + status + "\nCurrent activity: " + currentActivity + "\nElapsed time: " + elapsed + "\nProject: " + project;
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        b.setSmallIcon(android.R.drawable.stat_notify_sync)
         .setContentTitle(title).setContentText("Status: " + status + " · " + currentActivity)
         .setStyle(new Notification.BigTextStyle().bigText(body))
         .setContentIntent(pi).setOngoing(ongoing).setAutoCancel(!ongoing)
         .setOnlyAlertOnce(true).setShowWhen(false);
        if (ongoing && Build.VERSION.SDK_INT >= 24) b.setUsesChronometer(true).setWhen(startedAt);
        return b.build();
    }
    private void persistState() {
        getSharedPreferences("opencode_si_task_notification", Context.MODE_PRIVATE).edit()
            .putString(EXTRA_SESSION, sessionId).putString(EXTRA_PROJECT, project)
            .putString(EXTRA_ACTIVITY, currentActivity).putLong("startedAt", startedAt).apply();
    }
    private void pollTask() {
        final String sid = sessionId;
        if (sid.length() == 0 || pollInFlight) return;
        pollInFlight = true;
        // OpenCode status can perform network I/O. Never do that on the Android main thread:
        // a slow/stalled server must not freeze the notification service or the WebView UI.
        new Thread(new Runnable() {
            public void run() {
                String nextActivity = null;
                String terminalStatus = null;
                try {
                    JSONObject st = OpenCodeRuntime.get(getApplicationContext()).agent.status(sid);
                    String state = st.optString("state", "RUNNING");
                    if (!"RUNNING".equals(state)) {
                        terminalStatus = "SUCCESS".equals(state) ? "AI task completed"
                                : "CANCELLED".equals(state) ? "AI task cancelled" : "AI task failed";
                        nextActivity = "Task " + state.toLowerCase();
                    } else {
                        nextActivity = activityLabel(st);
                        lastSuccessfulPollAt = System.currentTimeMillis();
                    }
                } catch (Exception ignored) {
                    // Keep the foreground service alive. Mark a stale connection honestly instead of
                    // pretending the model is actively progressing.
                    if (lastSuccessfulPollAt > 0 && System.currentTimeMillis() - lastSuccessfulPollAt > 60000L) {
                        nextActivity = "Waiting for OpenCode server update";
                    }
                }
                final String activity = nextActivity;
                final String finished = terminalStatus;
                handler.postDelayed(new Runnable() {
                    public void run() {
                        pollInFlight = false;
                        if (!sid.equals(sessionId)) return; // Ignore stale response after a new task starts.
                        if (finished != null) {
                            finish(getApplicationContext(), project, finished, activity);
                            return;
                        }
                        if (activity != null && activity.length() > 0) {
                            currentActivity = safe(activity, "AI task running");
                            persistState();
                        }
                        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                        if (nm != null) nm.notify(NOTIFICATION_ID, buildNotification(true));
                    }
                }, 0L);
            }
        }, "OpenCode-SI-TaskStatus").start();
    }

    private String activityLabel(JSONObject st) {
        JSONArray events = st.optJSONArray("activity");
        if (events != null && events.length() > 0) {
            for (int i = events.length() - 1; i >= 0; i--) {
                JSONObject last = events.optJSONObject(i);
                if (last == null) continue;
                String label = last.optString("label", "").trim();
                String detail = last.optString("detail", "").trim();
                String state = last.optString("state", "").trim();
                if (label.length() > 0) {
                    if ("running".equals(state)) return label;
                    if (detail.length() > 0) return label + ": " + detail;
                    return label;
                }
            }
        }
        JSONArray steps = st.optJSONArray("steps");
        if (steps != null && steps.length() > 0) {
            JSONObject last = steps.optJSONObject(steps.length() - 1);
            if (last != null) {
                String tool = last.optString("tool", "").trim();
                if (tool.length() > 0) return "Using " + tool;
            }
        }
        return "AI task running";
    }
    private static String elapsed(long ms) {
        long sec = Math.max(0, ms / 1000); long min = sec / 60; sec %= 60;
        return min > 0 ? min + " minutes " + sec + " seconds" : sec + " seconds";
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}

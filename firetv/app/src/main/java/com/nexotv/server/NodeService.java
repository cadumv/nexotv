package com.nexotv.server;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.res.AssetManager;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;

import androidx.annotation.Nullable;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

public class NodeService extends Service {

    private static final String TAG = "NodeService";
    private static final String CHANNEL_ID = "nexotv_server_channel";
    private static final int NOTIF_ID = 1;

    static {
        System.loadLibrary("native-lib");
        System.loadLibrary("node");
    }

    public native Integer startNodeWithArguments(String[] arguments);

    private static boolean sStartedNode = false;
    private PowerManager.WakeLock mWakeLock;

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        startForeground(NOTIF_ID, buildNotification());

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (mWakeLock == null) {
            mWakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "NexoTV::NodeWakeLock");
            mWakeLock.setReferenceCounted(false);
        }
        if (!mWakeLock.isHeld()) mWakeLock.acquire();

        scheduleKeepAlive();
        startVoicePoller();
    }

    // Voice-search bridge: polls the local Node voice server (port 7001) for a
    // pending query and fires it into Stremio via the stremio:///search deep link.
    // The query is produced locally (testing) or by the cloud poller fed by the
    // Alexa skill. This native piece is generic and never needs to change.
    private static boolean sVoicePollStarted = false;
    private void startVoicePoller() {
        if (sVoicePollStarted) return;
        sVoicePollStarted = true;
        final Context ctx = getApplicationContext();
        new Thread(new Runnable() {
            @Override
            public void run() {
                while (true) {
                    try {
                        HttpURLConnection c = (HttpURLConnection) new URL("http://127.0.0.1:7001/voice/pending").openConnection();
                        c.setConnectTimeout(4000);
                        c.setReadTimeout(4000);
                        if (c.getResponseCode() == 200) {
                            BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream()));
                            StringBuilder sb = new StringBuilder();
                            String line;
                            while ((line = r.readLine()) != null) sb.append(line);
                            r.close();
                            String q = new JSONObject(sb.toString()).optString("query", "");
                            if (q != null && !q.trim().isEmpty()) fireStremioSearch(ctx, q.trim());
                        }
                        c.disconnect();
                    } catch (Exception ignored) {
                        // Node bridge not up yet / transient — keep polling.
                    }
                    try { Thread.sleep(3000); } catch (InterruptedException ignored) {}
                }
            }
        }).start();
    }

    private void fireStremioSearch(Context ctx, String query) {
        // Wake the TV screen first — a voice search may arrive while the Fire TV
        // is asleep / in screensaver, and a background startActivity alone won't
        // turn the display on.
        try {
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            @SuppressWarnings("deprecation")
            PowerManager.WakeLock screenLock = pm.newWakeLock(
                    PowerManager.SCREEN_BRIGHT_WAKE_LOCK
                            | PowerManager.ACQUIRE_CAUSES_WAKEUP
                            | PowerManager.ON_AFTER_RELEASE,
                    "NexoTV::WakeScreen");
            screenLock.acquire(10000); // auto-release after 10s
        } catch (Exception e) {
            Log.w(TAG, "wake screen failed: " + e.getMessage());
        }
        try {
            Uri uri = Uri.parse("stremio:///search?search=" + Uri.encode(query));
            Intent i = new Intent(Intent.ACTION_VIEW, uri);
            i.setPackage("com.stremio.one");
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
            ctx.startActivity(i);
            Log.i(TAG, "Fired Stremio search: " + query);
        } catch (Exception e) {
            Log.w(TAG, "fireStremioSearch failed: " + e.getMessage());
        }
    }

    // System alarm that re-pokes the service every ~15 min. The alarm is held by
    // the OS, so it fires and restarts us even if our process was fully killed.
    private void scheduleKeepAlive() {
        try {
            AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
            Intent i = new Intent(this, BootReceiver.class);
            i.setAction("com.nexotv.server.KEEPALIVE");
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
            PendingIntent pi = PendingIntent.getBroadcast(this, 1001, i, flags);
            long interval = 15 * 60 * 1000L;
            am.setInexactRepeating(AlarmManager.ELAPSED_REALTIME_WAKEUP,
                    SystemClock.elapsedRealtime() + interval, interval, pi);
        } catch (Exception e) {
            Log.w(TAG, "scheduleKeepAlive failed: " + e.getMessage());
        }
    }

    private void restartSelf(Context ctx) {
        try {
            Intent restart = new Intent(ctx, NodeService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(restart);
            } else {
                ctx.startService(restart);
            }
        } catch (Exception e) {
            Log.w(TAG, "restartSelf failed: " + e.getMessage());
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (!sStartedNode) {
            sStartedNode = true;
            final Context ctx = getApplicationContext();
            new Thread(new Runnable() {
                @Override
                public void run() {
                    String nodeDir = ctx.getFilesDir().getAbsolutePath() + "/nodejs-project";
                    if (wasAPKUpdated(ctx)) {
                        File dir = new File(nodeDir);
                        if (dir.exists()) deleteFolderRecursively(dir);
                        copyAssetFolder(ctx.getAssets(), "nodejs-project", nodeDir);
                        saveLastUpdateTime(ctx);
                    }
                    Log.i(TAG, "Starting node with " + nodeDir + "/main.js");
                    startNodeWithArguments(new String[]{"node", nodeDir + "/main.js"});
                    // node::Start only returns if the event loop ended (crash/exit).
                    // Allow a fresh start and re-poke the service so Node comes back.
                    Log.w(TAG, "node::Start returned (event loop ended). Restarting Node...");
                    sStartedNode = false;
                    try { Thread.sleep(3000); } catch (InterruptedException ignored) {}
                    restartSelf(ctx);
                }
            }).start();
        }
        return START_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // App swiped away / closed — keep the server alive by restarting the service.
        restartSelf(getApplicationContext());
        super.onTaskRemoved(rootIntent);
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onDestroy() {
        if (mWakeLock != null && mWakeLock.isHeld()) mWakeLock.release();
        super.onDestroy();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, getString(R.string.node_channel_name),
                    NotificationManager.IMPORTANCE_LOW);
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null) nm.createNotificationChannel(ch);
        }
    }

    @SuppressWarnings("deprecation")
    private Notification buildNotification() {
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            b = new Notification.Builder(this, CHANNEL_ID);
        } else {
            b = new Notification.Builder(this);
        }
        return b.setContentTitle("NexoTV rodando")
                .setContentText("Servidor em http://localhost:7000")
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setOngoing(true)
                .build();
    }

    private static boolean wasAPKUpdated(Context ctx) {
        SharedPreferences prefs = ctx.getSharedPreferences("NODEJS_MOBILE_PREFS", Context.MODE_PRIVATE);
        long prev = prefs.getLong("NODEJS_MOBILE_APK_LastUpdateTime", 0);
        long now = 1;
        try {
            PackageInfo pi = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
            now = pi.lastUpdateTime;
        } catch (PackageManager.NameNotFoundException e) { e.printStackTrace(); }
        return now != prev;
    }

    private static void saveLastUpdateTime(Context ctx) {
        long now = 1;
        try {
            PackageInfo pi = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
            now = pi.lastUpdateTime;
        } catch (PackageManager.NameNotFoundException e) { e.printStackTrace(); }
        SharedPreferences prefs = ctx.getSharedPreferences("NODEJS_MOBILE_PREFS", Context.MODE_PRIVATE);
        prefs.edit().putLong("NODEJS_MOBILE_APK_LastUpdateTime", now).apply();
    }

    private static boolean deleteFolderRecursively(File file) {
        try {
            boolean res = true;
            File[] children = file.listFiles();
            if (children != null) {
                for (File c : children) {
                    res &= c.isDirectory() ? deleteFolderRecursively(c) : c.delete();
                }
            }
            return res & file.delete();
        } catch (Exception e) { e.printStackTrace(); return false; }
    }

    private static boolean copyAssetFolder(AssetManager am, String from, String to) {
        try {
            String[] files = am.list(from);
            boolean res = true;
            if (files == null || files.length == 0) {
                res = copyAsset(am, from, to);
            } else {
                new File(to).mkdirs();
                for (String f : files)
                    res &= copyAssetFolder(am, from + "/" + f, to + "/" + f);
            }
            return res;
        } catch (Exception e) { e.printStackTrace(); return false; }
    }

    private static boolean copyAsset(AssetManager am, String from, String to) {
        InputStream in = null; OutputStream out = null;
        try {
            in = am.open(from);
            new File(to).createNewFile();
            out = new FileOutputStream(to);
            byte[] buf = new byte[8192]; int n;
            while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
            return true;
        } catch (Exception e) { e.printStackTrace(); return false; }
        finally {
            try { if (in != null) in.close(); } catch (IOException ignored) {}
            try { if (out != null) { out.flush(); out.close(); } } catch (IOException ignored) {}
        }
    }
}

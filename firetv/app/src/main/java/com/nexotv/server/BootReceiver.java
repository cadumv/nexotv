package com.nexotv.server;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

/**
 * Starts the Node server service as early as possible after boot.
 *
 * Fire OS delays BOOT_COMPLETED to sideloaded apps by ~2 minutes, so we also
 * react to the network coming up (CONNECTIVITY_CHANGE / wifi STATE_CHANGE),
 * which fires much earlier. Starting an already-running service is a no-op, so
 * reacting to every action is safe.
 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        Log.i("BootReceiver", "Received: " + action + " -> starting NodeService");
        try {
            Intent svc = new Intent(context, NodeService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(svc);
            } else {
                context.startService(svc);
            }
        } catch (Exception e) {
            Log.w("BootReceiver", "Could not start service for " + action + ": " + e.getMessage());
        }
    }
}

package com.proza.app;

import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;

/**
 * Auto-atualização do APK: baixa o instalador (DownloadManager) e dispara a tela de
 * instalação do Android via FileProvider. Numa TV não dá pra digitar URL nem usar loja,
 * então o app cuida do download + install sozinho.
 */
@CapacitorPlugin(name = "AppUpdater")
public class AppUpdaterPlugin extends Plugin {

    private static final String APK_NAME = "proza-update.apk";

    /** Indica se o app já pode instalar APKs (Android 8+ exige "fontes desconhecidas"). */
    @PluginMethod
    public void canInstall(PluginCall call) {
        boolean ok = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ok = getContext().getPackageManager().canRequestPackageInstalls();
        }
        JSObject ret = new JSObject();
        ret.put("granted", ok);
        call.resolve(ret);
    }

    /** Abre a tela do sistema p/ liberar a instalação de fontes desconhecidas. */
    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Intent i = new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getContext().getPackageName()));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
            }
        } catch (Exception ignored) { }
        call.resolve();
    }

    /** Baixa o APK da url e, ao concluir, abre a instalação. */
    @PluginMethod
    public void downloadAndInstall(final PluginCall call) {
        final String url = call.getString("url");
        if (url == null || url.isEmpty()) { call.reject("missing url"); return; }
        final Context ctx = getContext();
        try {
            // App-specific external dir: DownloadManager pode escrever sem permissão extra.
            File dir = ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            final File apk = new File(dir, APK_NAME);
            if (apk.exists()) apk.delete();

            DownloadManager dm = (DownloadManager) ctx.getSystemService(Context.DOWNLOAD_SERVICE);
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            req.setTitle("Proza — atualização");
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setDestinationInExternalFilesDir(ctx, Environment.DIRECTORY_DOWNLOADS, APK_NAME);
            req.setMimeType("application/vnd.android.package-archive");
            final long id = dm.enqueue(req);

            final BroadcastReceiver rx = new BroadcastReceiver() {
                @Override
                public void onReceive(Context c, Intent intent) {
                    long got = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                    if (got != id) return;
                    try { c.unregisterReceiver(this); } catch (Exception ignored) { }
                    install(ctx, apk, call);
                }
            };
            IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
            if (Build.VERSION.SDK_INT >= 33) {
                ctx.registerReceiver(rx, filter, Context.RECEIVER_EXPORTED);
            } else {
                ctx.registerReceiver(rx, filter);
            }
        } catch (Exception e) {
            call.reject("download failed: " + e.getMessage());
        }
    }

    private void install(Context ctx, File apk, PluginCall call) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW);
            Uri uri;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", apk);
                intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } else {
                uri = Uri.fromFile(apk);
                intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            }
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            ctx.startActivity(intent);
            JSObject ret = new JSObject();
            ret.put("started", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("install failed: " + e.getMessage());
        }
    }
}

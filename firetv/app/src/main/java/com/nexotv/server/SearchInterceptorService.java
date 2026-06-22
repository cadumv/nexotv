package com.nexotv.server;

import android.accessibilityservice.AccessibilityService;
import android.content.Intent;
import android.net.Uri;
import android.os.SystemClock;
import android.util.Log;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import java.util.List;

/**
 * Reads the Fire TV launcher's universal-search text and redirects it into
 * Stremio (via the stremio:///search deep link). Stremio becomes the default for
 * searches — EXCEPT when the query mentions Spotify or YouTube, which are left
 * untouched so music/video searches still go where they belong.
 *
 * This needs no cloud and no Alexa skill — it intercepts the home-search result
 * screen directly. The user must enable this accessibility service once.
 */
public class SearchInterceptorService extends AccessibilityService {

    private static final String TAG = "SearchInterceptor";
    private static final String SEARCH_ID = "com.amazon.tv.launcher:id/search_text";
    // Queries mentioning these are left for Fire TV (not redirected to Stremio).
    private static final String[] EXCLUDE = { "spotify", "youtube", "you tube", "music", "música", "musica" };

    private String lastQuery = "";
    private long lastFireTime = 0;

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        try {
            CharSequence pkg = event.getPackageName();
            if (pkg == null || !"com.amazon.tv.launcher".contentEquals(pkg)) return;

            AccessibilityNodeInfo root = getRootInActiveWindow();
            if (root == null) return;

            List<AccessibilityNodeInfo> nodes = root.findAccessibilityNodeInfosByViewId(SEARCH_ID);
            if (nodes == null || nodes.isEmpty()) return;

            CharSequence raw = nodes.get(0).getText();
            if (raw == null) return;
            String text = raw.toString().toLowerCase().trim();
            if (text.isEmpty()) return;

            // Leave Spotify / YouTube / music searches alone.
            for (String ex : EXCLUDE) {
                if (text.contains(ex)) return;
            }

            String query = cleanQuery(text);
            if (query.isEmpty()) return;

            long now = SystemClock.elapsedRealtime();
            if (query.equals(lastQuery) && now - lastFireTime < 8000) return; // debounce
            lastQuery = query;
            lastFireTime = now;

            fireStremio(query);
        } catch (Exception e) {
            Log.w(TAG, "onAccessibilityEvent error: " + e.getMessage());
        }
    }

    // "procurar top gun na minha telinha" -> "top gun"
    private String cleanQuery(String text) {
        String s = text;
        // remove the trigger phrase (with or without leading connector)
        s = s.replace("na minha telinha", " ")
             .replace("no minha telinha", " ")
             .replace("em minha telinha", " ")
             .replace("minha telinha", " ");
        s = s.trim();
        // strip a leading carrier verb if present
        String[] verbs = {
            "procurar por ", "buscar por ", "pesquisar por ",
            "procurar ", "buscar ", "pesquisar ", "procura ", "busca ", "pesquisa ",
            "achar ", "encontrar ", "assistir ", "ver "
        };
        for (String v : verbs) {
            if (s.startsWith(v)) { s = s.substring(v.length()); break; }
        }
        return s.replaceAll("\\s+", " ").trim();
    }

    private void fireStremio(String query) {
        try {
            Uri uri = Uri.parse("stremio:///search?search=" + Uri.encode(query));
            Intent i = new Intent(Intent.ACTION_VIEW, uri);
            i.setPackage("com.stremio.one");
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
            Log.i(TAG, "Redirected to Stremio: " + query);
        } catch (Exception e) {
            Log.w(TAG, "fireStremio error: " + e.getMessage());
        }
    }

    @Override
    public void onInterrupt() { }
}

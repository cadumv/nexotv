package com.nexotv.server;

import android.app.Activity;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.widget.TextView;

public class MainActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Intent svc = new Intent(this, NodeService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(svc);
        } else {
            startService(svc);
        }

        TextView tv = new TextView(this);
        tv.setText("NexoTV Server iniciando em http://localhost:7000\n\nPode deixar este app em segundo plano. No Stremio, instale o addon apontando para http://127.0.0.1:7000/manifest.json");
        tv.setPadding(64, 64, 64, 64);
        tv.setTextSize(18);
        setContentView(tv);
    }
}

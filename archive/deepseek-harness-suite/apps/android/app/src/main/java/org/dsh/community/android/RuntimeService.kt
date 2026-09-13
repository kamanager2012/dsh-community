package org.dsh.community.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * Foreground service that owns the embedded nodejs-mobile runtime.
 *
 * Responsibilities:
 *  - start the nodejs-mobile process (official @deepseek-ai/dsh runtime)
 *  - keep it alive while the session is active (Android kills background
 *    processes aggressively; the foreground notification is required)
 *  - forward approval prompts from the runtime to a system notification
 *
 * The runtime project is bundled under `nodejs-project/` — see
 * nodejs-mobile-gradle-plugin (`nodejs-mobile-build` task) and the
 * nodejs-project README for how the official runtime is wired in.
 */
class RuntimeService : Service() {

    companion object {
        private const val CHANNEL_ID = "dsh_runtime"
        private const val NOTIF_ID = 1

        fun start(context: Context) {
            val intent = Intent(context, RuntimeService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, RuntimeService::class.java))
        }
    }

    override fun onCreate() {
        super.onCreate()
        createChannel()
        startForeground(NOTIF_ID, buildNotification("Harness runtime starting…"))
        startNodeRuntime()
    }

    private fun startNodeRuntime() {
        // TODO(android): wire the nodejs-mobile bootstrap here.
        // Reference:
        //   NodeJS.runScript("require('@deepseek-ai/dsh')...") or a bundled
        //   main.js that starts `dsh web --port <RUNTIME_PORT>`.
        //
        // Reality Gate: do not claim runtime readiness before the Termux
        // verification (scripts/termux-verify.sh) passes on a real device.
        Log.i(DshApp.TAG, "node runtime bootstrap placeholder")
    }

    private fun buildNotification(text: String): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("DSH Harness")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(
                PendingIntent.getActivity(
                    this, 0,
                    Intent(this, MainActivity::class.java),
                    PendingIntent.FLAG_IMMUTABLE
                )
            )
            .build()

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Harness runtime",
                NotificationManager.IMPORTANCE_LOW
            )
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null
}

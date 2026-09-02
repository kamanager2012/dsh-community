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
 * Foreground service reserved for the future embedded official runtime.
 *
 * Responsibilities:
 *  - start the verified Android Node substrate (official @deepseek-ai/dsh runtime)
 *  - keep it alive while the session is active (Android kills background
 *    processes aggressively; the foreground notification is required)
 *  - forward approval prompts from the runtime to a system notification
 *
 * The target Node project is kept under `nodejs-project/`, but no embedded
 * runtime is claimed until `runtime-substrate.json` becomes PASS through a
 * real Android Reality Gate.
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
        if (!DshApp.RUNTIME_SUBSTRATE_READY) {
            Log.w(
                DshApp.TAG,
                "Android runtime substrate is BLOCKED; refusing to pretend the official runtime started"
            )
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return
        }

        // TODO(android): start the verified Node 22.19+ Android substrate here.
        // The carrier MUST receive verifiedRuntimeEnvironment() so the embedded
        // Node preflight tests hard-link + Landlock semantics under this APK UID.
        // This branch must remain unreachable until the machine-readable
        // runtime-substrate gate and real-device Reality Gate are promoted.
        error("RUNTIME_SUBSTRATE_READY cannot be true before bootstrap is implemented")
    }

    private fun verifiedRuntimeEnvironment(): Map<String, String> = mapOf(
        "DSH_RUNTIME_PORT" to DshApp.RUNTIME_PORT.toString(),
        "DSH_ANDROID_APP_DATA_DIR" to filesDir.absolutePath,
        "DSH_ANDROID_CACHE_DIR" to cacheDir.absolutePath
    )

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

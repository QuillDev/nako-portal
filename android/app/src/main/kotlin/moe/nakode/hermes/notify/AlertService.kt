package moe.nakode.hermes.notify

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.IBinder
import android.webkit.CookieManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import moe.nakode.hermes.R
import moe.nakode.hermes.shell.MainActivity
import moe.nakode.hermes.shell.ServerOrigin
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Keeps one socket open to the portal on this machine and turns its alerts into
 * Android notifications. Nothing goes through Google: the phone talks straight
 * to the portal, signed in with the same cookie as the WebView.
 */
class AlertService : Service() {
    private val client = OkHttpClient.Builder().pingInterval(30, TimeUnit.SECONDS).build()
    private var socket: WebSocket? = null
    private var attempts = 0
    private var stopped = false
    private val ids = AtomicInteger(100)
    private val handler by lazy { android.os.Handler(mainLooper) }
    private val network = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            // Back online: reconnect now instead of waiting out the backoff.
            handler.post { if (socket == null) connect(reset = true) }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        channels(this)
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val ongoing = NotificationCompat.Builder(this, QUIET)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Listening for Hermes")
            .setContentIntent(open)
            .setOngoing(true)
            .setSilent(true)
            .build()
        ServiceCompat.startForeground(this, 1, ongoing, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
        getSystemService(ConnectivityManager::class.java)?.registerDefaultNetworkCallback(network)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (socket == null) connect(reset = true)
        return START_STICKY
    }

    override fun onDestroy() {
        stopped = true
        runCatching { getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(network) }
        socket?.close(1000, null)
        super.onDestroy()
    }

    private fun connect(reset: Boolean = false) {
        if (stopped) return
        if (reset) attempts = 0
        val origin = origin(this) ?: return stopSelf()
        val cookie = CookieManager.getInstance().getCookie(origin.value)
        if (cookie.isNullOrEmpty()) return stopSelf()
        val request = Request.Builder()
            .url(origin.socketUrl)
            .header("Cookie", cookie)
            .header("Origin", origin.value)
            .build()
        socket = client.newWebSocket(request, Listener(origin))
    }

    private fun retryLater() {
        socket = null
        if (stopped) return
        handler.postDelayed({ if (socket == null) connect() }, backoffSeconds(attempts++) * 1000)
    }

    private inner class Listener(private val origin: ServerOrigin) : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            attempts = 0
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            parseAlert(text)?.let { show(origin, it) }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            // Signed out (cookie expired or passkey removed): stop until the app signs in again.
            if (response?.code == 401 || response?.code == 403) {
                handler.post { stopSelf() }
                return
            }
            handler.post { retryLater() }
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            handler.post { retryLater() }
        }
    }

    private fun show(origin: ServerOrigin, alert: Alert) {
        val open = Intent(this, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            putExtra(MainActivity.EXTRA_SESSION, alert.session)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val tap = PendingIntent.getActivity(this, alert.session.hashCode(), open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notification = NotificationCompat.Builder(this, ALERTS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(alert.title)
            .setContentText(alert.body)
            // Expanded, the notification shows the whole reply preview, not one line of it.
            .setStyle(NotificationCompat.BigTextStyle().bigText(alert.body))
            .setContentIntent(tap)
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_MESSAGE)
            .build()
        val manager = getSystemService(NotificationManager::class.java)
        // One notification per chat: a newer alert replaces the older one.
        val id = alert.session?.hashCode() ?: ids.incrementAndGet()
        manager.notify(id, notification)
    }

    companion object {
        const val ALERTS = "alerts"
        const val QUIET = "connection"

        fun origin(context: Context): ServerOrigin? =
            context.getSharedPreferences("shell", MODE_PRIVATE).getString("origin", null)?.let(ServerOrigin::parse)

        fun channels(context: Context) {
            val manager = context.getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(NotificationChannel(ALERTS, "Hermes alerts", NotificationManager.IMPORTANCE_HIGH))
            manager.createNotificationChannel(
                NotificationChannel(QUIET, "Connection", NotificationManager.IMPORTANCE_MIN).apply {
                    description = "Shown while the app listens for alerts. Safe to hide."
                },
            )
        }

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, AlertService::class.java))
        }
    }
}

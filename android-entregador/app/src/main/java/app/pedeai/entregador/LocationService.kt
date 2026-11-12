package app.pedeai.entregador

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

// Serviço em primeiro plano: mantém o GPS ligado mesmo com o mapa ou outro app aberto.
class LocationService : Service() {
    private var token: String? = null
    private var ultimo: Location? = null
    private lateinit var lm: LocationManager
    private val handler = Handler(Looper.getMainLooper())
    private val rede = Executors.newSingleThreadExecutor()

    private val ouvinte = LocationListener { loc -> ultimo = loc }

    private val envioPeriodico = object : Runnable {
        override fun run() {
            ultimo?.let { enviaPosicao(it) }
            handler.postDelayed(this, 10_000L)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACAO_PARAR) {
            parar()
            return START_NOT_STICKY
        }
        val t = intent?.getStringExtra("token") ?: token
        if (t == null) { stopSelf(); return START_NOT_STICKY }
        token = t
        criaCanal()
        startForeground(NOTIFICACAO_ID, notificacao())
        lm = getSystemService(Context.LOCATION_SERVICE) as LocationManager
        iniciaGps()
        handler.removeCallbacks(envioPeriodico)
        handler.post(envioPeriodico)
        return START_STICKY
    }

    private fun iniciaGps() {
        if (ActivityCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            stopSelf(); return
        }
        try {
            lm.removeUpdates(ouvinte)
            if (lm.isProviderEnabled(LocationManager.GPS_PROVIDER))
                lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 10_000L, 0f, ouvinte)
            if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER))
                lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 10_000L, 0f, ouvinte)
        } catch (e: SecurityException) {
            stopSelf()
        }
    }

    // Envia a posição para o site, em uma thread separada
    private fun enviaPosicao(loc: Location) {
        val t = token ?: return
        rede.execute {
            try {
                val con = URL("${MainActivity.SITE}/api/driver/$t/pos").openConnection() as HttpURLConnection
                con.requestMethod = "POST"
                con.setRequestProperty("Content-Type", "application/json")
                con.doOutput = true
                con.connectTimeout = 10_000
                con.readTimeout = 10_000
                val corpo = "{\"lat\":${loc.latitude},\"lng\":${loc.longitude}}"
                con.outputStream.use { it.write(corpo.toByteArray()) }
                con.responseCode
                con.disconnect()
            } catch (_: Exception) {
                // sem internet: tenta de novo na próxima posição
            }
        }
    }

    private fun parar() {
        handler.removeCallbacks(envioPeriodico)
        try { lm.removeUpdates(ouvinte) } catch (_: Exception) {}
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun criaCanal() {
        if (Build.VERSION.SDK_INT >= 26) {
            val canal = NotificationChannel(CANAL_ID, "Entregas em andamento", NotificationManager.IMPORTANCE_LOW)
            canal.description = "Mostra que a localização está sendo enviada para a loja"
            getSystemService(NotificationManager::class.java).createNotificationChannel(canal)
        }
    }

    private fun notificacao(): Notification {
        val abrir = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val pararIntent = PendingIntent.getService(
            this, 1, Intent(this, LocationService::class.java).setAction(ACAO_PARAR),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CANAL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle("Entregas em andamento")
            .setContentText("Sua localização está sendo enviada para a loja")
            .setContentIntent(abrir)
            .addAction(0, "Parar", pararIntent)
            .setOngoing(true)
            .build()
    }

    override fun onDestroy() {
        handler.removeCallbacks(envioPeriodico)
        try { lm.removeUpdates(ouvinte) } catch (_: Exception) {}
        super.onDestroy()
    }

    companion object {
        const val CANAL_ID = "entregas"
        const val NOTIFICACAO_ID = 42
        const val ACAO_PARAR = "app.pedeai.entregador.PARAR"
    }
}

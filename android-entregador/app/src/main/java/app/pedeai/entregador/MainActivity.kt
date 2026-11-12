package app.pedeai.entregador

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.net.Uri
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private val prefs by lazy { getSharedPreferences("entregador", Context.MODE_PRIVATE) }
    private var tokenPendente: String? = null
    private var pediuSempre = false

    companion object {
        const val SITE = "https://pedeaiapp.online"
        const val PEDIR_PERMISSOES = 1
        const val PEDIR_LOCALIZACAO_SEMPRE = 2
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        setContentView(web)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.addJavascriptInterface(Ponte(), "AndroidDriver")
        web.webViewClient = object : WebViewClient() {
            // Mapa e WhatsApp abrem fora do app; o resto fica dentro
            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
                return url != null && !url.startsWith(SITE)
            }
        }
        processaLink(intent)
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        processaLink(intent)
    }

    private fun processaLink(intent: Intent?) {
        val dados = intent?.data
        if (dados != null && dados.path?.startsWith("/entregador/") == true) {
            val token = dados.lastPathSegment ?: ""
            if (token.matches(Regex("[a-f0-9]{24}"))) prefs.edit().putString("token", token).apply()
        }
        val token = prefs.getString("token", null)
        if (token == null) {
            web.loadData(
                "<html><body style='font-family:sans-serif;padding:24px'><h2>Pedeaí Entregador</h2>" +
                "<p>Abra o link de entregas que a loja mandou para você no WhatsApp.</p></body></html>",
                "text/html", "utf-8"
            )
        } else {
            web.loadUrl("$SITE/entregador/$token")
        }
    }

    private fun temPermissao(p: String) =
        ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    // Pede localização e notificação; depois a permissão "o tempo todo"; depois tira o app da economia de bateria
    private fun pedeEInicia(token: String) {
        tokenPendente = token
        val faltam = mutableListOf<String>()
        if (!temPermissao(Manifest.permission.ACCESS_FINE_LOCATION)) faltam.add(Manifest.permission.ACCESS_FINE_LOCATION)
        if (Build.VERSION.SDK_INT >= 33 && !temPermissao(Manifest.permission.POST_NOTIFICATIONS)) faltam.add(Manifest.permission.POST_NOTIFICATIONS)
        if (faltam.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, faltam.toTypedArray(), PEDIR_PERMISSOES)
            return
        }
        if (Build.VERSION.SDK_INT >= 29 && !temPermissao(Manifest.permission.ACCESS_BACKGROUND_LOCATION) && !pediuSempre) {
            pediuSempre = true
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.ACCESS_BACKGROUND_LOCATION), PEDIR_LOCALIZACAO_SEMPRE)
            return
        }
        iniciaComBateria(token)
    }

    // Pede para tirar o app da economia de bateria, para o Android não parar o rastreamento
    private fun iniciaComBateria(token: String) {
        val pm = getSystemService(PowerManager::class.java)
        if (pm != null && !pm.isIgnoringBatteryOptimizations(packageName)) {
            try {
                startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
            } catch (_: Exception) {}
        }
        iniciaServico(token)
    }

    private fun iniciaServico(token: String) {
        val it = Intent(this, LocationService::class.java).putExtra("token", token)
        ContextCompat.startForegroundService(this, it)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        val token = tokenPendente ?: return
        when (requestCode) {
            PEDIR_PERMISSOES -> if (temPermissao(Manifest.permission.ACCESS_FINE_LOCATION)) pedeEInicia(token)
            PEDIR_LOCALIZACAO_SEMPRE -> iniciaComBateria(token)
        }
    }

    // Ponte chamada pela página do entregador
    inner class Ponte {
        @JavascriptInterface
        fun iniciar(token: String) {
            runOnUiThread { pedeEInicia(token) }
        }

        @JavascriptInterface
        fun parar() {
            runOnUiThread { stopService(Intent(this@MainActivity, LocationService::class.java)) }
        }
    }
}

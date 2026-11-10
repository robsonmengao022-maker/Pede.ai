package app.pedeai

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothSocket
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.widget.Toast
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.nio.charset.Charset
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

// Ponte entre o painel (JavaScript) e a impressora Bluetooth clássica (SPP), com comandos ESC/POS.
class PrinterBridge(private val act: MainActivity) {
    private val prefs = act.getSharedPreferences("impressora", Context.MODE_PRIVATE)
    private val spp: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
    private val achados = ConcurrentHashMap<String, String>()

    private val recebe = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            if (i.action != BluetoothDevice.ACTION_FOUND) return
            val d: BluetoothDevice? = if (Build.VERSION.SDK_INT >= 33)
                i.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
            else i.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)
            if (d != null) {
                val nome = try { d.name } catch (_: SecurityException) { null }
                achados[d.address] = nome ?: "Sem nome"
            }
        }
    }

    init {
        ContextCompat.registerReceiver(act, recebe, IntentFilter(BluetoothDevice.ACTION_FOUND), ContextCompat.RECEIVER_NOT_EXPORTED)
    }

    private fun temPermissao(): Boolean =
        if (Build.VERSION.SDK_INT >= 31)
            ContextCompat.checkSelfPermission(act, android.Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
        else true

    private fun aviso(msg: String) = act.runOnUiThread { Toast.makeText(act, msg, Toast.LENGTH_LONG).show() }

    @JavascriptInterface
    fun temPermissaoBluetooth(): Boolean = temPermissao()

    @JavascriptInterface
    fun pedirPermissao() = act.runOnUiThread { act.pedirBluetooth() }

    @JavascriptInterface
    @SuppressLint("MissingPermission")
    fun pareadas(): String {
        if (!temPermissao()) return "[]"
        val adapter = BluetoothAdapter.getDefaultAdapter() ?: return "[]"
        val arr = JSONArray()
        for (d in adapter.bondedDevices ?: emptySet()) {
            arr.put(JSONObject().put("name", d.name ?: "Sem nome").put("address", d.address))
        }
        return arr.toString()
    }

    @JavascriptInterface
    @SuppressLint("MissingPermission")
    fun buscar(): Boolean {
        if (!temPermissao()) return false
        val adapter = BluetoothAdapter.getDefaultAdapter() ?: return false
        if (!adapter.isEnabled) { aviso("Ligue o Bluetooth do celular."); return false }
        achados.clear()
        if (adapter.isDiscovering) adapter.cancelDiscovery()
        adapter.startDiscovery()
        Handler(Looper.getMainLooper()).postDelayed({ adapter.cancelDiscovery() }, 12000)
        return true
    }

    @JavascriptInterface
    fun encontradas(): String {
        val arr = JSONArray()
        for ((end, nome) in achados) arr.put(JSONObject().put("name", nome).put("address", end))
        return arr.toString()
    }

    @JavascriptInterface
    @SuppressLint("MissingPermission")
    fun parear(endereco: String): Boolean {
        if (!temPermissao()) return false
        val adapter = BluetoothAdapter.getDefaultAdapter() ?: return false
        return try { adapter.getRemoteDevice(endereco).createBond() } catch (_: Exception) { false }
    }

    @JavascriptInterface
    fun salvarImpressora(endereco: String, nome: String) {
        prefs.edit().putString("end", endereco).putString("nome", nome).apply()
    }

    @JavascriptInterface
    fun impressora(): String = JSONObject()
        .put("address", prefs.getString("end", "") ?: "")
        .put("name", prefs.getString("nome", "") ?: "")
        .toString()

    @JavascriptInterface
    fun imprimir(texto: String) {
        val end = prefs.getString("end", "") ?: ""
        if (end.isEmpty()) { aviso("Escolha a impressora Bluetooth primeiro."); return }
        Thread {
            try {
                enviar(end, texto)
            } catch (e: Exception) {
                aviso("Não consegui imprimir. Confira se a impressora está ligada e perto do celular. (" + (e.message ?: "erro") + ")")
            }
        }.start()
    }

    @SuppressLint("MissingPermission")
    private fun enviar(endereco: String, texto: String) {
        val adapter = BluetoothAdapter.getDefaultAdapter() ?: throw Exception("Bluetooth indisponível")
        if (!adapter.isEnabled) throw Exception("Bluetooth desligado")
        adapter.cancelDiscovery()
        val dev: BluetoothDevice = adapter.getRemoteDevice(endereco)
        val sock: BluetoothSocket = try {
            dev.createRfcommSocketToServiceRecord(spp).also { it.connect() }
        } catch (_: Exception) {
            // Algumas impressoras só aceitam a conexão sem criptografia
            dev.createInsecureRfcommSocketToServiceRecord(spp).also { it.connect() }
        }
        try {
            val out = sock.outputStream
            out.write(byteArrayOf(0x1B, 0x40))            // ESC @: reinicia a impressora
            out.write(byteArrayOf(0x1B, 0x74, 2))         // ESC t 2: tabela de caracteres CP850 (acentos)
            out.write(texto.toByteArray(Charset.forName("Cp850")))
            out.write(byteArrayOf(0x0A, 0x0A, 0x0A, 0x0A)) // avança o papel
            out.write(byteArrayOf(0x1D, 0x56, 0x42, 0x00)) // corta o papel (se a impressora tiver guilhotina)
            out.flush()
            Thread.sleep(1000)
        } finally {
            try { sock.close() } catch (_: Exception) {}
        }
    }
}

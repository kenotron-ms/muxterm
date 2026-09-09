package io.ampbox.muxterm.car

import android.content.Intent
import androidx.car.app.Screen
import androidx.car.app.Session
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import io.ampbox.muxterm.UrlResolver

/**
 * One car session per Android Auto connection. [FleetRepository] is started
 * and stopped on THIS lifecycle rather than the screen's: a screen can be
 * recreated (day/night switch, rotation on some heads) without the socket
 * being torn down and redialed underneath it.
 */
class MuxtermSession : Session(), DefaultLifecycleObserver {

    init {
        lifecycle.addObserver(this)
    }

    override fun onCreateScreen(intent: Intent): Screen = FleetScreen(carContext)

    override fun onCreate(owner: LifecycleOwner) {
        UrlResolver.wsUrl(carContext)?.let { FleetRepository.start(it) }
    }

    override fun onDestroy(owner: LifecycleOwner) {
        FleetRepository.stop()
    }
}

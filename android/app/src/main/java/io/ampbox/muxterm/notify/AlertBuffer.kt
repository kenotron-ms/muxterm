package io.ampbox.muxterm.notify

import io.ampbox.muxterm.notify.TransitionDetector.Transition

/**
 * Everything between "a lane changed state" and "post a notification", with no
 * Android in it, so all of it can be tested on the JVM in milliseconds.
 *
 * Three jobs, all of them subtractive:
 *
 *  1. **Coalesce.** Transitions land in a buffer, not in the notification
 *     shade. The service flushes the buffer once, [COALESCE_WINDOW_MS] after
 *     the first thing lands in it, so ten lanes finishing together are one
 *     buzz and not ten. The window is anchored to the FIRST arrival, not slid
 *     forward on each new one - a steady drip of changes must not be able to
 *     postpone the flush forever.
 *
 *  2. **Collapse per lane.** One entry per `sessionId`; a lane that went
 *     blocked -> working -> blocked inside one window is one entry.
 *
 *  3. **Drop what is no longer true, and what is being watched.** At flush
 *     time an entry is discarded if the lane has already moved on (it went
 *     blocked and then unblocked itself before we ever spoke), or if the app
 *     is in the foreground, where a notification is noise about something the
 *     user can already see.
 *
 * Not thread-safe. Confined to the service's callback thread.
 */
class AlertBuffer {

    /** sessionId -> the latest pending transition for that lane. */
    private val pending = LinkedHashMap<String, Transition>()

    val isEmpty: Boolean get() = pending.isEmpty()
    val size: Int get() = pending.size

    /** True while a flush is owed. The service uses this to arm its timer once. */
    var flushArmed: Boolean = false

    fun add(transitions: List<Transition>) {
        for (t in transitions) pending[t.row.sessionId] = t
    }

    /**
     * Empty the buffer and decide what, if anything, to post.
     *
     * @param currentState the lane's state as of now, or null if it is gone.
     *   An entry whose target state is no longer the lane's state is dropped:
     *   the situation resolved itself while we were coalescing.
     * @param appForeground true when the user is looking at the app. Everything
     *   is dropped - not deferred - because they are watching it happen.
     */
    fun drain(currentState: (String) -> String?, appForeground: Boolean): Plan {
        val entries = pending.values.toList()
        pending.clear()
        flushArmed = false

        if (appForeground) return Plan.EMPTY
        if (entries.isEmpty()) return Plan.EMPTY

        val blocked = ArrayList<Transition>()
        val finished = ArrayList<Transition>()
        for (t in entries) {
            if (currentState(t.row.sessionId) != t.to) continue // already moved on
            if (t.isBlocked) blocked += t else finished += t
        }
        return Plan(blocked = blocked, finished = finished)
    }

    /** What one flush wants posted. Two groups because they are two channels. */
    data class Plan(
        val blocked: List<Transition>,
        val finished: List<Transition>,
    ) {
        val isEmpty: Boolean get() = blocked.isEmpty() && finished.isEmpty()

        companion object {
            val EMPTY = Plan(emptyList(), emptyList())
        }
    }

    companion object {
        /**
         * How long to gather before posting. Long enough that a batch of lanes
         * reacting to the same event arrives together (the daemon publishes at
         * 1 Hz, so two ticks), short enough that "this lane needs you" is still
         * news when it lands.
         */
        const val COALESCE_WINDOW_MS = 2_500L
    }
}

/**
 * The words. Pure, so the strings that actually appear on a phone are the
 * strings asserted in a test.
 */
object AlertText {

    fun blockedTitle(entries: List<Transition>): String = when (entries.size) {
        1 -> "${entries[0].row.displayName} needs you"
        else -> "${entries.size} lanes need you"
    }

    fun blockedBody(entries: List<Transition>): String = when (entries.size) {
        1 -> reason(entries[0])
        else -> entries.joinToString(", ") { it.row.displayName }
    }

    fun finishedTitle(entries: List<Transition>): String {
        if (entries.size == 1) {
            val e = entries[0]
            return if (e.to == TransitionDetector.STATE_FAILED) {
                "${e.row.displayName} failed"
            } else {
                "${e.row.displayName} is done"
            }
        }
        val failed = entries.count { it.to == TransitionDetector.STATE_FAILED }
        return when (failed) {
            0 -> "${entries.size} lanes are done"
            entries.size -> "${entries.size} lanes failed"
            else -> "${entries.size} lanes finished"
        }
    }

    fun finishedBody(entries: List<Transition>): String =
        entries.joinToString(", ") { line(it) }

    /** One lane, one line - what an expanded, multi-lane notification lists. */
    fun line(t: Transition): String = when {
        t.isBlocked -> "${t.row.displayName} - ${reason(t)}"
        t.to == TransitionDetector.STATE_FAILED -> "${t.row.displayName} - failed"
        else -> "${t.row.displayName} - done"
    }

    /**
     * `waitingFor` is documented as "empty unless blocked" but it is a producer
     * convention, not a validated invariant (internal/sessiond/sessionstate.go),
     * so a blocked lane with nothing to say still gets a readable line.
     */
    private fun reason(t: Transition): String =
        t.row.waitingFor.ifBlank { "waiting for you" }
}

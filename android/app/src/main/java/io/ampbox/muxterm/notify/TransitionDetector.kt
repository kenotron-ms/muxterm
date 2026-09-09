package io.ampbox.muxterm.notify

/**
 * Turns a stream of whole-fleet snapshots into the handful of state CHANGES
 * worth a buzz in someone's pocket.
 *
 * ## Why this class holds a Map<String, String> and nothing else
 *
 * The daemon publishes a `session-state` snapshot whenever the row-set hash
 * changes (internal/sessiond/server.go, `publishSessionState`). The row carries
 * `doing`, which agents re-template on EVERY TOOL CALL - so snapshots arrive at
 * up to 1 Hz, per lane, all day, and almost none of them are a state change.
 *
 * This detector's memory is therefore a map of `sessionId -> state` and NOTHING
 * ELSE. That is not an optimisation, it is the guard: `doing` is not stored, so
 * a change in `doing` is not representable as a change here, so no future edit
 * can accidentally make it notify. Anyone tempted to add `doing` to this map
 * should read [TransitionDetectorTest.doingChurnProducesNoTransitions] first,
 * then not do it.
 *
 * ## What notifies
 *
 * A transition INTO a state, never a state persisting:
 *
 * | into      | notifies | why                                              |
 * |-----------|----------|--------------------------------------------------|
 * | `blocked` | yes      | it is waiting on the human. The whole feature.   |
 * | `failed`  | yes      | something went wrong and they want to know.      |
 * | `done`    | yes      | useful, not urgent - a low-importance channel.   |
 * | `working` | NO       | the normal case; would be constant noise.        |
 * | `stopped` | NO       | usually a consequence of something the user did. |
 *
 * ## Why the first snapshot is silent
 *
 * [adopt] installs a baseline WITHOUT emitting. It is called on the first
 * snapshot of every connection - cold start AND every reconnect. The app
 * reconnects routinely, and without this every reconnect would rediscover the
 * entire fleet as "new" and fire one notification per lane. See
 * docs/design/android-notifications.md, "The reconnect storm".
 *
 * A session seen for the first time mid-run is also adopted silently, for the
 * same reason: "first sight" and "reconnect" are indistinguishable from in
 * here, so the quiet reading of both is the safe one. The cost is one missed
 * case - a lane whose very first observed state is already `blocked`, which
 * needs the daemon to have missed its working phase entirely at a 1 s tick.
 * The alternative (notify on first sight of `blocked`) is recorded in the PR.
 *
 * Not thread-safe. Confined to the service's callback thread.
 */
class TransitionDetector {

    /** A state change worth telling someone about. */
    data class Transition(
        val row: LaneRow,
        val from: String,
        val to: String,
    ) {
        val isBlocked: Boolean get() = to == STATE_BLOCKED
    }

    /** sessionId -> last known state. THE ONLY FIELD COMPARED. */
    private val known = HashMap<String, String>()

    /** Snapshot count since the last [reset]; 0 means "no baseline yet". */
    private var seen: Long = 0

    val hasBaseline: Boolean get() = seen > 0

    /**
     * Forget everything. Call on every (re)connect BEFORE the first snapshot,
     * so that snapshot is adopted as a fresh baseline instead of diffed against
     * a set that may be minutes stale.
     */
    fun reset() {
        known.clear()
        seen = 0
    }

    /**
     * Fold one snapshot in and report what changed.
     *
     * The first call after a [reset] returns an empty list no matter what the
     * fleet looks like: it is a baseline, not a diff.
     */
    fun observe(rows: List<LaneRow>): List<Transition> {
        val baseline = seen == 0L
        seen++

        val out = if (baseline) emptyList() else diff(rows)

        // Replace wholesale. A row that vanished (its process died, its pane was
        // closed) must leave the map, or a later session reusing the id would
        // diff against a ghost.
        known.clear()
        for (row in rows) known[row.sessionId] = row.state
        return out
    }

    private fun diff(rows: List<LaneRow>): List<Transition> {
        var out: MutableList<Transition>? = null
        for (row in rows) {
            val previous = known[row.sessionId] ?: continue // first sight: adopt, silently
            if (previous == row.state) continue // the state PERSISTING is not an event
            if (row.state !in NOTIFYING_STATES) continue // -> working / -> stopped: never
            val list = out ?: ArrayList<Transition>(2).also { out = it }
            list += Transition(row = row, from = previous, to = row.state)
        }
        return out ?: emptyList()
    }

    companion object {
        const val STATE_WORKING = "working"
        const val STATE_BLOCKED = "blocked"
        const val STATE_DONE = "done"
        const val STATE_FAILED = "failed"
        const val STATE_STOPPED = "stopped"

        /**
         * The three that earn a buzz. `working` and `stopped` are absent on
         * purpose and their absence is the feature - see the table above.
         */
        val NOTIFYING_STATES = setOf(STATE_BLOCKED, STATE_FAILED, STATE_DONE)
    }
}

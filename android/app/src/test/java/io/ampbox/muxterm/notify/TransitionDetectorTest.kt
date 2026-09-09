package io.ampbox.muxterm.notify

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What notifies, what does not, and the two ways a naive implementation floods
 * someone's phone.
 */
class TransitionDetectorTest {

    private fun row(
        id: String,
        state: String,
        label: String = id,
        waitingFor: String = "",
    ) = LaneRow(
        sessionId = id,
        workspaceId = "w1",
        name = id,
        label = label,
        state = state,
        waitingFor = waitingFor,
    )

    /** A detector already holding a baseline of [rows]. */
    private fun primed(vararg rows: LaneRow) = TransitionDetector().apply {
        assertTrue(observe(rows.toList()).isEmpty())
    }

    // -- N1: which transitions notify -------------------------------------

    @Test
    fun workingToBlockedNotifies() {
        val d = primed(row("a", "working"))
        val out = d.observe(listOf(row("a", "blocked", waitingFor = "permission prompt")))
        assertEquals(1, out.size)
        assertEquals("working", out[0].from)
        assertEquals("blocked", out[0].to)
        assertTrue(out[0].isBlocked)
        assertEquals("permission prompt", out[0].row.waitingFor)
    }

    @Test
    fun workingToFailedNotifies() {
        val d = primed(row("a", "working"))
        assertEquals(listOf("failed"), d.observe(listOf(row("a", "failed"))).map { it.to })
    }

    @Test
    fun workingToDoneNotifies() {
        val d = primed(row("a", "working"))
        assertEquals(listOf("done"), d.observe(listOf(row("a", "done"))).map { it.to })
    }

    @Test
    fun blockedToWorkingDoesNotNotify() {
        val d = primed(row("a", "blocked"))
        assertTrue(d.observe(listOf(row("a", "working"))).isEmpty())
    }

    @Test
    fun workingToStoppedDoesNotNotify() {
        val d = primed(row("a", "working"))
        assertTrue(d.observe(listOf(row("a", "stopped"))).isEmpty())
    }

    @Test
    fun statePersistingIsNotAnEvent() {
        val d = primed(row("a", "working"))
        assertTrue(d.observe(listOf(row("a", "blocked"))).isNotEmpty())
        // Same blocked state, over and over. The daemon republishes whenever
        // ANY field of ANY row changes, so this is the common case.
        repeat(20) { assertTrue(d.observe(listOf(row("a", "blocked"))).isEmpty()) }
    }

    // -- N1: `doing` must never notify ------------------------------------

    /**
     * THE ONE THAT WOULD RUIN IT. `doing` is re-templated on every tool call,
     * so a fleet of ten lanes produces a new snapshot several times a second.
     * Fed as real wire JSON, because the guard is that `doing` never reaches
     * the detector at all - a test built from hand-made [LaneRow]s would be
     * asserting on a type that has already thrown the field away.
     */
    @Test
    fun doingChurnProducesNoTransitions() {
        val d = TransitionDetector()
        fun snapshot(doing: String) = JSONObject(
            """
            {"type":"session-state","sessions":[
              {"sessionId":"a","workspaceId":"w1","paneId":1,"name":"lane a",
               "label":"lane a","mode":"autonomous","state":"working",
               "doing":"$doing","updatedAt":1788925778}
            ]}
            """.trimIndent(),
        )

        assertTrue(d.observe(LaneRow.parseAll(snapshot("Reading a file"))).isEmpty())

        val churn = listOf(
            "Running mcp_muxterm_fleet_status", "Reading app.ts", "Editing app.ts",
            "Running go build ./...", "Running go vet ./...", "Committing",
            "Reading AGENTS.md", "Running gh pr create", "Waiting", "Thinking",
        )
        for (line in churn) {
            assertTrue(
                "`doing` = \"$line\" must not be a transition",
                d.observe(LaneRow.parseAll(snapshot(line))).isEmpty(),
            )
        }
    }

    // -- N4: the reconnect storm ------------------------------------------

    /**
     * PR #94 made the app wake on visibilitychange, focus and online, so it
     * reconnects routinely. Every reconnect calls reset(), and the first
     * snapshot after a reset is a baseline - otherwise switching back to the
     * app would announce every lane in the fleet at once.
     */
    @Test
    fun reconnectDoesNotReplayTheFleetAsNews() {
        val fleet = listOf(
            row("a", "blocked", waitingFor = "input needed"),
            row("b", "done"),
            row("c", "failed"),
            row("d", "working"),
        )
        val d = TransitionDetector()
        assertTrue(d.observe(fleet).isEmpty()) // cold start baseline

        repeat(5) {
            d.reset() // socket dropped, dialled again
            assertFalse(d.hasBaseline)
            assertTrue(
                "a reconnect must never notify",
                d.observe(fleet).isEmpty(),
            )
        }
    }

    /**
     * The harder half: the fleet CHANGED while the socket was down. Those
     * transitions are adopted, not announced. Announcing them would mean a user
     * who leaves the app for an hour gets an hour of history in one burst - and
     * the states involved are already visible on the dashboard they just
     * opened. Quiet is the recoverable choice.
     */
    @Test
    fun reconnectAfterAGapAdoptsRatherThanAnnounces() {
        val d = TransitionDetector()
        assertTrue(d.observe(listOf(row("a", "working"), row("b", "working"))).isEmpty())

        d.reset()
        val afterTheGap = listOf(row("a", "blocked"), row("b", "failed"), row("e", "done"))
        assertTrue(d.observe(afterTheGap).isEmpty())

        // ...and it is a real baseline, not a permanently deaf detector: a new
        // lane joins (silent, first sight) and then blocks (reported).
        val withF = listOf(row("a", "blocked"), row("b", "failed"), row("e", "done"))
        assertTrue(d.observe(withF + row("f", "working")).isEmpty())
        assertEquals(
            listOf("blocked"),
            d.observe(withF + row("f", "blocked")).map { it.to },
        )
    }

    @Test
    fun firstSnapshotOfAColdStartIsSilent() {
        val d = TransitionDetector()
        assertFalse(d.hasBaseline)
        val out = d.observe(listOf(row("a", "blocked"), row("b", "failed"), row("c", "done")))
        assertTrue(out.isEmpty())
        assertTrue(d.hasBaseline)
    }

    @Test
    fun aSessionSeenForTheFirstTimeIsAdoptedSilently() {
        val d = primed(row("a", "working"))
        // "b" appears mid-run, already done. Never seen working, so there is no
        // transition to report - only a row we have just learned about.
        assertTrue(d.observe(listOf(row("a", "working"), row("b", "done"))).isEmpty())
        // But once known, it behaves normally.
        assertEquals(
            listOf("blocked"),
            d.observe(listOf(row("a", "working"), row("b", "blocked"))).map { it.to },
        )
    }

    @Test
    fun aVanishedSessionIsForgotten() {
        val d = primed(row("a", "working"))
        assertTrue(d.observe(emptyList()).isEmpty()) // pane closed, row reclaimed
        // Same id reused later: first sight again, so silent. It must NOT diff
        // against the ghost of the old session.
        assertTrue(d.observe(listOf(row("a", "done"))).isEmpty())
    }

    @Test
    fun anEmptyFleetIsAValidSnapshot() {
        val d = TransitionDetector()
        assertTrue(d.observe(emptyList()).isEmpty())
        assertTrue(d.hasBaseline)
    }

    // -- several lanes at once --------------------------------------------

    @Test
    fun severalLanesChangingInOneSnapshotAllReport() {
        val d = primed(
            row("a", "working"), row("b", "working"),
            row("c", "working"), row("d", "working"),
        )
        val out = d.observe(
            listOf(
                row("a", "blocked", waitingFor = "input needed"),
                row("b", "done"),
                row("c", "failed"),
                row("d", "working"), // unchanged
            ),
        )
        assertEquals(3, out.size)
        assertEquals(setOf("a", "b", "c"), out.map { it.row.sessionId }.toSet())
    }

    // -- the wire format ---------------------------------------------------

    @Test
    fun absentSessionsKeyMeansEmptyFleet() {
        // omitempty: a fleet that went to zero arrives as a bare message.
        assertTrue(LaneRow.parseAll(JSONObject("""{"type":"session-state"}""")).isEmpty())
    }

    @Test
    fun optionalFieldsMayBeAbsent() {
        val rows = LaneRow.parseAll(
            JSONObject(
                """
                {"type":"session-state","sessions":[
                  {"sessionId":"a","workspaceId":"w1","paneId":1,"name":"lane a",
                   "mode":"autonomous","state":"blocked","updatedAt":1}
                ]}
                """.trimIndent(),
            ),
        )
        assertEquals(1, rows.size)
        assertEquals("", rows[0].label)
        assertEquals("", rows[0].waitingFor)
        assertEquals("lane a", rows[0].displayName) // falls back to name
    }

    @Test
    fun aRowWithNoSessionIdIsSkipped() {
        val rows = LaneRow.parseAll(
            JSONObject("""{"type":"session-state","sessions":[{"state":"blocked"}]}"""),
        )
        assertTrue(rows.isEmpty())
    }
}

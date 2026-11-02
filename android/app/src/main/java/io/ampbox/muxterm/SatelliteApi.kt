package io.ampbox.muxterm

import android.net.Uri
import android.webkit.CookieManager
import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

internal data class SatelliteNode(
    val id: String,
    val name: String,
    val state: String,
    val error: String = "",
)

internal data class SatelliteProject(
    val id: String,
    val name: String,
    val path: String,
    val nodeId: String,
)

internal data class SatelliteChat(
    val id: String,
    val title: String,
    val projectId: String,
    val nodeId: String,
    val harness: String,
    val state: String,
    val lastActivity: String,
    val updatedAt: String,
)

internal data class SatelliteMessage(val role: String, val text: String)

internal data class SatelliteSnapshot(
    val nodes: List<SatelliteNode>,
    val projects: List<SatelliteProject>,
    val chats: List<SatelliteChat>,
)

internal data class SatelliteHistory(
    val messages: List<SatelliteMessage>,
    val before: Long,
    val hasMore: Boolean,
)

internal data class SatelliteHarness(val name: String, val provider: String)

internal class SatelliteAuthRequired : IOException("Sign in to this muxterm server")

/** HTTP client for the server's existing SDK chat API. The WebView owns login;
 * native requests borrow its session cookie, like FleetWatchService does. */
internal class SatelliteApi {
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(35, TimeUnit.SECONDS)
        .callTimeout(45, TimeUnit.SECONDS)
        .followRedirects(false)
        .build()

    suspend fun snapshot(server: String): SatelliteSnapshot = withContext(Dispatchers.IO) {
        val localName = Uri.parse(server).host ?: "This server"
        val nodes = mutableListOf(SatelliteNode("", localName, "connected"))
        val projects = mutableListOf<SatelliteProject>()
        val chats = mutableListOf<SatelliteChat>()

        readProjects(server, "", projects)
        readChats(server, "", chats)

        // The home server owns SSH settings. The phone only asks it to relay
        // chat API calls; it never needs SSH keys or a direct link to a node.
        runCatching { request(server, "/api/remotes") }.getOrNull()?.let { response ->
            val seen = mutableSetOf<String>()
            for (group in listOf("connected", "discovered", "errors")) {
                val rows = response.optJSONArray(group) ?: continue
                for (index in 0 until rows.length()) {
                    val row = rows.optJSONObject(index) ?: continue
                    val id = row.optString("id")
                    if (id.isBlank() || !seen.add(id)) continue
                    val state = row.optString("state", group)
                    val name = row.optString("name").ifBlank { id.substringAfter(':') }
                    nodes += SatelliteNode(id, name, state, row.optString("error"))
                    if (state == "connected") {
                        try {
                            readProjects(server, id, projects)
                            readChats(server, id, chats)
                        } catch (error: Exception) {
                            nodes[nodes.lastIndex] = SatelliteNode(id, name, "unreachable", error.message.orEmpty())
                        }
                    }
                }
            }
        }
        SatelliteSnapshot(nodes, projects, chats.sortedByDescending { it.updatedAt })
    }

    suspend fun harnesses(server: String, nodeId: String): List<SatelliteHarness> = withContext(Dispatchers.IO) {
        val rows = requestArray(server, route(nodeId, "/api/sdk-chat-start-options"))
        (0 until rows.length()).mapNotNull { index ->
            rows.optJSONObject(index)?.let { row ->
                val name = row.optString("harness")
                if (name.isBlank()) null else SatelliteHarness(name, row.optString("provider"))
            }
        }
    }

    suspend fun history(server: String, chat: SatelliteChat, before: Long? = null): SatelliteHistory = withContext(Dispatchers.IO) {
        val path = "/api/sdk-chats/${Uri.encode(chat.id)}/history?view=messages" +
            (before?.let { "&before=$it" } ?: "")
        val body = request(server, route(chat.nodeId, path))
        val events = body.optJSONArray("events") ?: JSONArray()
        val messages = mutableListOf<SatelliteMessage>()
        for (index in 0 until events.length()) {
            val event = events.optJSONObject(index) ?: continue
            val type = event.optString("type")
            when (type) {
                "input.accepted" -> {
                    val text = event.optString("text")
                    if (text.isNotBlank()) messages += SatelliteMessage("you", text)
                }
                "assistant.delta" -> {
                    val text = event.optString("text")
                    if (text.isNotBlank()) {
                        val last = messages.lastOrNull()
                        if (last?.role == "assistant") messages[messages.lastIndex] = last.copy(text = last.text + text)
                        else messages += SatelliteMessage("assistant", text)
                    }
                }
                "error", "session.uncertain" -> {
                    val text = event.optString("message")
                    if (text.isNotBlank()) messages += SatelliteMessage("status", text)
                }
            }
        }
        SatelliteHistory(messages, body.optLong("from"), body.optBoolean("hasMore"))
    }

    suspend fun createProject(server: String, nodeId: String, name: String): SatelliteProject = withContext(Dispatchers.IO) {
        val body = request(server, route(nodeId, "/api/sdk-projects"), "POST",
            JSONObject().put("name", name).put("managedFolder", true))
        projectFrom(body, nodeId)
    }

    suspend fun createChat(
        server: String, project: SatelliteProject, harness: SatelliteHarness, prompt: String,
    ): SatelliteChat = withContext(Dispatchers.IO) {
        val body = request(server, route(project.nodeId, "/api/sdk-chats"), "POST",
            JSONObject().put("workspaceId", project.id).put("harness", harness.name)
                .put("provider", harness.provider).put("prompt", prompt))
        chatFrom(body, project.nodeId)
    }

    suspend fun send(server: String, chat: SatelliteChat, text: String) = withContext(Dispatchers.IO) {
        request(server, route(chat.nodeId, "/api/sdk-chats/${Uri.encode(chat.id)}"), "POST",
            JSONObject().put("id", UUID.randomUUID().toString()).put("kind", "user")
                .put("source", "android").put("content", text))
        Unit
    }

    suspend fun stop(server: String, chat: SatelliteChat) = withContext(Dispatchers.IO) {
        request(server, route(chat.nodeId, "/api/sdk-chats/${Uri.encode(chat.id)}/interrupt"), "POST", JSONObject())
        Unit
    }

    private fun readProjects(server: String, nodeId: String, out: MutableList<SatelliteProject>) {
        val rows = requestArray(server, route(nodeId, "/api/sdk-projects"))
        for (index in 0 until rows.length()) rows.optJSONObject(index)?.let { out += projectFrom(it, nodeId) }
    }

    private fun readChats(server: String, nodeId: String, out: MutableList<SatelliteChat>) {
        val rows = requestArray(server, route(nodeId, "/api/sdk-chats?archived=false"))
        for (index in 0 until rows.length()) rows.optJSONObject(index)?.let { out += chatFrom(it, nodeId) }
    }

    private fun projectFrom(row: JSONObject, nodeId: String) = SatelliteProject(
        row.optString("id"), row.optString("name"), row.optString("path"), nodeId)

    private fun chatFrom(row: JSONObject, nodeId: String) = SatelliteChat(
        row.optString("id"), row.optString("title"), row.optString("workspaceId"), nodeId,
        row.optString("harness"), row.optString("state"), row.optString("lastActivity"),
        row.optString("updatedAt", row.optString("createdAt")))

    private fun route(nodeId: String, path: String): String =
        if (nodeId.isBlank()) path else "/api/remote-chat/${Uri.encode(nodeId)}$path"

    private fun requestArray(server: String, path: String): JSONArray = JSONArray(requestText(server, path))

    private fun request(server: String, path: String, method: String = "GET", body: JSONObject? = null): JSONObject =
        JSONObject(requestText(server, path, method, body))

    private fun requestText(server: String, path: String, method: String = "GET", body: JSONObject? = null): String {
        val url = server.trimEnd('/') + path
        // Remote chat routes admit a human browser request. This native,
        // cookie-authenticated client is an explicit human action surface too.
        val builder = Request.Builder().url(url).header("Accept", "application/json")
            .header("Sec-Fetch-Site", "same-origin")
        CookieManager.getInstance().getCookie(server)?.let { builder.header("Cookie", it) }
        if (method != "GET") builder.method(method, (body ?: JSONObject()).toString().toRequestBody("application/json".toMediaType()))
        client.newCall(builder.build()).execute().use { response ->
            if (response.code == 401 || response.code in 300..399) throw SatelliteAuthRequired()
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) throw IOException(text.trim().take(240).ifBlank { "Server returned ${response.code}" })
            return text
        }
    }
}

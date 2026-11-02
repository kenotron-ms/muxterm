package io.ampbox.muxterm

import android.content.Intent
import android.os.Bundle
import android.view.View
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

private val paper = Color(0xFFF7F9FA)
private val ink = Color(0xFF253440)
private val secondary = Color(0xFF657783)
private val line = Color(0xFFDCE3E7)
private val blue = Color(0xFF37698A)
private val green = Color(0xFF1B9C66)
private val amber = Color(0xFFB87927)

/** The Android satellite's primary surface. The full web workspace remains
 * available for features the native client does not yet present. */
class SatelliteActivity : ComponentActivity() {
    private var resumeToken by mutableIntStateOf(0)
    private var sharedText by mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = android.graphics.Color.rgb(247, 249, 250)
        window.navigationBarColor = android.graphics.Color.rgb(247, 249, 250)
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        receiveShare(intent)
        setContent {
            MaterialTheme(
                colorScheme = lightColorScheme(
                    primary = blue, onPrimary = Color.White, surface = paper,
                    onSurface = ink, background = paper, onBackground = ink,
                    outline = line,
                ),
            ) {
                SatelliteScreen(
                    resumeToken = resumeToken,
                    sharedText = sharedText,
                    clearShare = { sharedText = null },
                    openWorkspace = { startActivity(Intent(this, MainActivity::class.java)) },
                )
            }
        }
    }

    override fun onResume() {
        super.onResume()
        resumeToken++
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        receiveShare(intent)
    }

    private fun receiveShare(intent: Intent?) {
        if (intent?.action != Intent.ACTION_SEND || intent.type != "text/plain") return
        sharedText = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim()?.takeIf { it.isNotEmpty() }
    }
}

@Composable
private fun SatelliteScreen(
    resumeToken: Int,
    sharedText: String?,
    clearShare: () -> Unit,
    openWorkspace: () -> Unit,
) {
    val context = LocalContext.current
    val api = remember { SatelliteApi() }
    val scope = rememberCoroutineScope()
    var server by remember { mutableStateOf(UrlResolver.resolveUrl(context)) }
    var snapshot by remember { mutableStateOf<SatelliteSnapshot?>(null) }
    var selectedChat by remember { mutableStateOf<SatelliteChat?>(null) }
    var history by remember { mutableStateOf<SatelliteHistory?>(null) }
    var olderMessages by remember { mutableStateOf<List<SatelliteMessage>>(emptyList()) }
    var olderCursor by remember { mutableStateOf<Long?>(null) }
    var olderHasMore by remember { mutableStateOf<Boolean?>(null) }
    var loading by remember { mutableStateOf(true) }
    var authRequired by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var draft by remember { mutableStateOf("") }
    var showServer by remember { mutableStateOf(false) }
    var showNewProject by remember { mutableStateOf(false) }
    var newChatProject by remember { mutableStateOf<SatelliteProject?>(null) }
    val expanded = remember { mutableStateMapOf<String, Boolean>() }

    LaunchedEffect(sharedText) {
        if (sharedText != null && selectedChat != null) draft = sharedText
    }

    fun discardShare() {
        if (draft == sharedText) draft = ""
        clearShare()
    }

    suspend fun refresh() {
        try {
            val fresh = api.snapshot(server)
            snapshot = fresh
            selectedChat?.let { selected ->
                selectedChat = fresh.chats.firstOrNull { it.id == selected.id && it.nodeId == selected.nodeId } ?: selected
            }
            authRequired = false
            error = ""
        } catch (_: SatelliteAuthRequired) {
            authRequired = true
            snapshot = null
            error = ""
        } catch (failure: Exception) {
            error = failure.message ?: "Could not reach this server"
        } finally {
            loading = false
        }
    }

    LaunchedEffect(server, resumeToken) {
        loading = snapshot == null
        while (isActive) {
            refresh()
            delay(12_000)
        }
    }

    LaunchedEffect(server, selectedChat?.id, selectedChat?.nodeId) {
        history = null
        olderMessages = emptyList()
        olderCursor = null
        olderHasMore = null
        val chat = selectedChat ?: return@LaunchedEffect
        while (isActive) {
            try {
                history = api.history(server, chat)
                error = ""
            } catch (failure: Exception) {
                error = failure.message ?: "Could not load this chat"
            }
            delay(3_000)
        }
    }

    Surface(color = paper, modifier = Modifier.fillMaxSize()) {
        Column {
            if (selectedChat == null) {
                Header(server, snapshot?.nodes?.firstOrNull()?.state == "connected", { showServer = true }, openWorkspace)
                if (sharedText != null) {
                    ShareBanner(sharedText, ::discardShare)
                }
                Row(
                    modifier = Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 7.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("Projects", fontSize = 21.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                    TextButton(onClick = { showNewProject = true }, enabled = !authRequired) { Text("New project") }
                }
                when {
                    authRequired -> CenterState("Sign in to see your projects and chats.", "Sign in", openWorkspace)
                    loading && snapshot == null -> CenterProgress()
                    snapshot == null -> CenterState(error.ifBlank { "Server unavailable" }, "Server settings") { showServer = true }
                    else -> {
                        if (error.isNotBlank()) ErrorLine(error)
                        ProjectList(snapshot!!, expanded, sharedText != null,
                            onProjectChat = { newChatProject = it },
                            onChat = {
                                selectedChat = it
                                if (sharedText != null) draft = sharedText
                            })
                    }
                }
            } else {
                val chat = selectedChat!!
                ChatHeader(chat, snapshot?.nodes?.firstOrNull { it.id == chat.nodeId }?.name ?: "This server",
                    onBack = { selectedChat = null; draft = "" }, openWorkspace)
                if (sharedText != null) ShareBanner(sharedText, ::discardShare)
                if (error.isNotBlank()) ErrorLine(error)
                val messages = olderMessages + (history?.messages ?: emptyList())
                LazyColumn(modifier = Modifier.weight(1f), reverseLayout = false) {
                    if (olderHasMore ?: (history?.hasMore == true)) item {
                        TextButton(onClick = {
                            val before = olderCursor ?: history?.before ?: return@TextButton
                            scope.launch {
                                try {
                                    val page = api.history(server, chat, before)
                                    olderMessages = page.messages + olderMessages
                                    olderCursor = page.before
                                    olderHasMore = page.hasMore
                                } catch (failure: Exception) { error = failure.message.orEmpty() }
                            }
                        }, modifier = Modifier.fillMaxWidth()) { Text("Load earlier messages") }
                    }
                    items(messages) { message -> MessageRow(message) }
                    if (messages.isEmpty()) item { CenterState("This chat has no messages yet.", "Refresh") {
                        scope.launch { history = api.history(server, chat) }
                    } }
                    item { Spacer(Modifier.height(20.dp)) }
                }
                if (chat.state == "working" || chat.state == "starting") {
                    Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 18.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("Agent is working", color = secondary, fontSize = 13.sp, modifier = Modifier.weight(1f))
                        TextButton(onClick = {
                            scope.launch {
                                try { api.stop(server, chat); refresh() }
                                catch (failure: Exception) { error = failure.message.orEmpty() }
                            }
                        }) { Text("Stop") }
                    }
                }
                ChatComposer(draft, { draft = it }, enabled = !busy && chat.state != "working" && chat.state != "starting") {
                    val text = draft.trim()
                    if (text.isEmpty()) return@ChatComposer
                    busy = true
                    scope.launch {
                        try {
                            api.send(server, chat, text)
                            draft = ""
                            if (sharedText != null && text == sharedText) clearShare()
                            history = api.history(server, chat)
                            refresh()
                        } catch (failure: Exception) { error = failure.message ?: "Message was not sent" }
                        finally { busy = false }
                    }
                }
            }
        }
    }

    if (showServer) ServerDialog(server, onDismiss = { showServer = false }, onSave = { url ->
        server = url
        UrlResolver.saveUrl(context, url)
        snapshot = null
        selectedChat = null
        showServer = false
    })
    if (showNewProject) NewProjectDialog(snapshot?.nodes.orEmpty(), onDismiss = { showNewProject = false }, onCreate = { node, name ->
        scope.launch {
            try { api.createProject(server, node.id, name); refresh(); showNewProject = false }
            catch (failure: Exception) { error = failure.message ?: "Project could not be created" }
        }
    })
    newChatProject?.let { project ->
        NewChatDialog(project, sharedText.orEmpty(), api, server, onDismiss = { newChatProject = null }, onCreate = { harness, prompt ->
            scope.launch {
                busy = true
                try {
                    val chat = api.createChat(server, project, harness, prompt)
                    newChatProject = null
                    selectedChat = chat
                    draft = ""
                    if (sharedText != null && prompt == sharedText) clearShare()
                    refresh()
                } catch (failure: Exception) { error = failure.message ?: "Chat could not be created" }
                finally { busy = false }
            }
        })
    }
}

@Composable
private fun Header(server: String, connected: Boolean, serverSettings: () -> Unit, openWorkspace: () -> Unit) {
    Column(modifier = Modifier.fillMaxWidth().padding(start = 20.dp, end = 12.dp, top = 18.dp, bottom = 8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("muxterm", fontSize = 26.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.8).sp,
                modifier = Modifier.weight(1f))
            TextButton(onClick = openWorkspace) { Text("Workspace") }
        }
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.clickable(onClick = serverSettings)) {
            StatusDot(connected)
            Text(server.removePrefix("https://").removePrefix("http://").take(48),
                color = secondary, fontSize = 13.sp, modifier = Modifier.padding(start = 7.dp))
            Text("  ·  Change server", color = blue, fontSize = 13.sp)
        }
    }
    HorizontalDivider(color = line)
}

@Composable
private fun ShareBanner(text: String, discard: () -> Unit) {
    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Ready to share", fontWeight = FontWeight.SemiBold, color = blue, modifier = Modifier.weight(1f))
            TextButton(onClick = discard) { Text("Discard") }
        }
        Text(text.take(150), maxLines = 2, overflow = TextOverflow.Ellipsis, fontSize = 13.sp, color = secondary)
        Text("Choose a chat or start one. Nothing is sent until you press Send.", fontSize = 12.sp, color = secondary)
    }
    HorizontalDivider(color = line)
}

@Composable
private fun ProjectList(
    snapshot: SatelliteSnapshot,
    expanded: MutableMap<String, Boolean>,
    hasShare: Boolean,
    onProjectChat: (SatelliteProject) -> Unit,
    onChat: (SatelliteChat) -> Unit,
) {
    LazyColumn(modifier = Modifier.fillMaxSize()) {
        for (node in snapshot.nodes) {
            item(key = "node:${node.id}") { NodeRow(node) }
            val projects = snapshot.projects.filter { it.nodeId == node.id }
                .sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.name })
            for (project in projects) {
                val key = "${node.id}:${project.id}"
                item(key = "project:$key") {
                    ProjectRow(project, node.id.isNotBlank(), expanded[key] != false,
                        onToggle = { expanded[key] = expanded[key] == false },
                        onNewChat = { onProjectChat(project) })
                }
                if (expanded[key] != false) {
                    val chats = snapshot.chats.filter { it.nodeId == node.id && it.projectId == project.id }
                    for (chat in chats) item(key = "chat:${node.id}:${chat.id}") { ChatListRow(chat, hasShare) { onChat(chat) } }
                    if (chats.isEmpty()) item(key = "empty:$key") {
                        Text("No chats yet", color = secondary, fontSize = 13.sp,
                            modifier = Modifier.padding(start = 52.dp, top = 4.dp, bottom = 13.dp))
                    }
                }
            }
            if (projects.isEmpty()) item(key = "empty-node:${node.id}") {
                Text(if (node.state == "connected") "No projects on this node" else "Connect this node in the workspace",
                    color = secondary, fontSize = 13.sp, modifier = Modifier.padding(start = 22.dp, bottom = 14.dp))
            }
        }
        if (snapshot.nodes.size == 1 && snapshot.projects.isEmpty()) item {
            Text("Create a project to start a chat on this server.", color = secondary,
                modifier = Modifier.padding(20.dp))
        }
    }
}

@Composable
private fun NodeRow(node: SatelliteNode) {
    Row(modifier = Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 18.dp, bottom = 7.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Text(if (node.id.isBlank()) "This server" else node.name, fontWeight = FontWeight.SemiBold,
            fontSize = 13.sp, color = secondary, modifier = Modifier.weight(1f))
        Text(if (node.state == "connected") "Connected" else node.state.replaceFirstChar { it.uppercase() },
            fontSize = 12.sp, color = secondary)
        Spacer(Modifier.size(6.dp))
        StatusDot(node.state == "connected")
    }
}

@Composable
private fun ProjectRow(project: SatelliteProject, remote: Boolean, expanded: Boolean, onToggle: () -> Unit, onNewChat: () -> Unit) {
    Row(modifier = Modifier.fillMaxWidth().clickable(onClick = onToggle).padding(start = 19.dp, end = 12.dp, top = 10.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically) {
        FolderMark(remote)
        Column(modifier = Modifier.weight(1f).padding(start = 10.dp)) {
            Text(project.name, fontSize = 16.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (remote) Text("Network project", fontSize = 11.sp, color = secondary)
        }
        TextButton(onClick = onNewChat) { Text("New chat") }
        Text(if (expanded) "⌄" else "›", color = secondary, fontSize = 21.sp, modifier = Modifier.padding(start = 3.dp))
    }
}

@Composable
private fun ChatListRow(chat: SatelliteChat, hasShare: Boolean, onClick: () -> Unit) {
    Row(modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(start = 50.dp, end = 20.dp, top = 9.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Column(modifier = Modifier.weight(1f)) {
            Text(chat.title.ifBlank { "Untitled chat" }, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val activity = chat.lastActivity.ifBlank { chat.harness.replaceFirstChar { it.uppercase() } }
            Text(activity, fontSize = 12.sp, color = secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (chat.state == "working") StatusDot(true)
        else if (chat.state == "blocked" || chat.state == "uncertain") Text("Needs attention", color = amber, fontSize = 11.sp)
        else if (hasShare) Text("Share here", color = blue, fontSize = 11.sp)
    }
}

@Composable
private fun ChatHeader(chat: SatelliteChat, node: String, onBack: () -> Unit, openWorkspace: () -> Unit) {
    Row(modifier = Modifier.fillMaxWidth().padding(start = 8.dp, end = 12.dp, top = 6.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically) {
        TextButton(onClick = onBack) { Text("‹ Projects", fontSize = 15.sp) }
        Column(modifier = Modifier.weight(1f).padding(start = 4.dp)) {
            Text(chat.title.ifBlank { "Untitled chat" }, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("$node  ·  ${chat.harness}", color = secondary, fontSize = 11.sp)
        }
        TextButton(onClick = openWorkspace) { Text("More") }
    }
    HorizontalDivider(color = line)
}

@Composable
private fun MessageRow(message: SatelliteMessage) {
    val isUser = message.role == "you"
    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 8.dp),
        horizontalAlignment = if (isUser) Alignment.End else Alignment.Start) {
        Text(if (isUser) "You" else if (message.role == "status") "Status" else "Assistant",
            color = secondary, fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(start = 10.dp, end = 10.dp, bottom = 4.dp))
        Surface(color = if (isUser) Color(0xFFE6F0F5) else Color.White,
            shape = RoundedCornerShape(15.dp), shadowElevation = if (isUser) 0.dp else 1.dp) {
            Text(message.text, modifier = Modifier.padding(horizontal = 14.dp, vertical = 11.dp),
                color = ink, fontSize = 15.sp, lineHeight = 22.sp)
        }
    }
}

@Composable
private fun ChatComposer(value: String, onChange: (String) -> Unit, enabled: Boolean, onSend: () -> Unit) {
    HorizontalDivider(color = line)
    Row(modifier = Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.Bottom) {
        OutlinedTextField(value = value, onValueChange = onChange, modifier = Modifier.weight(1f),
            placeholder = { Text("Message") }, enabled = enabled, maxLines = 5,
            shape = RoundedCornerShape(20.dp))
        Spacer(Modifier.size(8.dp))
        Button(onClick = onSend, enabled = enabled && value.isNotBlank(),
            colors = ButtonDefaults.buttonColors(containerColor = blue), modifier = Modifier.padding(bottom = 5.dp)) { Text("Send") }
    }
}

@Composable
private fun NewProjectDialog(nodes: List<SatelliteNode>, onDismiss: () -> Unit, onCreate: (SatelliteNode, String) -> Unit) {
    var name by remember { mutableStateOf("") }
    var selected by remember { mutableStateOf(nodes.firstOrNull { it.state == "connected" }) }
    AlertDialog(onDismissRequest = onDismiss, title = { Text("New project") },
        text = {
            Column {
                Text("Create a project folder on a connected node.", color = secondary, fontSize = 13.sp)
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(name, { name = it }, label = { Text("Project name") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { if (name.isNotBlank() && selected != null) onCreate(selected!!, name.trim()) }))
                Spacer(Modifier.height(12.dp))
                nodes.filter { it.state == "connected" }.forEach { node ->
                    Row(modifier = Modifier.fillMaxWidth().clickable { selected = node }, verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(selected = selected?.id == node.id, onClick = { selected = node })
                        Text(if (node.id.isBlank()) "This server" else node.name)
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = { selected?.let { onCreate(it, name.trim()) } }, enabled = name.isNotBlank() && selected != null) { Text("Create") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } })
}

@Composable
private fun NewChatDialog(
    project: SatelliteProject, sharedText: String, api: SatelliteApi, server: String,
    onDismiss: () -> Unit, onCreate: (SatelliteHarness, String) -> Unit,
) {
    var prompt by remember(project.id, sharedText) { mutableStateOf(sharedText) }
    var options by remember(project.id) { mutableStateOf<List<SatelliteHarness>>(emptyList()) }
    var selected by remember(project.id) { mutableStateOf<SatelliteHarness?>(null) }
    var loadError by remember(project.id) { mutableStateOf("") }
    LaunchedEffect(server, project.id, project.nodeId) {
        try {
            options = api.harnesses(server, project.nodeId)
            selected = options.firstOrNull()
        } catch (failure: Exception) { loadError = failure.message ?: "Could not load agents" }
    }
    AlertDialog(onDismissRequest = onDismiss, title = { Text("New chat in ${project.name}") },
        text = {
            Column {
                Text(if (project.nodeId.isBlank()) "Runs on this server" else "Runs on ${project.nodeId.substringAfter(':')}",
                    color = secondary, fontSize = 13.sp)
                Spacer(Modifier.height(10.dp))
                if (loadError.isNotBlank()) Text(loadError, color = amber, fontSize = 13.sp)
                if (options.isEmpty() && loadError.isBlank()) CircularProgressIndicator(modifier = Modifier.size(22.dp))
                options.forEach { harness ->
                    Row(modifier = Modifier.fillMaxWidth().clickable { selected = harness }, verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(selected = selected == harness, onClick = { selected = harness })
                        Text(harness.name.replaceFirstChar { it.uppercase() })
                    }
                }
                Spacer(Modifier.height(10.dp))
                OutlinedTextField(prompt, { prompt = it }, label = { Text("First message") }, minLines = 3, maxLines = 7)
            }
        },
        confirmButton = { TextButton(onClick = { selected?.let { onCreate(it, prompt.trim()) } }, enabled = selected != null && prompt.isNotBlank()) { Text("Start chat") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } })
}

@Composable
private fun ServerDialog(current: String, onDismiss: () -> Unit, onSave: (String) -> Unit) {
    var url by remember { mutableStateOf(current) }
    val valid = remember(url) {
        val parsed = android.net.Uri.parse(url.trim())
        parsed.host != null && (parsed.scheme == "https" ||
            (parsed.scheme == "http" && parsed.host in listOf("localhost", "127.0.0.1", "10.0.2.2")))
    }
    AlertDialog(onDismissRequest = onDismiss, title = { Text("Muxterm server") },
        text = {
            Column {
                Text("Use the address you open in a browser. Sign in once through the workspace.", color = secondary, fontSize = 13.sp)
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(url, { url = it }, label = { Text("Server URL") }, singleLine = true)
                if (!valid) Text("Use HTTPS, or HTTP on localhost for development.", color = amber, fontSize = 12.sp)
            }
        },
        confirmButton = { TextButton(onClick = { onSave(url.trim().trimEnd('/')) }, enabled = valid) { Text("Connect") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } })
}

@Composable
private fun CenterProgress() {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
}

@Composable
private fun CenterState(message: String, action: String, onAction: () -> Unit) {
    Column(modifier = Modifier.fillMaxWidth().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(message, color = secondary)
        Spacer(Modifier.height(10.dp))
        Button(onClick = onAction) { Text(action) }
    }
}

@Composable
private fun ErrorLine(message: String) {
    Text(message, color = Color(0xFF9A3D36), fontSize = 12.sp,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp))
}

@Composable
private fun StatusDot(connected: Boolean) {
    Canvas(modifier = Modifier.size(8.dp)) { drawCircle(if (connected) green else amber) }
}

@Composable
private fun FolderMark(remote: Boolean) {
    Canvas(modifier = Modifier.size(22.dp)) {
        val path = Path().apply {
            moveTo(size.width * .08f, size.height * .28f)
            lineTo(size.width * .42f, size.height * .28f)
            lineTo(size.width * .52f, size.height * .39f)
            lineTo(size.width * .92f, size.height * .39f)
            lineTo(size.width * .84f, size.height * .82f)
            lineTo(size.width * .13f, size.height * .82f)
            close()
        }
        drawPath(path, if (remote) blue else secondary)
        if (remote) drawCircle(green, radius = size.minDimension * .13f,
            center = androidx.compose.ui.geometry.Offset(size.width * .79f, size.height * .78f))
    }
}

// pi-acp accepts ACP mcpServers but does not mount them in Pi. Register the
// same servers with Pi's native extension API for this chat process.
export default function (pi) {
  if (typeof pi.registerMcpServer !== 'function')
    throw new Error('This Pi version cannot register muxterm connector servers');
  for (const server of JSON.parse(process.env.MUXTERM_ACP_MCP_SERVERS || '[]')) {
    pi.registerMcpServer(server.name, {
      command: server.command,
      args: server.args,
      env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])),
    });
  }
}

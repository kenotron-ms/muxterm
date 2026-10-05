# Google Workspace connection presets

The Gmail, Drive, Calendar, Docs, Sheets, and Slides cards use Google's official
remote service endpoints. Muxterm fixes each card's endpoint and requested
read scopes on the server. Registration uses the owner's Google Web OAuth
client ID and secret, the protected-resource metadata published by the service,
and Google's advertised OAuth issuer. A Google connection is not available to
chats until the user authorizes it, a real service check discovers tools, and
the user explicitly enables selected tools. The server restricts preset tools
to reviewed read operations even if the remote tool catalog changes.

Google's official remote services are in the Google Workspace Developer Preview.
The program requires an enrolled Google Workspace account and Cloud project;
these presets are not a supported route for a personal `@gmail.com` account.
Google's preview terms also prohibit including these services in public apps
before general availability. A shared Muxterm app registration would not remove
those limits. Eligible preview testing requires the product API and its MCP API
enabled in the enrolled project, an OAuth consent screen, and a Web OAuth client
with the callback URL shown by muxterm. External apps may need test users and
scope verification. Muxterm requests offline access and re-consent so a durable
refresh token can be stored locally. Google may classify mail and file scopes
as sensitive or restricted; external testing refresh tokens may expire after
seven days.

After these MCP services reach general availability, a Muxterm-owned Google
Cloud project could carry one consent screen and clients for each supported
platform. One Web client can be reused across product MCP endpoints on the same
origin, but Google requires exact registered redirect URIs: a single Web client
does not automatically cover arbitrary self-hosted Muxterm origins. Production
Gmail access also requires Google's restricted-scope verification. Handling
restricted Gmail data on a third-party server may require an independent
security assessment. Do not ship a shared client ID or promise personal Gmail
access until registration, verification, and deployment are resolved.

These presets have been checked against public metadata, but no credentialed
Google authorization or tool call has been completed here. The pinned Go MCP
SDK defaults to protocol version 2025-06-18; Google documents support for
2026-07-28. Legacy protocol negotiation must be verified with a real account
before describing the presets as operational. The UI continues to label them
Developer Preview and setup required until a successful authorization and
tool check.

Sources: [Google Workspace Developer Preview terms](https://developers.google.com/workspace/preview),
[Google Workspace setup](https://developers.google.com/workspace/guides/configure-mcp-servers),
[Google OAuth offline access](https://developers.google.com/identity/protocols/oauth2/web-server),
[Google OAuth client policies](https://developers.google.com/identity/protocols/oauth2/policies),
[Google scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification),
[Google MCP authentication](https://docs.cloud.google.com/mcp/authenticate-mcp),
and [Go MCP SDK protocol support](https://github.com/modelcontextprotocol/go-sdk).

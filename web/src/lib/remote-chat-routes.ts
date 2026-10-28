const chatHosts = new Map<string,string>();
const projectHosts = new Map<string,string>();

export function rememberChatHost(id:string, host:string) { if (host) chatHosts.set(id,host); else chatHosts.delete(id); }
export function rememberProjectHost(id:string, host:string) { if (host) projectHosts.set(id,host); else projectHosts.delete(id); }
export function chatHost(id:string):string { return chatHosts.get(id) || ''; }
export function projectHost(id:string):string { return projectHosts.get(id) || ''; }
export function remoteChatPath(host:string, path:string):string {
  return host ? `/api/remote-chat/${encodeURIComponent(host)}${path}` : path;
}
export function routeChatPath(path:string):string {
  const chat = /^\/api\/sdk-chats\/([^/?]+)/.exec(path);
  if (chat && chat[1] !== 'search-content') return remoteChatPath(chatHost(decodeURIComponent(chat[1])),path);
  const project = /^\/api\/sdk-projects\/([^/?]+)/.exec(path);
  if (project) return remoteChatPath(projectHost(decodeURIComponent(project[1])),path);
  return path;
}

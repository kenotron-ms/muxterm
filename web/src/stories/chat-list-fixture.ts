import { sdkChats, type SDKChat, type SDKProject } from '../lib/sdk-chats.js';
import { fixtureJSON, type ApiFixture } from './api-fixture.js';

const initialProjects: SDKProject[] = [
  { id:'atlas', name:'Atlas', path:'/home/demo/atlas', sourceFolders:['/home/demo/notes'], pinned:true },
  { id:'research', name:'Research', path:'/home/demo/research', sourceFolders:[] },
];

const initialChats: SDKChat[] = [
  { id:'chat-editor', workspaceId:'atlas', projectPath:'/home/demo/atlas', title:'Refine workspace navigation', harness:'codex', state:'working', pinned:true, createdAt:'2026-10-21T12:00:00Z' },
  { id:'chat-build', workspaceId:'atlas', projectPath:'/home/demo/atlas', title:'Build and deployment logs', harness:'claude', state:'blocked', createdAt:'2026-10-21T11:00:00Z' },
  { id:'chat-notes', workspaceId:'research', projectPath:'/home/demo/research', title:'Review research notes and prepare a detailed handoff for the next team', harness:'pi', state:'idle', createdAt:'2026-10-20T10:00:00Z' },
  { id:'chat-unfiled', projectPath:'/home/demo', title:'Investigate terminal rendering', harness:'opencode', state:'idle', createdAt:'2026-10-19T09:00:00Z' },
];

const initialArchived: SDKChat[] = [
  { id:'chat-archived-1', workspaceId:'atlas', projectPath:'/home/demo/atlas', title:'Completed release checklist', harness:'codex', state:'done', archived:true, createdAt:'2026-10-18T09:00:00Z' },
  { id:'chat-archived-2', workspaceId:'research', projectPath:'/home/demo/research', title:'Previous design review', harness:'claude', state:'done', archived:true, createdAt:'2026-10-17T09:00:00Z' },
];

let projects: SDKProject[] = [];
let chats: SDKChat[] = [];
let archived: SDKChat[] = [];

export function resetChatListFixture(empty = false, linkedLane = false): void {
  projects = empty ? [] : initialProjects.map(project => ({...project, sourceFolders:[...(project.sourceFolders ?? [])]}));
  chats = empty ? [] : initialChats.map(chat => ({...chat}));
  if (linkedLane) chats.unshift({ id:'chat-operator', workspaceId:'atlas', projectPath:'/home/demo/atlas', title:'Coordinate workspace navigation', harness:'codex', state:'working', operator:true, operatorLanes:['chat-build'], createdAt:'2026-10-21T13:00:00Z' });
  archived = empty ? [] : initialArchived.map(chat => ({...chat}));
  sdkChats.projects = projects;
  sdkChats.chats = [...chats, ...archived];
}

export function chatListStoryModel(projectId = 'atlas') {
  const project = projects.find(row => row.id === projectId)!;
  return { id:project.id, name:project.name, project, chats:chats.filter(chat => chat.workspaceId === project.id), laneIds:new Set<string>() };
}

export const chatListFixture: ApiFixture = ({url,method,init}) => {
  if (method === 'GET' && url.pathname.endsWith('/api/sdk-chats') && url.searchParams.has('archived')) {
    const query = (url.searchParams.get('q') ?? '').toLowerCase();
    const found = archived.filter(chat => `${chat.title} ${chat.projectPath}`.toLowerCase().includes(query));
    return fixtureJSON({chats:found,total:found.length});
  }
  if (method === 'GET' && url.pathname.endsWith('/api/sdk-chats')) return fixtureJSON([...chats, ...archived]);
  if (method === 'GET' && url.pathname.endsWith('/api/sdk-projects')) return fixtureJSON(projects);
  if (method === 'GET' && url.pathname.endsWith('/api/sdk-folders')) {
    const path = url.searchParams.get('path') || '/home/demo/atlas';
    return fixtureJSON({path,base:'/home/demo',parent:path.slice(0,path.lastIndexOf('/')) || '/',folders:path === '/home/demo/atlas' ? ['web','docs'] : []});
  }
  const projectId = url.pathname.match(/\/api\/sdk-projects\/([^/]+)$/)?.[1];
  if (projectId && method === 'PATCH') {
    const change = JSON.parse(String(init?.body ?? '{}')) as Partial<SDKProject>;
    projects = projects.map(project => project.id === projectId ? {...project,...change} : project);
    return fixtureJSON(projects.find(project => project.id === projectId));
  }
  if (projectId && method === 'DELETE') {
    projects = projects.filter(project => project.id !== projectId);
    chats = chats.map(chat => chat.workspaceId === projectId ? {...chat,workspaceId:''} : chat);
    archived = archived.map(chat => chat.workspaceId === projectId ? {...chat,workspaceId:''} : chat);
    return fixtureJSON({ok:true});
  }
  const chatId = url.pathname.match(/\/api\/sdk-chats\/([^/]+)$/)?.[1];
  if (chatId && method === 'PATCH') {
    const change = JSON.parse(String(init?.body ?? '{}')) as Partial<SDKChat>;
    chats = chats.map(chat => chat.id === chatId ? {...chat,...change} : chat);
    archived = archived.map(chat => chat.id === chatId ? {...chat,...change} : chat);
    if (change.archived === true) {
      const row = chats.find(chat => chat.id === chatId);
      if (row) { archived = [...archived,row]; chats = chats.filter(chat => chat.id !== chatId); }
      chats = chats.map(chat => chat.operatorLanes?.includes(chatId) ? {...chat,operatorLanes:chat.operatorLanes.filter(id => id !== chatId)} : chat);
    }
    if (change.archived === false) { const row = archived.find(chat => chat.id === chatId); if (row) { chats = [...chats,row]; archived = archived.filter(chat => chat.id !== chatId); } }
    return fixtureJSON({ok:true});
  }
  return fixtureJSON({error:`No chat-list fixture for ${method} ${url.pathname}`},501);
};

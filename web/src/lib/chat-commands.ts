export type ChatCommandInvocation = { name: 'goal'; action: 'inspect' | 'set' | 'pause' | 'resume' | 'clear'; condition?: string };

type CommandDefinition = {
  name: string;
  suggestions: { label: string; description: string; insert: string }[];
  parse: (args: string) => ChatCommandInvocation | null;
};

// Muxterm commands live here. Other leading-slash text passes through to the
// selected harness, so its own commands remain available.
const commands: CommandDefinition[] = [{
  name: 'goal',
  suggestions: [
    { label: '/goal', description: 'View or set the goal', insert: '/goal ' },
    { label: '/goal pause', description: 'Pause the current goal', insert: '/goal pause' },
    { label: '/goal resume', description: 'Resume the approved goal', insert: '/goal resume' },
    { label: '/goal clear', description: 'Clear the current goal', insert: '/goal clear' },
  ],
  parse(args) {
    const value = args.trim();
    if (!value) return { name:'goal', action:'inspect' };
    if (value === 'pause' || value === 'resume' || value === 'clear') return { name:'goal', action:value };
    return { name:'goal', action:'set', condition:value };
  },
}];

export function chatCommandSuggestions(draft: string) {
  if (!draft.startsWith('/') || draft.includes('\n')) return [];
  const query = draft.toLowerCase();
  if (!/\s/.test(draft)) return commands.map(command => command.suggestions[0]).filter(item => item.label.startsWith(query));
  const command = commands.find(item => query.startsWith(`/${item.name} `));
  return command?.suggestions.slice(1).filter(item => item.label.startsWith(query)) || [];
}

export function parseChatCommand(text: string): ChatCommandInvocation | null {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) return null;
  return commands.find(command => command.name === match[1])?.parse(match[2] || '') || null;
}

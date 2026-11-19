import { apiPath } from './base-path.js';

export interface MeetingTURNStatus {
  urls: string[];
  server: string;
  source: 'stored' | 'environment' | 'none';
  authConfigured: boolean;
  localSecretAvailable: boolean;
  mode: 'shared-secret' | 'service';
  apiUrl?: string;
}

async function responseError(res: Response): Promise<Error> {
  const detail = (await res.text()).trim();
  return new Error(detail || `TURN settings request failed (${res.status}).`);
}

export async function fetchMeetingTURNSettings(): Promise<MeetingTURNStatus> {
  const res = await fetch(apiPath('/api/meetings/turn-settings'));
  if (!res.ok) throw await responseError(res);
  return await res.json() as MeetingTURNStatus;
}

export async function saveMeetingTURNSettings(server: string, secret: string): Promise<MeetingTURNStatus> {
  const res = await fetch(apiPath('/api/meetings/turn-settings'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ server, secret }),
  });
  if (!res.ok) throw await responseError(res);
  return await res.json() as MeetingTURNStatus;
}

export async function saveMeetingTURNServiceSettings(apiUrl: string, apiKey: string): Promise<MeetingTURNStatus> {
  const res = await fetch(apiPath('/api/meetings/turn-settings'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiUrl, apiKey }),
  });
  if (!res.ok) throw await responseError(res);
  return await res.json() as MeetingTURNStatus;
}

export async function clearMeetingTURNSettings(): Promise<MeetingTURNStatus> {
  const res = await fetch(apiPath('/api/meetings/turn-settings'), { method: 'DELETE' });
  if (!res.ok) throw await responseError(res);
  return await res.json() as MeetingTURNStatus;
}

import { LitElement, html, nothing, type PropertyValues } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { AudioLines, Copy, Download, Mic, MicOff, MonitorUp, Plus, RefreshCw, Square, Trash2, Video, VideoOff, X } from 'lucide';
import { apiPath } from '../lib/base-path.js';
import { icon } from '../lib/icons.js';
import '../ui/button.js';
import '../ui/dialog.js';
import '../ui/empty-state.js';
import '../ui/feedback.js';
import '../ui/rail-row.js';
import '../ui/text-field.js';
import type { MuxUITextField } from '../ui/text-field.js';

type Meeting = { id:string; chatId:string; title:string; kind:'recording'|'call'; startedAt:string; endedAt?:string; participants:string[]; recordingState:string; transcriptState:string; transcriptError?:string; linkedNoteId?:string; mediaType?:string; mediaBytes:number; chunks:number; error?:string };
type Transcript = { revision:number; segments:{id:string;startMs:number;endMs:number;text:string;speaker:string}[]; corrections:Record<string,string> };
type LocalChunk = { key:string; blob:Blob };
type CallRoute = 'checking'|'direct'|'relay'|'stalled'|'failed';
type CallNetwork = { route:CallRoute; ice:string; localType?:string; remoteType?:string; protocol?:string; relayProtocol?:string; errorCode?:number; turnConfigured:boolean };
type CandidateStat = { id:string; type:string; selectedCandidatePairId?:string; localCandidateId?:string; remoteCandidateId?:string; state?:string; nominated?:boolean; candidateType?:string; protocol?:string; relayProtocol?:string };

function hasTurnServer(servers:RTCIceServer[]) {
  return servers.some(server => [server.urls].flat().some(url => /^turns?:/i.test(url)));
}

function localMediaDB(): Promise<IDBDatabase> {
  return new Promise((resolve,reject) => {
    const request = indexedDB.open('muxterm-meeting-capture',1);
    request.onupgradeneeded = () => request.result.createObjectStore('chunks',{keyPath:'key'});
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function chunkStore<T>(mode:IDBTransactionMode, run:(store:IDBObjectStore)=>IDBRequest<T>):Promise<T> {
  const db = await localMediaDB();
  try { return await new Promise<T>((resolve,reject) => {
    const tx = db.transaction('chunks',mode);
    const request = run(tx.objectStore('chunks'));
    let result:T;
    request.onsuccess = () => { result=request.result; };
    request.onerror = () => reject(request.error);
    tx.onerror = () => reject(tx.error);
    tx.oncomplete = () => resolve(result);
  }); } finally { db.close(); }
}

function stopMediaRecorder(recorder:MediaRecorder):Promise<void> {
  if (recorder.state==='inactive') return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const timeout=window.setTimeout(()=>reject(new Error('Recorder did not stop; saved chunks remain recoverable.')),3000);
    recorder.addEventListener('stop',()=>{window.clearTimeout(timeout);resolve();},{once:true});
    try { recorder.stop(); } catch(error) { window.clearTimeout(timeout);reject(error); }
  });
}

@customElement('mux-meetings')
export class MuxMeetings extends LitElement {
  @property({attribute:false}) sessionId = '';
  private meetings:Meeting[] = [];
  private selectedId = '';
  private query = '';
  private loading = false;
  private error = '';
  private preparation = false;
  private recordingStarting = false;
  private recordingStopping = false;
  private stream?:MediaStream;
  private recorder?:MediaRecorder;
  private activeId = '';
  private uploadQueue:Promise<void> = Promise.resolve();
  private nextChunk = 0;
  private captureError = '';
  private startTime = 0;
  private elapsed = 0;
  private timer?:number;
  private devices:MediaDeviceInfo[] = [];
  private deviceId = '';
  private inputLevel = 0;
  private inputAudio?:AudioContext;
  private inputAnalyser?:AnalyserNode;
  private inputMeterTimer?:number;
  private deleteId = '';
  private refreshing?:number;
  private callPreparing = false;
  private callStarting = false;
  private callLeaving = false;
  private callRecordingStarting = false;
  private callPreparationSeq = 0;
  private callHostingError = '';
  private callStream?:MediaStream;
  private callAudioDevices:MediaDeviceInfo[] = [];
  private callVideoDevices:MediaDeviceInfo[] = [];
  private callAudioDeviceId = '';
  private callVideoDeviceId = '';
  private callId = '';
  private callPeer?:RTCPeerConnection;
  private remoteStream?:MediaStream;
  private screenStream?:MediaStream;
  private remoteScreen?:MediaStream;
  private shareSender?:RTCRtpSender;
  private callCursor = 0;
  private callPollTimer?:number;
  private callPolling = false;
  private callStatus = '';
  private callNetwork:CallNetwork = {route:'checking',ice:'new',turnConfigured:false};
  private lastNetworkCheck = 0;
  private callAttemptAt = 0;
  private inviteUrl = '';
  private guestJoined = false;
  private offerSent = false;
  private hostMakingOffer = false;
  private callReady = false;
  private pendingICE:RTCIceCandidateInit[] = [];
  private callRecorder?:MediaRecorder;
  private callRecording = false;
  private callCanvas?:HTMLCanvasElement;
  private callDrawTimer?:number;
  private callAudio?:AudioContext;
  private callRecordStream?:MediaStream;
  private transcript?:Transcript;
  private transcriptMeetingId = '';
  private correctionDraft:Record<string,string> = {};
  private transcriptBusy = false;
  private transcriptNotice = '';
  private loadRequest = 0;
  private sampleScene = '';
  private sampleMicOn = true;
  private sampleCameraOn = true;
  private locallyRecoverable = new Set<string>();

  override createRenderRoot() { return this; }
  override connectedCallback() {
    super.connectedCallback();
    this.refreshing = window.setInterval(() => { if (!this.activeId && !this.hidden) void this.load(false); },10000);
  }
  override willUpdate(changed:PropertyValues<this>) {
    if (changed.has('sessionId')) {
      if (changed.get('sessionId')) {
        this.teardown();
      }
      this.meetings=[];this.selectedId='';this.transcript=undefined;this.transcriptMeetingId='';this.captureError='';
      this.locallyRecoverable.clear();
      void this.load();
    }
  }
  override disconnectedCallback() {
    super.disconnectedCallback();
    this.teardown();
    if (this.refreshing) window.clearInterval(this.refreshing);
  }
  private teardown() {
    this.callPreparationSeq++;
    if (this.callPollTimer) window.clearInterval(this.callPollTimer);
    if (this.timer) window.clearInterval(this.timer);
    this.timer=undefined;
    if (this.activeId) void this.stopRecording();
    if (this.callId) {
      void this.leaveCall();
      this.callPeer?.close();
      this.callStream?.getTracks().forEach(track=>track.stop());
      this.screenStream?.getTracks().forEach(track=>track.stop());
    }
    else {
      this.callStream?.getTracks().forEach(track=>track.stop());
      this.screenStream?.getTracks().forEach(track=>track.stop());
      this.releaseCallCapture();
    }
    if (!this.activeId) this.stream?.getTracks().forEach(track=>track.stop());
    this.stopInputMeter();
  }
  private base() { return apiPath(`/api/sdk-chats/${encodeURIComponent(this.sessionId)}/meetings`); }
  private path(id:string, suffix='') { return `${this.base()}/${encodeURIComponent(id)}${suffix}`; }
  private selected() { return this.meetings.find(item => item.id === this.selectedId); }
  /** Storybook uses this production component with explicit sample state. */
  showSample(scene:'library'|'review'|'recorder'|'preflight'|'hosting-required'|'waiting'|'call'|'relay'|'stalled'|'failed'|'share'|'recording'|'recording-share') {
    this.loadRequest++;
    this.sampleScene=scene;
    this.loading=false;
    this.sampleMicOn=true;
    this.sampleCameraOn=true;
    const now=new Date().toISOString();
    const recording:Meeting={id:'sample-recording',chatId:this.sessionId,title:'Product review',kind:'recording',startedAt:new Date(Date.now()-28*60*1000).toISOString(),endedAt:now,participants:['You','Mara'],recordingState:'ready',transcriptState:'ready',mediaType:'audio/webm',mediaBytes:2400000,chunks:4};
    const call:Meeting={id:'sample-call',chatId:this.sessionId,title:'Design review',kind:'call',startedAt:new Date(Date.now()-8*60*1000).toISOString(),participants:['You','Mara'],recordingState:'not_started',transcriptState:'not_started',mediaBytes:0,chunks:0};
    this.meetings=[recording,call];
    this.selectedId=scene==='library'||scene==='preflight'||scene==='hosting-required'?'':scene==='review'||scene==='recorder'?'sample-recording':'sample-call';
    this.callPreparing=scene==='preflight'||scene==='hosting-required';
    this.callHostingError=scene==='hosting-required'?'Host Muxterm at a public HTTPS address, then set [server] behind_reverse_proxy = true and public_origin before inviting a guest.':'';
    this.callStream=scene==='preflight'||['waiting','call','relay','stalled','failed','share','recording','recording-share'].includes(scene)?new MediaStream():undefined;
    this.callId=['waiting','call','relay','stalled','failed','share','recording','recording-share'].includes(scene)?'sample-call':'';
    this.callStatus=scene==='waiting'?'Waiting for a guest':scene==='failed'?'Connection failed · sample call':scene==='stalled'?'Still connecting · sample call':'Connected · sample call';
    this.guestJoined=scene!=='waiting';
    this.callNetwork=scene==='relay'?{route:'relay',ice:'connected',localType:'relay',remoteType:'host',protocol:'udp',relayProtocol:'udp',turnConfigured:true}:scene==='failed'?{route:'failed',ice:'failed',errorCode:701,turnConfigured:true}:scene==='stalled'?{route:'stalled',ice:'new',turnConfigured:false}:{route:scene==='waiting'?'checking':'direct',ice:scene==='waiting'?'new':'connected',localType:scene==='waiting'?undefined:'host',remoteType:scene==='waiting'?undefined:'host',protocol:scene==='waiting'?undefined:'udp',turnConfigured:false};
    this.screenStream=scene==='share'||scene==='recording-share'?new MediaStream():undefined;
    this.callRecording=scene==='recording'||scene==='recording-share';
    this.inviteUrl='Sample invite · access limited to this meeting';
    this.activeId=scene==='recorder'?'sample-recording':'';
    this.elapsed=42;
    this.inputLevel=scene==='recorder'?38:0;
    if(scene==='review'){
      this.transcriptMeetingId='sample-recording';
      this.transcript={revision:1,segments:[{id:'sample-segment-1',startMs:1200,endMs:5600,text:'The notes tab should open directly to the library.',speaker:'Unknown speaker'},{id:'sample-segment-2',startMs:6800,endMs:11600,text:'We will share the screen while reviewing the call.',speaker:'Unknown speaker'}],corrections:{}};
      this.correctionDraft={};
    }
    this.requestUpdate();
  }
  private async load(showLoading=true) {
    if (this.sampleScene) return;
    if (!this.sessionId) return;
    const request=++this.loadRequest,sessionId=this.sessionId;
    if (showLoading) { this.loading = true; this.requestUpdate(); }
    try {
      const response = await fetch(this.base());
      if (!response.ok) throw new Error(`Meetings unavailable (${response.status})`);
      const meetings=await response.json() as Meeting[];
      if (request!==this.loadRequest || sessionId!==this.sessionId) return;
      this.meetings = meetings;
      this.meetings.sort((a,b) => b.startedAt.localeCompare(a.startedAt));
      this.error = '';
      void this.refreshLocalRecovery();
      const selected=this.selected();
      if (selected?.transcriptState === 'ready' && this.transcriptMeetingId !== selected.id) void this.loadTranscript(selected.id);
    } catch (error) { if (request===this.loadRequest) this.error = String(error); }
    this.loading = false;
    this.requestUpdate();
  }
  private async prepare() {
    if (this.callId) { this.error = 'End the call before starting a separate recording.'; this.requestUpdate(); return; }
    this.error = '';
    this.preparation = true;
    this.requestUpdate();
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone capture requires a secure browser context.');
      this.stream?.getTracks().forEach(track => track.stop());
      this.stream = await navigator.mediaDevices.getUserMedia({audio:this.deviceId ? {deviceId:{exact:this.deviceId}} : true});
      this.devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'audioinput');
      this.startInputMeter();
    } catch (error) { this.preparation = false; this.error = `Microphone unavailable: ${String(error)}`; }
    this.requestUpdate();
  }
  private abandonPreparation() {
    this.stream?.getTracks().forEach(track => track.stop());
    this.stopInputMeter();
    this.stream = undefined;
    this.preparation = false;
    this.requestUpdate();
  }
  private startInputMeter() {
    this.stopInputMeter();
    if(!this.stream)return;
    const audio=new AudioContext();this.inputAudio=audio;
    const analyser=audio.createAnalyser();analyser.fftSize=512;this.inputAnalyser=analyser;
    audio.createMediaStreamSource(this.stream).connect(analyser);
    const samples=new Uint8Array(analyser.fftSize);
    this.inputMeterTimer=window.setInterval(()=>{
      analyser.getByteTimeDomainData(samples);
      let energy=0;for(const value of samples){const centered=(value-128)/128;energy+=centered*centered;}
      this.inputLevel=Math.min(100,Math.round(Math.sqrt(energy/samples.length)*280));
      this.requestUpdate();
    },180);
  }
  private stopInputMeter() {
    if(this.inputMeterTimer)window.clearInterval(this.inputMeterTimer);
    this.inputMeterTimer=undefined;this.inputAnalyser=undefined;this.inputLevel=0;
    void this.inputAudio?.close();this.inputAudio=undefined;
  }
  private captureType() {
    for (const candidate of ['audio/webm;codecs=opus','audio/webm','audio/ogg','audio/mp4']) if (MediaRecorder.isTypeSupported(candidate)) return candidate;
    return '';
  }
  private async startRecording() {
    if (this.recordingStarting || this.activeId) return;
    if (!this.stream?.getAudioTracks().some(track => track.readyState === 'live')) { this.error = 'No live microphone input is available.'; this.requestUpdate(); return; }
    if (typeof MediaRecorder === 'undefined') { this.error = 'This browser does not support recording.'; this.requestUpdate(); return; }
    const mediaType = this.captureType();
    if (!mediaType) { this.error = 'This browser has no supported audio recording format.'; this.requestUpdate(); return; }
    this.recordingStarting=true;this.requestUpdate();
    try {
      const response = await fetch(this.base(),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'Quick recording',kind:'recording',mediaType})});
      if (!response.ok) throw new Error(`Could not create meeting (${response.status})`);
      const meeting = await response.json() as Meeting;
      this.meetings.unshift(meeting);
      this.selectedId = meeting.id;
      this.activeId = meeting.id;
      this.nextChunk = 0;
      this.captureError = '';
      this.uploadQueue = Promise.resolve();
      const recorder = new MediaRecorder(this.stream,{mimeType:mediaType});
      this.recorder = recorder;
      const chatId=this.sessionId;
      recorder.ondataavailable = event => { if (event.data.size) this.queueChunk(meeting.id,event.data,chatId); };
      recorder.onerror = () => { this.captureError = 'Recording interrupted. Saved chunks remain recoverable.'; this.requestUpdate(); };
      recorder.start(2000);
      this.startTime = Date.now();
      this.timer = window.setInterval(() => { this.elapsed = Math.floor((Date.now()-this.startTime)/1000); this.requestUpdate(); },500);
      this.preparation = false;
      this.requestUpdate();
    } catch (error) { this.error = String(error); this.requestUpdate(); }
    finally { this.recordingStarting=false;this.requestUpdate(); }
  }

  private async prepareCall() {
    if (this.activeId) { this.error = 'Stop the recording before starting a call.'; this.requestUpdate(); return; }
    this.error = '';
    this.callPreparing = true;
    const attempt=++this.callPreparationSeq;
    this.callHostingError = '';
    this.requestUpdate();
    try {
      const readinessResponse=await fetch(apiPath('/api/meetings/call-readiness'));
      if (attempt!==this.callPreparationSeq) return;
      if (!readinessResponse.ok) throw new Error(`Could not check call hosting (${readinessResponse.status}).`);
      const readiness=await readinessResponse.json() as {available:boolean;reason:string};
      if (attempt!==this.callPreparationSeq) return;
      if (!readiness.available) { this.callHostingError=readiness.reason; this.requestUpdate(); return; }
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('A secure browser context is required for video calls.');
      this.callStream?.getTracks().forEach(track=>track.stop());
      const audio=this.callAudioDeviceId ? {deviceId:{exact:this.callAudioDeviceId}} : true;
      const video=this.callVideoDeviceId ? {deviceId:{exact:this.callVideoDeviceId}} : true;
      let stream:MediaStream;
      try { stream = await navigator.mediaDevices.getUserMedia({audio,video}); this.callStatus='Camera and microphone ready.'; }
      catch { stream = await navigator.mediaDevices.getUserMedia({audio}); this.callStatus = 'Camera unavailable; joining with audio only.'; }
      if (attempt!==this.callPreparationSeq) { stream.getTracks().forEach(track=>track.stop()); return; }
      this.callStream=stream;
      const devices=await navigator.mediaDevices.enumerateDevices();
      this.callAudioDevices=devices.filter(device=>device.kind==='audioinput');
      this.callVideoDevices=devices.filter(device=>device.kind==='videoinput');
    } catch (error) { if (attempt===this.callPreparationSeq) { this.callPreparing = false; this.error = `Call unavailable: ${String(error)}`; } }
    this.requestUpdate();
  }
  private abandonCall() {
    this.callPreparationSeq++;
    this.callStream?.getTracks().forEach(track => track.stop());
    this.callStream = undefined;
    this.callPreparing = false;
    this.callHostingError = '';
    this.requestUpdate();
  }
  private async callSignal(type:string,payload:unknown,meetingId=this.callId,chatId=this.sessionId) {
    const path=apiPath(`/api/sdk-chats/${encodeURIComponent(chatId)}/meetings/${encodeURIComponent(meetingId)}/signals`);
    const response = await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type,payload})});
    if (!response.ok) throw new Error(`Call signaling failed (${response.status})`);
  }
  private async startCall() {
    if (this.callStarting || this.callId) return;
    if (!this.callStream?.getAudioTracks().some(track => track.readyState === 'live')) { this.error='Microphone unavailable.'; this.requestUpdate(); return; }
    const seq=++this.callPreparationSeq, chatId=this.sessionId;
    const stale=()=>seq!==this.callPreparationSeq || chatId!==this.sessionId || !this.isConnected;
    const meetingPath=(id:string)=>apiPath(`/api/sdk-chats/${encodeURIComponent(chatId)}/meetings/${encodeURIComponent(id)}`);
    this.callStarting=true;this.requestUpdate();
    try {
      const created = await fetch(this.base(),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'call',title:'Video call'})});
      if (!created.ok) throw new Error((await created.text()).trim() || `Could not create call (${created.status})`);
      const meeting = await created.json() as Meeting;
      if (stale()) { await fetch(meetingPath(meeting.id),{method:'DELETE',keepalive:true}); return; }
      const invited = await fetch(meetingPath(meeting.id)+'/invite',{method:'POST'});
      if (!invited.ok) throw new Error((await invited.text()).trim() || `Could not create invite (${invited.status})`);
      const invite = await invited.json() as {inviteUrl:string;iceServers:RTCIceServer[]};
      if (stale()) { await fetch(meetingPath(meeting.id),{method:'DELETE',keepalive:true}); return; }
      this.callId = meeting.id;
      this.selectedId = meeting.id;
      this.meetings.unshift(meeting);
      this.inviteUrl = invite.inviteUrl;
      this.callCursor = 0;
      this.guestJoined = false;
      this.offerSent = false;
      this.callReady = false;
      this.pendingICE = [];
      this.callNetwork={route:'checking',ice:'new',turnConfigured:hasTurnServer(invite.iceServers || [])};
      this.lastNetworkCheck=0;
      this.callAttemptAt=0;
      this.remoteStream = undefined;
      this.remoteScreen = undefined;
      const peer = new RTCPeerConnection({iceServers:invite.iceServers || []});
      this.callPeer = peer;
      const chatId=this.sessionId,meetingId=meeting.id;
      peer.onicecandidate = event => { if (event.candidate && this.callPeer===peer) void this.callSignal('ice',event.candidate,meetingId,chatId).catch(error => { this.callStatus=String(error); this.requestUpdate(); }); };
      peer.onicecandidateerror = event => { const code=(event as Event & {errorCode?:number}).errorCode; this.callNetwork={...this.callNetwork,errorCode:code}; this.requestUpdate(); };
      peer.oniceconnectionstatechange = () => { void this.inspectCallNetwork(); };
      peer.onconnectionstatechange = () => { this.callStatus=peer.connectionState==='connected'?'Connected to guest':peer.connectionState==='failed'?'Media connection failed':peer.connectionState==='disconnected'?'Guest media disconnected; reconnecting…':'Connecting media…'; void this.inspectCallNetwork(); this.requestUpdate(); };
      peer.ontrack = event => {
        if (event.track.kind === 'audio') {
          this.remoteStream ??= new MediaStream();
          this.remoteStream.addTrack(event.track);
        } else if (!this.remoteStream?.getVideoTracks().length) {
          this.remoteStream ??= new MediaStream();
          this.remoteStream.addTrack(event.track);
        } else {
          this.remoteScreen = new MediaStream([event.track]);
          event.track.onended = () => { this.remoteScreen=undefined; this.requestUpdate(); };
        }
        this.requestUpdate();
      };
      peer.onnegotiationneeded = () => { if (this.callReady && peer.signalingState === 'stable') void this.offerCall(); };
      for (const track of this.callStream.getTracks()) peer.addTrack(track,this.callStream);
      this.callPreparing = false;
      this.callStatus = 'Waiting for a guest';
      this.callPollTimer = window.setInterval(() => void this.pollCall(),700);
      void this.pollCall();
      this.requestUpdate();
    } catch (error) { this.error = String(error); this.requestUpdate(); }
    finally { this.callStarting=false;this.requestUpdate(); }
  }
  private async offerCall() {
    const peer = this.callPeer;
    if (!peer || peer.signalingState !== 'stable' || this.hostMakingOffer) return;
    this.hostMakingOffer=true;
    try {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await this.callSignal('offer',peer.localDescription);
      this.offerSent = true;
      this.callAttemptAt=Date.now();
    } catch (error) { this.callStatus = `Connection setup failed: ${String(error)}`; this.requestUpdate(); }
    finally { this.hostMakingOffer=false; }
  }
  private async pollCall() {
    if (!this.callId || this.callPolling) return;
    this.callPolling = true;
    try {
      const response = await fetch(this.path(this.callId,`/signals?since=${this.callCursor}`));
      if (!response.ok) throw new Error(`Call unavailable (${response.status})`);
      const data = await response.json() as {signals:{seq:number;type:string;payload:any}[];cursor:number;signalsDropped?:boolean;peerConnected:boolean;guestJoined:boolean};
      if (data.signalsDropped) throw new Error('Call signaling was interrupted. End this call and send a new invite.');
      for (const message of data.signals) { this.callCursor=Math.max(this.callCursor,message.seq); await this.receiveCall(message); }
      this.callCursor=Math.max(this.callCursor,data.cursor);
      this.guestJoined=data.guestJoined;
      if (this.guestJoined && this.callStatus==='Waiting for a guest') this.callStatus='Guest joined; checking media connection…';
      if (this.guestJoined && !this.offerSent && this.callPeer?.signalingState === 'stable') await this.offerCall();
      if (this.guestJoined && !data.peerConnected) this.callStatus='Guest disconnected; reconnecting…';
      if (Date.now()-this.lastNetworkCheck>3000) void this.inspectCallNetwork();
      this.requestUpdate();
    } catch (error) { this.callStatus=String(error); this.requestUpdate(); }
    finally { this.callPolling = false; }
  }
  private async inspectCallNetwork() {
    const peer=this.callPeer;
    if (!peer) return;
    this.lastNetworkCheck=Date.now();
    try {
      const report=await peer.getStats();
      if (peer!==this.callPeer) return;
      const stats=[...report.values()] as CandidateStat[];
      const transport=stats.find(stat=>stat.type==='transport' && stat.selectedCandidatePairId);
      const pair=stats.find(stat=>stat.id===transport?.selectedCandidatePairId) || stats.find(stat=>stat.type==='candidate-pair' && stat.nominated && stat.state==='succeeded');
      const local=stats.find(stat=>stat.id===pair?.localCandidateId);
      const remote=stats.find(stat=>stat.id===pair?.remoteCandidateId);
      const route:CallRoute=peer.iceConnectionState==='failed'?'failed':pair ? (local?.candidateType==='relay'||remote?.candidateType==='relay'?'relay':'direct'):this.callAttemptAt && Date.now()-this.callAttemptAt>12000?'stalled':'checking';
      this.callNetwork={...this.callNetwork,route,ice:peer.iceConnectionState,localType:local?.candidateType,remoteType:remote?.candidateType,protocol:local?.protocol || remote?.protocol,relayProtocol:local?.relayProtocol};
      this.requestUpdate();
    } catch { this.callNetwork={...this.callNetwork,ice:peer.iceConnectionState,route:peer.iceConnectionState==='failed'?'failed':'checking'};this.requestUpdate(); }
  }
  private async receiveCall(message:{type:string;payload:any}) {
    const peer=this.callPeer;
    if (!peer) return;
    try {
      if (message.type === 'joined') {
        this.guestJoined=true;
        if(this.offerSent){peer.restartIce();this.offerSent=false;this.callReady=false;this.pendingICE=[];}
      } else if (message.type === 'answer') {
        if (peer.signalingState !== 'have-local-offer') return;
        await peer.setRemoteDescription(message.payload);
        for (const candidate of this.pendingICE) await peer.addIceCandidate(candidate);
        this.pendingICE=[]; this.callReady=true;
      } else if (message.type === 'offer') {
        // The host is the impolite peer. The guest rolls back its colliding offer.
        if (peer.signalingState !== 'stable') return;
        await peer.setRemoteDescription(message.payload);
        for (const candidate of this.pendingICE) await peer.addIceCandidate(candidate);
        this.pendingICE=[];
        const answer=await peer.createAnswer();
        await peer.setLocalDescription(answer);
        await this.callSignal('answer',peer.localDescription);
        this.callReady=true;
      } else if (message.type === 'ice') {
        if (peer.remoteDescription) await peer.addIceCandidate(message.payload);
        else this.pendingICE.push(message.payload);
      } else if (message.type === 'share') {
        if (!message.payload?.active) this.remoteScreen=undefined;
      } else if (message.type === 'leave') {
        this.callStatus='Guest left the call.';
      }
    } catch (error) { this.callStatus=`Connection error: ${String(error)}`; }
    this.requestUpdate();
  }
  private async toggleShare() {
    if (!this.callPeer) return;
    if (this.shareSender) {
      this.screenStream?.getTracks().forEach(track => track.stop());
      this.callPeer.removeTrack(this.shareSender);
      this.shareSender=undefined; this.screenStream=undefined;
      await this.callSignal('share',{active:false});
      this.requestUpdate(); return;
    }
    try {
      const display=await navigator.mediaDevices.getDisplayMedia({video:true,audio:false});
      const track=display.getVideoTracks()[0];
      this.screenStream=display;
      this.shareSender=this.callPeer.addTrack(track,display);
      track.onended=()=>{ if (this.shareSender) void this.toggleShare(); };
      await this.callSignal('share',{active:true});
      this.requestUpdate();
    } catch (error) { this.callStatus=`Screen sharing cancelled or unavailable: ${String(error)}`; this.requestUpdate(); }
  }
  private videoCaptureType() {
    for (const candidate of ['video/webm;codecs=vp8,opus','video/webm','video/mp4']) if (MediaRecorder.isTypeSupported(candidate)) return candidate;
    return '';
  }
  private async startCallRecording() {
    if (!this.callId || this.callRecording || this.callRecordingStarting) return;
    if (!this.guestJoined || !this.remoteStream?.getAudioTracks().some(track=>track.readyState==='live')) {
      this.callStatus='Wait for the guest audio before recording the call.';
      this.requestUpdate();
      return;
    }
    const mediaType=this.videoCaptureType();
    if (!mediaType) { this.callStatus='This browser cannot record call video.'; this.requestUpdate(); return; }
    this.callRecordingStarting=true;this.requestUpdate();
    try {
      const canvas=document.createElement('canvas'); canvas.width=1280; canvas.height=720; this.callCanvas=canvas;
      const context=canvas.getContext('2d'); if (!context) throw new Error('Canvas capture unavailable');
      const draw=()=>{
        context.fillStyle='#161c28';context.fillRect(0,0,1280,720);
        const local=this.querySelector<HTMLVideoElement>('.call-local'),remote=this.querySelector<HTMLVideoElement>('.call-remote'),screen=this.querySelector<HTMLVideoElement>('.call-screen');
        const drawVideo=(video:HTMLVideoElement|null,x:number,y:number,w:number,h:number)=>{ if(video?.readyState && video.readyState>=2)context.drawImage(video,x,y,w,h); };
        if (this.screenStream || this.remoteScreen) { drawVideo(screen,0,0,1280,720);drawVideo(remote,1010,20,250,140);drawVideo(local,1010,180,250,140); }
        else { drawVideo(remote,0,0,640,720);drawVideo(local,640,0,640,720); }
      };
      draw(); this.callDrawTimer=window.setInterval(draw,42);
      const captured=canvas.captureStream(24);
      const audio=new AudioContext(); this.callAudio=audio;
      const output=audio.createMediaStreamDestination();
      for (const source of [this.callStream,this.remoteStream]) if (source?.getAudioTracks().length) audio.createMediaStreamSource(new MediaStream(source.getAudioTracks())).connect(output);
      this.callRecordStream=new MediaStream([...captured.getVideoTracks(),...output.stream.getAudioTracks()]);
      const response=await fetch(this.path(this.callId,'/record-start'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mediaType})});
      if (!response.ok) throw new Error(`Could not start recording (${response.status})`);
      this.uploadQueue=Promise.resolve(); this.nextChunk=0; this.captureError='';
      const recorder=new MediaRecorder(this.callRecordStream,{mimeType:mediaType});
      this.callRecorder=recorder;
      const chatId=this.sessionId,meetingId=this.callId;
      recorder.ondataavailable=event=>{ if(event.data.size)this.queueChunk(meetingId,event.data,chatId); };
      recorder.onerror=()=>{ this.captureError='Call recording interrupted. Saved chunks remain recoverable.'; this.requestUpdate(); };
      recorder.start(2000);
      await this.callSignal('recording',{active:true});
      this.callRecording=true;
      this.requestUpdate();
    } catch (error) {
      if (this.callRecorder?.state==='recording') this.callRecorder.stop();
      this.callRecorder=undefined;this.callRecording=false;
      this.callStatus=`Recording failed: ${String(error)}`; this.releaseCallCapture(); this.requestUpdate();
    } finally { this.callRecordingStarting=false;this.requestUpdate(); }
  }
  private releaseCallCapture() {
    if (this.callDrawTimer) window.clearInterval(this.callDrawTimer);
    this.callDrawTimer=undefined;
    this.callRecordStream?.getTracks().forEach(track=>track.stop());
    this.callRecordStream=undefined;this.callCanvas=undefined;
    void this.callAudio?.close();this.callAudio=undefined;
  }
  private async stopCallRecording() {
    const recorder=this.callRecorder;
    const id=this.callId, chatId=this.sessionId;
    try {
      if (recorder) await stopMediaRecorder(recorder);
      await this.uploadQueue;
      if (!this.captureError && id) await this.finalize(id,chatId);
    } catch (error) {
      this.captureError=`Recording could not finish: ${String(error)}`;
      this.requestUpdate();
    } finally {
      this.callRecorder=undefined;this.callRecording=false;
      this.releaseCallCapture();
      try { if (id) await this.callSignal('recording',{active:false},id,chatId); } catch { /* call may already have ended */ }
      if (this.isConnected) await this.load(false);
    }
  }
  private async leaveCall() {
    if (!this.callId || this.callLeaving) return;
    this.callLeaving=true;
    const id=this.callId, chatId=this.sessionId;
    const path=apiPath(`/api/sdk-chats/${encodeURIComponent(chatId)}/meetings/${encodeURIComponent(id)}`);
    const notices=Promise.allSettled([
      this.callSignal('end',{},id,chatId),
      fetch(path+'/end',{method:'POST',keepalive:true}),
      fetch(path+'/invite',{method:'DELETE',keepalive:true}),
    ]);
    try {
      if (this.callRecording || this.callRecorder) await this.stopCallRecording();
    } catch (error) { this.captureError=`Recording finalization failed: ${String(error)}`; }
    if (this.callPollTimer) window.clearInterval(this.callPollTimer);
    this.callPollTimer=undefined;
    this.callPeer?.close(); this.callPeer=undefined;
    this.callStream?.getTracks().forEach(track=>track.stop());this.callStream=undefined;
    this.screenStream?.getTracks().forEach(track=>track.stop());this.screenStream=undefined;this.shareSender=undefined;
    this.callId='';this.inviteUrl='';this.callRecording=false;this.remoteStream=undefined;this.remoteScreen=undefined;
    this.callNetwork={route:'checking',ice:'new',turnConfigured:false};
    this.callAttemptAt=0;
    await notices;
    this.callLeaving=false;
    if (this.isConnected && this.sessionId===chatId) await this.load(false);
  }
  override updated() {
    const assign=(selector:string,stream?:MediaStream)=>{const video=this.querySelector<HTMLVideoElement>(selector);if(video && video.srcObject!==stream)video.srcObject=stream || null;};
    assign('.call-local',this.callStream);
    assign('.call-remote',this.remoteStream);
    assign('.call-screen',this.screenStream || this.remoteScreen);
    assign('.call-preview',this.callStream);
  }
  private queueChunk(meetingId:string, blob:Blob, chatId=this.sessionId) {
    const index = this.nextChunk++;
    const key = `${chatId}/${meetingId}/${String(index).padStart(8,'0')}`;
    this.uploadQueue = this.uploadQueue.then(async () => {
      let savedLocally=true;
      try { await chunkStore('readwrite',store => store.put({key,blob})); }
      catch { savedLocally=false; }
      if (this.captureError) return;
      try {
        await this.uploadChunk(meetingId,index,blob,chatId);
        if (savedLocally) await chunkStore('readwrite',store => store.delete(key));
      } catch (error) {
        this.captureError = `Upload paused: ${String(error)}. ${savedLocally?'Media is saved in this browser for retry.':'This browser could not save the chunk locally.'}`;
        this.requestUpdate();
      }
    });
  }
  private async uploadChunk(meetingId:string,index:number,blob:Blob,chatId=this.sessionId) {
    const path=apiPath(`/api/sdk-chats/${encodeURIComponent(chatId)}/meetings/${encodeURIComponent(meetingId)}/chunks?index=${index}`);
    const response = await fetch(path,{method:'POST',body:blob});
    if (!response.ok) throw new Error(`chunk ${index} (${response.status})`);
  }
  private async refreshLocalRecovery() {
    try {
      const keys=await chunkStore('readonly',store=>store.getAllKeys()) as IDBValidKey[];
      const prefix=`${this.sessionId}/`;
      this.locallyRecoverable=new Set(keys.filter((key):key is string=>typeof key==='string'&&key.startsWith(prefix)).map(key=>key.slice(prefix.length).split('/')[0]));
      this.requestUpdate();
    } catch { /* server chunks may still be recoverable */ }
  }
  private async stopRecording() {
    const recorder = this.recorder;
    if (!recorder || this.recordingStopping) return;
    this.recordingStopping=true;
    const chatId=this.sessionId;
    try { await stopMediaRecorder(recorder); }
    catch (error) { this.captureError=`Recording could not finish: ${String(error)}`;this.requestUpdate(); }
    if (this.timer) window.clearInterval(this.timer);
    this.stream?.getTracks().forEach(track => track.stop());
    this.stopInputMeter();
    this.stream = undefined;
    this.recorder = undefined;
    const id = this.activeId;
    this.activeId = '';
    try {
      await this.uploadQueue;
      if (!this.captureError) await this.finalize(id,chatId);
    } finally { this.recordingStopping=false;if (this.isConnected && this.sessionId===chatId) await this.load(false); }
  }
  private async finalize(id:string,chatId=this.sessionId) {
    try {
      const path=apiPath(`/api/sdk-chats/${encodeURIComponent(chatId)}/meetings/${encodeURIComponent(id)}/finish`);
      const response = await fetch(path,{method:'POST'});
      if (!response.ok) throw new Error(`Could not finalize recording (${response.status})`);
      this.captureError = '';
    } catch (error) { this.captureError = `${String(error)}. Retry from this meeting.`; }
    this.requestUpdate();
  }
  private async recover(meeting:Meeting) {
    try {
      const response=await fetch(this.path(meeting.id));
      if (!response.ok) throw new Error(`Meeting unavailable (${response.status})`);
      const current=await response.json() as Meeting;
      const prefix = `${this.sessionId}/${meeting.id}/`;
      const range=IDBKeyRange.bound(prefix,prefix+'\uffff');
      const chunks = (await chunkStore('readonly',store => store.getAll(range)) as LocalChunk[])
        .sort((a,b) => a.key.localeCompare(b.key));
      for (const item of chunks) {
        const index = Number(item.key.slice(prefix.length));
        if (index >= current.chunks) await this.uploadChunk(meeting.id,index,item.blob);
        await chunkStore('readwrite',store => store.delete(item.key));
      }
      await this.finalize(meeting.id);
      await this.load(false);
      await this.refreshLocalRecovery();
    } catch (error) { this.captureError = `Recovery failed: ${String(error)}`; this.requestUpdate(); }
  }
  private async deleteMeeting() {
    const id = this.deleteId;
    this.deleteId = '';
    if (!id) return;
    try {
      const response = await fetch(this.path(id),{method:'DELETE'});
      if (!response.ok) throw new Error(`Delete failed (${response.status})`);
      this.meetings = this.meetings.filter(item => item.id !== id);
      if (this.selectedId === id) this.selectedId = '';
      this.locallyRecoverable.delete(id);
      try {
        const keys=await chunkStore('readonly',store=>store.getAllKeys()) as IDBValidKey[];
        for(const key of keys)if(typeof key==='string'&&key.startsWith(`${this.sessionId}/${id}/`))await chunkStore('readwrite',store=>store.delete(key));
      } catch { this.error='Meeting deleted from server, but browser recovery chunks could not be cleared.'; }
      this.requestUpdate();
    } catch (error) { this.error = String(error); this.requestUpdate(); }
  }
  private selectMeeting(meeting:Meeting) {
    this.selectedId=meeting.id;
    this.transcript=undefined;
    this.transcriptMeetingId='';
    this.transcriptNotice='';
    if (meeting.transcriptState==='ready') void this.loadTranscript(meeting.id);
    this.requestUpdate();
  }
  private async loadTranscript(id:string) {
    try {
      const response=await fetch(this.path(id,'/transcript'));
      if(!response.ok)throw new Error(`Transcript unavailable (${response.status})`);
      const transcript=await response.json() as Transcript;
      if(this.selectedId!==id)return;
      this.transcript=transcript;
      this.transcriptMeetingId=id;
      this.correctionDraft={...transcript.corrections};
      this.transcriptNotice='';
    } catch(error) { this.transcriptNotice=String(error); }
    this.requestUpdate();
  }
  private async transcribe(meeting:Meeting) {
    this.transcriptBusy=true;this.transcriptNotice='';this.requestUpdate();
    try {
      const response=await fetch(this.path(meeting.id,'/transcribe'),{method:'POST'});
      if(!response.ok)throw new Error(`Could not queue transcription (${response.status})`);
      await this.load(false);
    } catch(error) { this.transcriptNotice=String(error); }
    this.transcriptBusy=false;this.requestUpdate();
  }
  private async saveCorrections(meeting:Meeting) {
    if(!this.transcript)return;
    this.transcriptBusy=true;this.transcriptNotice='';this.requestUpdate();
    try {
      const response=await fetch(this.path(meeting.id,'/transcript'),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:this.transcript.revision,corrections:this.correctionDraft})});
      if(!response.ok)throw new Error(response.status===409?'Transcript changed elsewhere. Reload before saving.':`Could not save corrections (${response.status})`);
      this.transcript=await response.json() as Transcript;
      this.transcriptNotice='Corrections saved.';
    } catch(error) { this.transcriptNotice=String(error); }
    this.transcriptBusy=false;this.requestUpdate();
  }
  private seekTranscript(startMs:number) {
    const media=this.querySelector<HTMLMediaElement>('.meeting-player, .meeting-detail audio');
    if(media){media.currentTime=startMs/1000;void media.play().catch(()=>{});}
  }
  private openLinkedNote(id:string) {
    this.dispatchEvent(new CustomEvent('meeting-open-note',{detail:{id},bubbles:true,composed:true}));
  }
  private async createLinkedNote(meeting:Meeting) {
    this.transcriptBusy=true;this.transcriptNotice='';this.requestUpdate();
    try {
      const response=await fetch(this.path(meeting.id,'/note'),{method:'POST'});
      if(!response.ok)throw new Error(`Could not create note (${response.status})`);
      const result=await response.json() as {note_id:string};
      await this.load(false);
      this.openLinkedNote(result.note_id);
    } catch(error) { this.transcriptNotice=String(error); }
    this.transcriptBusy=false;this.requestUpdate();
  }
  private transcriptView(meeting:Meeting) {
    if(meeting.recordingState!=='ready')return nothing;
    const state=meeting.transcriptState;
    return html`<section class="meeting-transcript"><div class="transcript-header"><div><strong>Transcript</strong><p>Generated locally from the saved original. Speaker identity is unknown for mixed audio.</p></div>${state==='ready' ? html`<a href=${this.path(meeting.id,'/transcript/export')} download=${`meeting-${meeting.id}.vtt`}>${icon(Download,{size:15})} Export VTT</a>` : nothing}</div>
      ${state==='not_started' ? html`<mux-ui-button variant="secondary" ?disabled=${this.transcriptBusy} @click=${() => void this.transcribe(meeting)}>Transcribe locally</mux-ui-button>` : state==='queued'||state==='processing' ? html`<mux-ui-feedback kind="loading">${state==='queued'?'Transcription queued…':'Transcribing saved media locally…'}</mux-ui-feedback>` : state==='failed' ? html`<mux-ui-feedback kind="error">${meeting.transcriptError || 'Transcription failed.'}</mux-ui-feedback><mux-ui-button variant="secondary" ?disabled=${this.transcriptBusy} @click=${() => void this.transcribe(meeting)}>Retry from original</mux-ui-button>` : this.transcriptMeetingId===meeting.id && this.transcript ? html`<div class="transcript-segments">${this.transcript.segments.map(segment => html`<div class="transcript-segment"><button class="transcript-time" @click=${() => this.seekTranscript(segment.startMs)}>${this.clock(Math.floor(segment.startMs/1000))}</button><div><strong>${segment.speaker}</strong><textarea aria-label=${`Correct transcript at ${this.clock(Math.floor(segment.startMs/1000))}`} .value=${this.correctionDraft[segment.id] ?? segment.text} @input=${(event:Event) => {this.correctionDraft[segment.id]=(event.target as HTMLTextAreaElement).value;}}></textarea></div></div>`)}</div><div class="meeting-buttons"><mux-ui-button variant="secondary" ?disabled=${this.transcriptBusy} @click=${() => void this.saveCorrections(meeting)}>Save corrections</mux-ui-button>${meeting.linkedNoteId ? html`<mux-ui-button variant="secondary" @click=${() => this.openLinkedNote(meeting.linkedNoteId!)}>Open linked note</mux-ui-button>` : html`<mux-ui-button variant="secondary" ?disabled=${this.transcriptBusy} @click=${() => void this.createLinkedNote(meeting)}>Create linked note</mux-ui-button>`}</div>` : html`<mux-ui-feedback kind="loading">Loading transcript…</mux-ui-feedback>`}
      ${this.transcriptNotice ? html`<mux-ui-feedback kind=${this.transcriptNotice.includes('saved')?'info':'warning'}>${this.transcriptNotice}</mux-ui-feedback>` : nothing}
    </section>`;
  }
  private duration(meeting:Meeting) {
    const end = meeting.endedAt ? Date.parse(meeting.endedAt) : Date.now();
    return Math.max(0,Math.floor((end-Date.parse(meeting.startedAt))/1000));
  }
  private clock(seconds:number) { return `${Math.floor(seconds/60).toString().padStart(2,'0')}:${(seconds%60).toString().padStart(2,'0')}`; }
  private inputMeter() { return html`<div class="input-meter"><span>Input level</span><div role="meter" aria-label="Microphone input level" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${this.inputLevel}><i style=${`width:${this.inputLevel}%`}></i></div></div>`; }
  private meetingBody(selected?:Meeting) {
    if (this.callPreparing) return html`<div class="meeting-detail"><div class="meeting-overline">CALL PREFLIGHT</div><h2>Start a call</h2><p>Confirm your camera and microphone before creating a guest invite.</p>${this.callHostingError ? html`<mux-ui-feedback kind="warning">${this.callHostingError}</mux-ui-feedback><p>Guests need to reach this Muxterm server for the invite and call signaling. A self-hosted TURN server is recommended when direct browser connections are blocked.</p><div class="meeting-buttons"><mux-ui-button variant="secondary" @click=${() => void this.prepareCall()}>Check again</mux-ui-button><mux-ui-button variant="secondary" @click=${() => this.abandonCall()}>Cancel</mux-ui-button></div>` : this.callStream ? html`<div class="meeting-preflight"><video class="call-preview" autoplay playsinline muted></video><p>${this.callStatus || 'Sample camera and microphone ready.'}</p><div class="call-device-fields"><label>Microphone<select aria-label="Call microphone" @change=${(event:Event) => {this.callAudioDeviceId=(event.target as HTMLSelectElement).value;void this.prepareCall();}}>${this.callAudioDevices.length?this.callAudioDevices.map(device=>html`<option value=${device.deviceId} ?selected=${device.deviceId===this.callAudioDeviceId}>${device.label || 'Microphone'}</option>`):html`<option>Sample microphone</option>`}</select></label><label>Camera<select aria-label="Call camera" @change=${(event:Event) => {this.callVideoDeviceId=(event.target as HTMLSelectElement).value;void this.prepareCall();}}>${this.callVideoDevices.length?this.callVideoDevices.map(device=>html`<option value=${device.deviceId} ?selected=${device.deviceId===this.callVideoDeviceId}>${device.label || 'Camera'}</option>`):html`<option>Sample camera</option>`}</select></label></div></div><div class="meeting-buttons"><mux-ui-button variant="primary" ?disabled=${this.callStarting} @click=${() => void this.startCall()}>${icon(Video,{size:15})} Create call and invite</mux-ui-button><mux-ui-button variant="secondary" @click=${() => this.abandonCall()}>Cancel</mux-ui-button></div>` : html`<mux-ui-feedback kind="loading">Checking call hosting and devices…</mux-ui-feedback>`}</div>`;
    if (this.callId) return this.callView(selected);
    if (this.preparation) return html`<div class="meeting-detail"><h2>Record a meeting</h2><p>Confirm your microphone, then start recording.</p>${this.stream ? html`<label for="meeting-input">Microphone</label><select id="meeting-input" @change=${(event:Event) => { this.deviceId=(event.target as HTMLSelectElement).value; void this.prepare(); }}>${this.devices.map(device => html`<option value=${device.deviceId} ?selected=${device.deviceId === this.deviceId}>${device.label || 'Microphone'}</option>`)}</select><p>Input: ${this.stream.getAudioTracks()[0]?.label || 'Microphone ready'}</p>${this.inputMeter()}<div class="meeting-buttons"><mux-ui-button variant="primary" ?disabled=${this.recordingStarting} @click=${() => void this.startRecording()}>${icon(Mic,{size:15})} Start recording</mux-ui-button><mux-ui-button variant="secondary" @click=${() => this.abandonPreparation()}>Cancel</mux-ui-button></div>` : html`<mux-ui-feedback kind="loading">Requesting microphone permission…</mux-ui-feedback>`}</div>`;
    if (this.activeId) return html`<div class="meeting-detail"><div class="record-live">● Recording · ${this.clock(this.elapsed)}</div><h2>${selected?.title || 'Quick recording'}</h2><p>Capturing ${this.stream?.getAudioTracks()[0]?.label || 'microphone'}. Saved chunks stay in muxterm storage.</p>${this.inputMeter()}<mux-ui-button variant="danger" @click=${() => void this.stopRecording()}>${icon(Square,{size:15})} Stop and save</mux-ui-button></div>`;
    if (selected) return html`<div class="meeting-detail"><div class="meeting-overline">${selected.kind === 'call' ? 'VIDEO CALL' : 'RECORDING'} · ${new Date(selected.startedAt).toLocaleString()}</div><h2>${selected.title}</h2><p>${selected.participants.join(', ')} · ${this.clock(this.duration(selected))}</p><p>Status: ${selected.recordingState === 'ready' ? 'Recording ready' : selected.recordingState === 'interrupted' ? 'Capture interrupted' : selected.recordingState}</p>${selected.error ? html`<mux-ui-feedback kind="warning">${selected.error}</mux-ui-feedback>` : nothing}${selected.recordingState === 'ready' ? html`${selected.mediaType?.startsWith('video/') ? html`<video class="meeting-player" controls preload="metadata" src=${this.path(selected.id,'/media')}></video>` : html`<audio controls preload="metadata" src=${this.path(selected.id,'/media')}></audio>`}<a class="meeting-download" href=${this.path(selected.id,'/media')} download=${`meeting-${selected.id}.webm`}>${icon(Download,{size:15})} Download original</a>${this.transcriptView(selected)}` : selected.chunks > 0 || this.locallyRecoverable.has(selected.id) ? html`<mux-ui-button variant="secondary" @click=${() => void this.recover(selected)}>Recover and finalize saved media</mux-ui-button>` : nothing}<div class="meeting-buttons"><mux-ui-button variant="secondary" @click=${() => { this.selectedId=''; this.requestUpdate(); }}>All meetings</mux-ui-button><mux-ui-button variant="danger" @click=${() => { this.deleteId=selected.id; this.requestUpdate(); }}>${icon(Trash2,{size:15})} Delete meeting</mux-ui-button></div></div>`;
    return html`<mux-ui-empty-state heading="Meet here"><span slot="icon">${icon(AudioLines,{size:24})}</span>Record from your microphone or invite someone to a private call.<div slot="action" class="meeting-buttons"><mux-ui-button variant="secondary" @click=${() => void this.prepare()}>${icon(Plus,{size:15})} Record a meeting</mux-ui-button><mux-ui-button variant="secondary" @click=${() => void this.prepareCall()}>${icon(Video,{size:15})} Start a call</mux-ui-button></div></mux-ui-empty-state>`;
  }
  private networkView() {
    const network=this.callNetwork;
    const routeLabel=network.route==='direct'?'Direct browser connection':network.route==='relay'?'TURN relay':network.route==='failed'?'No connection':network.route==='stalled'?'No route selected yet':'Checking routes';
    const noRouteHint=network.turnConfigured?'Check TURN reachability and credentials. The browser cannot identify the exact network rule.':'No TURN fallback is configured. A NAT or firewall may be blocking the direct path.';
    const hint=network.route==='direct'?'Media is traveling directly between browsers.':network.route==='relay'?'Media is using TURN. The browser cannot identify the exact NAT or firewall rule that prevented a direct route.':network.route==='failed'?`No route connected. ${noRouteHint}`:network.route==='stalled'?`No route was selected after 12 seconds. The browser has not reported failure. ${noRouteHint}`:'Browsers are testing available paths.';
    const types:Record<string,string>={host:'local',srflx:'NAT-mapped',prflx:'peer-mapped',relay:'relay'};
    return html`<div class="call-network" role="status"><strong>Connection: ${routeLabel}</strong><span>ICE ${network.ice}${network.protocol ? ` · ${network.protocol.toUpperCase()}` : ''}${network.localType && network.remoteType ? ` · ${types[network.localType] || network.localType} ↔ ${types[network.remoteType] || network.remoteType}` : ''}${network.relayProtocol ? ` · TURN over ${network.relayProtocol.toUpperCase()}` : ''}</span><p>${hint}${(network.route==='failed'||network.route==='stalled') && network.errorCode ? ` ICE server error ${network.errorCode}.` : ''}</p></div>`;
  }
  private callView(selected?:Meeting) {
    const localAudio=this.callStream?.getAudioTracks()[0],localVideo=this.callStream?.getVideoTracks()[0];
    const screen=this.screenStream || this.remoteScreen;
    return html`<div class="meeting-call"><div class="meeting-overline">${selected?.title || 'VIDEO CALL'} · ${this.guestJoined ? 'GUEST JOINED' : 'WAITING FOR GUEST'}</div><h2>${this.guestJoined ? 'You and a guest' : 'Waiting for a guest'}</h2><p>${this.callStatus || 'Connecting…'}</p>${this.networkView()}${this.callRecording ? html`<div class="record-live">● Recording audio, video, and active screen share. Both people can see this indicator.</div>` : nothing}
      <div class="call-stage ${screen ? 'sharing' : ''} ${this.sampleScene ? 'sample-media' : ''}">${screen ? html`<div class="call-screen-tile">${this.sampleScene ? html`<div class="sample-screen"><i></i><strong>Project notes</strong><p>Decisions · follow ups · next steps</p></div>` : nothing}<video class="call-screen" autoplay playsinline ?muted=${!!this.screenStream}></video><span>${this.screenStream ? 'Your screen' : 'Guest screen'}</span></div>` : nothing}<div class="call-video-tile">${this.sampleScene ? html`<div class="sample-person guest"><i></i><b></b></div>` : nothing}<video class="call-remote" autoplay playsinline></video><span>${this.guestJoined ? 'Guest' : 'Waiting for a guest'}</span></div><div class="call-video-tile">${this.sampleScene ? html`<div class="sample-person host"><i></i><b></b></div>` : nothing}<video class="call-local" autoplay playsinline muted></video><span>You</span></div></div>
      <div class="call-controls"><mux-ui-button size="small" variant="secondary" @click=${() => { if(this.sampleScene)this.sampleMicOn=!this.sampleMicOn;else if(localAudio)localAudio.enabled=!localAudio.enabled;this.requestUpdate(); }}>${icon((this.sampleScene ? this.sampleMicOn : localAudio?.enabled) ? Mic : MicOff,{size:15})} ${(this.sampleScene ? this.sampleMicOn : localAudio?.enabled) ? 'Mute' : 'Unmute'}</mux-ui-button><mux-ui-button size="small" variant="secondary" ?disabled=${!localVideo&&!this.sampleScene} @click=${() => { if(this.sampleScene)this.sampleCameraOn=!this.sampleCameraOn;else if(localVideo)localVideo.enabled=!localVideo.enabled;this.requestUpdate(); }}>${icon((this.sampleScene ? this.sampleCameraOn : localVideo?.enabled) ? Video : VideoOff,{size:15})} ${(this.sampleScene ? this.sampleCameraOn : localVideo?.enabled) ? 'Camera off' : 'Camera on'}</mux-ui-button><mux-ui-button size="small" variant="secondary" @click=${() => { if(this.sampleScene){this.screenStream=this.screenStream?undefined:new MediaStream();this.requestUpdate();}else void this.toggleShare(); }}>${icon(MonitorUp,{size:15})} ${this.screenStream ? 'Stop share' : 'Share screen'}</mux-ui-button><mux-ui-button size="small" variant="danger" @click=${() => { if(this.sampleScene){this.callId='';this.requestUpdate();}else void this.leaveCall(); }}>${icon(X,{size:15})} End call</mux-ui-button></div>
      <div class="call-invite"><strong>Guest invite</strong><span>${this.inviteUrl}</span><mux-ui-button size="small" variant="secondary" @click=${() => void navigator.clipboard.writeText(this.inviteUrl).catch(error => {this.callStatus=String(error);this.requestUpdate();})}>${icon(Copy,{size:15})} Copy link</mux-ui-button></div>
      <div class="call-record-action"><p>Recording starts only when you choose it. The original stays in muxterm storage.</p>${this.callRecording ? html`<mux-ui-button size="small" variant="danger" @click=${() => { if(this.sampleScene){this.callRecording=false;this.requestUpdate();}else void this.stopCallRecording(); }}>${icon(Square,{size:15})} Stop recording</mux-ui-button>` : html`<mux-ui-button size="small" variant="secondary" ?disabled=${!this.sampleScene && (this.callRecordingStarting || !this.guestJoined || !this.remoteStream?.getAudioTracks().some(track=>track.readyState==='live'))} @click=${() => { if(this.sampleScene){this.callRecording=true;this.requestUpdate();}else void this.startCallRecording(); }}>${icon(Mic,{size:15})} Record this call</mux-ui-button>`}</div>
    </div>`;
  }
  override render() {
    const selected = this.selected();
    const filtered = this.meetings.filter(item => `${item.title} ${item.participants.join(' ')}`.toLowerCase().includes(this.query.toLowerCase()));
    return html`<style>${styles}</style><section class="meeting-layout">
      <aside class="meeting-rail"><div class="meeting-heading"><strong>MEETINGS ${this.sampleScene ? '· SAMPLE' : ''}</strong><mux-ui-button icon-only size="small" variant="quiet" accessible-label="Refresh meetings" tooltip="Refresh meetings" @click=${() => void this.load()}>${icon(RefreshCw,{size:15})}</mux-ui-button></div>
        <mux-ui-text-field type="search" size="small" aria-label="Search meetings" placeholder="Search meetings" .value=${this.query} @input=${(event:Event) => { this.query = (event.target as MuxUITextField).liveValue; this.requestUpdate(); }}></mux-ui-text-field>
        <div class="meeting-actions"><mux-ui-button size="small" variant="secondary" @click=${() => void this.prepare()}>${icon(Mic,{size:15})} Record</mux-ui-button><mux-ui-button size="small" variant="secondary" @click=${() => void this.prepareCall()}>${icon(Video,{size:15})} Start call</mux-ui-button></div>
        <div class="meeting-rows">${this.loading ? html`<mux-ui-feedback kind="loading" density="compact">Loading meetings…</mux-ui-feedback>` : filtered.length ? filtered.map(meeting => html`<mux-ui-rail-row label=${meeting.title} detail=${new Date(meeting.startedAt).toLocaleString()} ?selected=${meeting.id === this.selectedId} @click=${() => this.selectMeeting(meeting)}><span slot="icon">${icon(meeting.kind === 'call' ? Video : AudioLines,{size:15})}</span></mux-ui-rail-row>`) : html`<mux-ui-feedback kind="empty" density="compact">${this.query ? 'No meetings match this search.' : 'No meetings yet.'}</mux-ui-feedback>`}</div>
      </aside><div class="meeting-divider"></div><main class="meeting-viewer">
        ${this.error ? html`<mux-ui-feedback kind="error" density="compact">${this.error}</mux-ui-feedback>` : nothing}
        ${this.captureError ? html`<mux-ui-feedback kind="warning" density="compact">${this.captureError}</mux-ui-feedback>` : nothing}
        ${this.meetingBody(selected)}
      </main><mux-ui-dialog size="compact" presentation="adaptive" label="Delete meeting" ?open=${!!this.deleteId} @dismiss=${() => { this.deleteId=''; this.requestUpdate(); }}><div class="meeting-confirm"><h2>Delete this meeting?</h2><p>The original recording and any saved chunks will be removed.</p><div class="meeting-buttons"><mux-ui-button variant="secondary" @click=${() => { this.deleteId=''; this.requestUpdate(); }}>Cancel</mux-ui-button><mux-ui-button variant="danger" @click=${() => void this.deleteMeeting()}>Delete meeting</mux-ui-button></div></div></mux-ui-dialog>
    </section>`;
  }
}

const styles = `
  mux-meetings { color:var(--ui-text); background:var(--ui-surface-base); font:var(--ui-text-md)/1.5 var(--ui-font-sans); }
  mux-meetings .meeting-layout { display:grid; grid-template-columns:clamp(220px,32%,340px) 1px minmax(0,1fr); height:100%; min-width:0; }
  mux-meetings .meeting-rail { min-width:0; min-height:0; display:flex; flex-direction:column; background:color-mix(in srgb,var(--ui-surface-base) 78%,var(--ui-surface-raised)); }
  mux-meetings .meeting-heading { height:var(--ui-utility-browser-heading-height); padding:0 var(--ui-space-4) 0 var(--ui-space-6); display:flex; align-items:center; justify-content:space-between; color:var(--ui-text-muted); font-size:var(--ui-text-xs); letter-spacing:.13em; }
  mux-meetings mux-ui-text-field { margin:0 var(--ui-space-4) var(--ui-space-3); }
  mux-meetings .meeting-actions { display:flex; flex-wrap:wrap; gap:var(--ui-space-2); margin:0 var(--ui-space-4) var(--ui-space-4); }
  mux-meetings .meeting-rows { overflow:auto; flex:1; }
  mux-meetings .meeting-divider { background:var(--ui-border); }
  mux-meetings .meeting-viewer { overflow:auto; min-width:0; padding:var(--ui-space-5); }
  mux-meetings .meeting-detail { max-width:680px; margin:var(--ui-space-8) auto; }
  mux-meetings .meeting-detail h2 { font:600 var(--ui-text-xl)/1.2 var(--ui-font-sans); margin:var(--ui-space-3) 0; }
  mux-meetings .meeting-detail p { color:var(--ui-text-muted); }
  mux-meetings .meeting-overline { color:var(--ui-text-muted); font-size:var(--ui-text-xs); letter-spacing:.12em; font-weight:700; }
  mux-meetings .record-live { color:var(--ui-danger); font-weight:700; }
  mux-meetings .input-meter { display:flex; align-items:center; gap:var(--ui-space-3); margin:var(--ui-space-5) 0; color:var(--ui-text-muted); font-size:var(--ui-text-sm); }
  mux-meetings .input-meter [role=meter] { height:8px; flex:1; max-width:260px; overflow:hidden; border-radius:var(--ui-radius-pill); background:var(--ui-border); }
  mux-meetings .input-meter i { display:block; height:100%; border-radius:inherit; background:var(--ui-accent); transition:width .16s linear; }
  mux-meetings .meeting-detail audio { display:block; width:100%; margin:var(--ui-space-7) 0; }
  mux-meetings .meeting-player { display:block; width:100%; max-height:420px; margin:var(--ui-space-7) 0; background:#111827; }
  mux-meetings .meeting-buttons { display:flex; flex-wrap:wrap; gap:var(--ui-space-3); margin-top:var(--ui-space-7); }
  mux-meetings .meeting-download { display:inline-flex; align-items:center; gap:var(--ui-space-2); }
  mux-meetings .meeting-transcript { margin:var(--ui-space-8) 0; padding-top:var(--ui-space-5); border-top:1px solid var(--ui-border); }
  mux-meetings .transcript-header { display:flex; align-items:start; justify-content:space-between; gap:var(--ui-space-4); }
  mux-meetings .transcript-header strong { font-size:var(--ui-text-lg); }
  mux-meetings .transcript-header p { font-size:var(--ui-text-sm); }
  mux-meetings .transcript-segments { display:grid; gap:var(--ui-space-3); margin:var(--ui-space-5) 0; }
  mux-meetings .transcript-segment { display:grid; grid-template-columns:70px minmax(0,1fr); gap:var(--ui-space-3); }
  mux-meetings .transcript-segment strong { color:var(--ui-text-muted); font-size:var(--ui-text-xs); }
  mux-meetings .transcript-time { align-self:start; border:0; background:transparent; color:var(--ui-accent); padding:var(--ui-space-1); cursor:pointer; font:inherit; }
  mux-meetings .transcript-segment textarea { box-sizing:border-box; display:block; width:100%; min-height:58px; padding:var(--ui-space-2); border:1px solid var(--ui-border); border-radius:var(--ui-radius-md); background:var(--ui-surface-raised); color:var(--ui-text); font:inherit; resize:vertical; }
  mux-meetings .meeting-confirm { padding:var(--ui-space-5); }
  mux-meetings .meeting-detail select { display:block; margin:var(--ui-space-2) 0; padding:var(--ui-space-3); background:var(--ui-surface-raised); color:var(--ui-text); border:1px solid var(--ui-border); border-radius:var(--ui-radius-md); }
  mux-meetings .meeting-preflight video { display:block; width:min(100%,430px); aspect-ratio:16/10; object-fit:cover; background:#151b27; border-radius:var(--ui-radius-lg); margin:var(--ui-space-5) 0; }
  mux-meetings .call-device-fields { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:var(--ui-space-3); max-width:430px; }
  mux-meetings .call-device-fields label { display:grid; gap:var(--ui-space-1); font-size:var(--ui-font-size-sm); }
  mux-meetings .call-device-fields select { width:100%; min-width:0; }
  mux-meetings .meeting-call { max-width:1000px; margin:0 auto; }
  mux-meetings .meeting-call h2 { font:600 var(--ui-text-xl)/1.2 var(--ui-font-sans); margin:var(--ui-space-2) 0; }
  mux-meetings .meeting-call p { color:var(--ui-text-muted); }
  mux-meetings .call-stage { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--ui-space-3); margin:var(--ui-space-5) 0; }
  mux-meetings .call-stage.sharing { grid-template-columns:minmax(0,2fr) minmax(150px,1fr); grid-template-rows:repeat(2,minmax(0,1fr)); }
  mux-meetings .call-screen-tile, mux-meetings .call-video-tile { position:relative; min-width:0; overflow:hidden; border:1px solid var(--ui-border); border-radius:var(--ui-radius-lg); background:#151b27; aspect-ratio:16/10; }
  mux-meetings .call-stage.sharing .call-screen-tile { grid-row:1 / 3; aspect-ratio:auto; }
  mux-meetings .call-stage.sharing .call-video-tile { aspect-ratio:16/9; }
  mux-meetings .call-stage video { width:100%; height:100%; object-fit:contain; }
  mux-meetings .sample-media video { position:absolute; inset:0; opacity:0; }
  mux-meetings .sample-person { position:absolute; inset:0; overflow:hidden; background:linear-gradient(145deg,#41566d,#263b55 55%,#1b2c43); }
  mux-meetings .sample-person.guest { background:linear-gradient(145deg,#746658,#4a5366 55%,#354354); }
  mux-meetings .sample-person::before { content:''; position:absolute; width:32%; height:70%; left:34%; bottom:-29%; border-radius:45% 45% 10% 10%; background:#26364f; }
  mux-meetings .sample-person.guest::before { background:#594050; }
  mux-meetings .sample-person i { position:absolute; width:17%; aspect-ratio:1; left:42%; top:23%; border-radius:48%; background:#d6a37e; z-index:1; }
  mux-meetings .sample-person.guest i { background:#a87258; }
  mux-meetings .sample-person b { position:absolute; width:19%; aspect-ratio:1.6; left:41%; top:18%; border-radius:60% 60% 30% 30%; background:#24202b; z-index:2; }
  mux-meetings .sample-screen { position:absolute; inset:0; padding:10%; color:#26354e; background:#f4f6fb; }
  mux-meetings .sample-screen i { display:block; width:22%; height:8px; margin-bottom:10%; border-radius:5px; background:#5f82bb; }
  mux-meetings .sample-screen strong { font-size:clamp(16px,2vw,34px); }
  mux-meetings .sample-screen p { color:#55657d; }
  mux-meetings .call-stage span { position:absolute; bottom:var(--ui-space-2); left:var(--ui-space-2); padding:2px 7px; border-radius:var(--ui-radius-sm); background:#111827b9; color:white; font-size:var(--ui-text-xs); }
  mux-meetings .call-controls { display:flex; flex-wrap:wrap; gap:var(--ui-space-2); margin:var(--ui-space-4) 0; }
  mux-meetings .call-invite, mux-meetings .call-record-action { display:flex; align-items:center; flex-wrap:wrap; gap:var(--ui-space-3); padding:var(--ui-space-4); border:1px solid var(--ui-border); border-radius:var(--ui-radius-lg); margin:var(--ui-space-4) 0; }
  mux-meetings .call-invite span { overflow-wrap:anywhere; color:var(--ui-text-muted); font-size:var(--ui-text-sm); flex:1; }
  mux-meetings .call-record-action p { margin:0; flex:1; }
  mux-meetings .call-network { display:grid; gap:var(--ui-space-1); padding:var(--ui-space-3) var(--ui-space-4); border:1px solid var(--ui-border); border-radius:var(--ui-radius-lg); background:var(--ui-surface-raised); }
  mux-meetings .call-network strong { font-size:var(--ui-text-sm); }
  mux-meetings .call-network span, mux-meetings .call-network p { color:var(--ui-text-muted); font-size:var(--ui-text-xs); margin:0; }
  mux-meetings .record-live { margin:var(--ui-space-3) 0; }
  @container(max-width:620px) { mux-meetings .meeting-layout { display:flex; flex-direction:column; } mux-meetings .meeting-rail { min-height:160px; max-height:36%; } mux-meetings .meeting-divider { height:1px; } mux-meetings .meeting-viewer { flex:1; } }
  @container(max-width:620px) { mux-meetings .call-stage, mux-meetings .call-stage.sharing { display:flex; flex-direction:column; } mux-meetings .call-screen-tile { aspect-ratio:16/10 !important; } mux-meetings .call-video-tile { aspect-ratio:16/9 !important; } }
`;

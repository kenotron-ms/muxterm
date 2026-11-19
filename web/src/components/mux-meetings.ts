import { LitElement, html, nothing, type PropertyValues } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { ArrowLeft, AudioLines, Check, Copy, Download, Ellipsis, LayoutGrid, Mic, MicOff, Minus, MonitorUp, Plus, Radio, RefreshCw, Signal, Square, Trash2, Video, VideoOff, WifiOff, X } from 'lucide';
import { apiPath } from '../lib/base-path.js';
import { icon } from '../lib/icons.js';
import '../ui/button.js';
import '../ui/dialog.js';
import '../ui/empty-state.js';
import '../ui/feedback.js';
import '../ui/rail-row.js';
import '../ui/text-field.js';
import type { MuxUITextField } from '../ui/text-field.js';

type Meeting = { id:string; chatId:string; title:string; kind:'recording'|'call'; startedAt:string; endedAt?:string; participants:string[]; recordingState:string; transcriptState:string; transcriptSource?:string; transcriptError?:string; linkedNoteId?:string; mediaType?:string; mediaBytes:number; chunks:number; error?:string };
type TranscriptionOptions = { localReady:boolean; localDetail:string; providerReady:boolean; providerName:string; providerModel:string; providerDetail:string };
type Transcript = { revision:number; segments:{id:string;startMs:number;endMs:number;text:string;speaker:string}[]; corrections:Record<string,string> };
type LocalChunk = { key:string; blob:Blob };
type CallRoute = 'checking'|'direct'|'relay'|'stalled'|'failed';
type CallLayout = 'side'|'stacked'|'focus';
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

export function drawRecordingVideo(context:CanvasRenderingContext2D, source:CanvasImageSource, sourceWidth:number, sourceHeight:number, x:number, y:number, width:number, height:number, fit:'cover'|'contain') {
  if (!sourceWidth || !sourceHeight) return;
  const sourceRatio=sourceWidth/sourceHeight;
  const frameRatio=width/height;
  if (fit==='contain') {
    const drawnWidth=sourceRatio>frameRatio?width:height*sourceRatio;
    const drawnHeight=sourceRatio>frameRatio?width/sourceRatio:height;
    context.drawImage(source,x+(width-drawnWidth)/2,y+(height-drawnHeight)/2,drawnWidth,drawnHeight);
    return;
  }
  const cropWidth=sourceRatio>frameRatio?sourceHeight*frameRatio:sourceWidth;
  const cropHeight=sourceRatio>frameRatio?sourceHeight:sourceWidth/frameRatio;
  context.drawImage(source,(sourceWidth-cropWidth)/2,(sourceHeight-cropHeight)/2,cropWidth,cropHeight,x,y,width,height);
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
  private callFallbackWarning = '';
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
  private recordCallByDefault = true;
  private callLayout:CallLayout = 'focus';
  private selfVideoMinimized = false;
  private connectionOpen = false;
  private layoutOpen = false;
  private moreOpen = false;
  private callCanvas?:HTMLCanvasElement;
  private callDrawTimer?:number;
  private callAudio?:AudioContext;
  private callRecordStream?:MediaStream;
  private transcript?:Transcript;
  private transcriptMeetingId = '';
  private correctionDraft:Record<string,string> = {};
  private transcriptBusy = false;
  private transcriptNotice = '';
  private transcriptionOptions?:TranscriptionOptions;
  private transcribeProviderId = '';
  private loadRequest = 0;
  private sampleScene = '';
  private sampleMicOn = true;
  private sampleCameraOn = true;
  private locallyRecoverable = new Set<string>();

  override createRenderRoot() { return this; }
  override connectedCallback() {
    super.connectedCallback();
    void this.loadTranscriptionOptions();
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
  showSample(scene:'library'|'review'|'transcription'|'recorder'|'preflight'|'hosting-required'|'waiting'|'call'|'relay'|'stalled'|'failed'|'share'|'recording'|'recording-share') {
    this.loadRequest++;
    this.sampleScene=scene;
    this.loading=false;
    this.sampleMicOn=true;
    this.sampleCameraOn=true;
    this.recordCallByDefault=true;
    this.callLayout='focus';
    this.selfVideoMinimized=false;
    this.connectionOpen=false;
    this.layoutOpen=false;
    this.moreOpen=false;
    const now=new Date().toISOString();
    const recording:Meeting={id:'sample-recording',chatId:this.sessionId,title:'Product review',kind:'recording',startedAt:new Date(Date.now()-28*60*1000).toISOString(),endedAt:now,participants:['You','Mara'],recordingState:'ready',transcriptState:scene==='transcription'?'not_started':'ready',transcriptSource:'local',mediaType:'audio/webm',mediaBytes:2400000,chunks:4};
    const call:Meeting={id:'sample-call',chatId:this.sessionId,title:'Design review',kind:'call',startedAt:new Date(Date.now()-8*60*1000).toISOString(),participants:['You','Mara'],recordingState:'not_started',transcriptState:'not_started',mediaBytes:0,chunks:0};
    this.meetings=[recording,call];
    this.selectedId=scene==='library'||scene==='preflight'||scene==='hosting-required'?'':scene==='review'||scene==='transcription'||scene==='recorder'?'sample-recording':'sample-call';
    this.transcriptionOptions={localReady:true,localDetail:'',providerReady:true,providerName:'OpenAI',providerModel:'gpt-transcribe',providerDetail:''};
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
    if (!this.callPreparing) {
      this.recordCallByDefault = true;
      this.callLayout = 'focus';
      this.selfVideoMinimized = false;
    }
    this.callPreparing = true;
    const attempt=++this.callPreparationSeq;
    this.callHostingError = '';
    this.callFallbackWarning = '';
    this.requestUpdate();
    try {
      const readinessResponse=await fetch(apiPath('/api/meetings/call-readiness'));
      if (attempt!==this.callPreparationSeq) return;
      if (!readinessResponse.ok) throw new Error(`Could not check call hosting (${readinessResponse.status}).`);
      const readiness=await readinessResponse.json() as {available:boolean;reason:string;warning?:string};
      if (attempt!==this.callPreparationSeq) return;
      if (!readiness.available) { this.callHostingError=readiness.reason; this.requestUpdate(); return; }
      this.callFallbackWarning=readiness.warning || '';
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
    this.callFallbackWarning = '';
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
      const invite = await invited.json() as {inviteUrl:string;iceServers:RTCIceServer[];iceWarning?:string};
      if (stale()) { await fetch(meetingPath(meeting.id),{method:'DELETE',keepalive:true}); return; }
      this.callId = meeting.id;
      this.selectedId = meeting.id;
      this.meetings.unshift(meeting);
      this.inviteUrl = invite.inviteUrl;
      this.callFallbackWarning = invite.iceWarning || '';
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
      const peer = new RTCPeerConnection({iceServers:invite.iceServers || [], iceTransportPolicy:'all'});
      this.callPeer = peer;
      const chatId=this.sessionId,meetingId=meeting.id;
      peer.onicecandidate = event => { if (event.candidate && this.callPeer===peer) void this.callSignal('ice',event.candidate,meetingId,chatId).catch(error => { this.callStatus=String(error); this.requestUpdate(); }); };
      peer.onicecandidateerror = event => { const code=(event as Event & {errorCode?:number}).errorCode; this.callNetwork={...this.callNetwork,errorCode:code}; this.requestUpdate(); };
      peer.oniceconnectionstatechange = () => { void this.inspectCallNetwork(); };
      peer.onconnectionstatechange = () => { this.callStatus=peer.connectionState==='connected'?'Connected to guest':peer.connectionState==='failed'?'Media connection failed':peer.connectionState==='disconnected'?'Guest media disconnected; reconnecting…':'Connecting media…'; void this.inspectCallNetwork(); this.maybeStartCallRecording(); this.requestUpdate(); };
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
        this.maybeStartCallRecording();
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
      this.maybeStartCallRecording();
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
    if (typeof MediaRecorder === 'undefined') return '';
    for (const candidate of ['video/webm;codecs=vp8,opus','video/webm','video/mp4']) if (MediaRecorder.isTypeSupported(candidate)) return candidate;
    return '';
  }
  private maybeStartCallRecording() {
    if (this.recordCallByDefault && this.callId && this.guestJoined && this.callPeer?.connectionState === 'connected' && this.remoteStream?.getAudioTracks().some(track=>track.readyState==='live')) void this.startCallRecording();
  }
  private async startCallRecording() {
    if (!this.callId || this.callLeaving || this.callRecording || this.callRecordingStarting) return;
    if (!this.guestJoined || !this.remoteStream?.getAudioTracks().some(track=>track.readyState==='live')) {
      this.callStatus='Wait for the guest audio before recording the call.';
      this.requestUpdate();
      return;
    }
    const mediaType=this.videoCaptureType();
    if (!mediaType) { this.recordCallByDefault=false; this.callStatus='Recording failed: This browser cannot record call video.'; this.requestUpdate(); return; }
    const recordingMeetingId=this.callId;
    this.callRecordingStarting=true;this.requestUpdate();
    try {
      const canvas=document.createElement('canvas'); canvas.width=1280; canvas.height=720; this.callCanvas=canvas;
      const context=canvas.getContext('2d'); if (!context) throw new Error('Canvas capture unavailable');
      const draw=()=>{
        context.fillStyle='#161c28';context.fillRect(0,0,1280,720);
        const local=this.querySelector<HTMLVideoElement>('.call-local'),remote=this.querySelector<HTMLVideoElement>('.call-remote'),screen=this.querySelector<HTMLVideoElement>('.call-screen');
        const drawVideo=(video:HTMLVideoElement|null,x:number,y:number,w:number,h:number,fit:'cover'|'contain')=>{
          if (video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) drawRecordingVideo(context,video,video.videoWidth,video.videoHeight,x,y,w,h,fit);
        };
        if (this.screenStream || this.remoteScreen) {
          drawVideo(screen,0,0,1280,720,'contain');
          drawVideo(remote,1010,20,250,140,'cover');
          drawVideo(local,1010,180,250,140,'cover');
        } else {
          drawVideo(remote,0,0,640,720,'cover');
          drawVideo(local,640,0,640,720,'cover');
        }
      };
      draw(); this.callDrawTimer=window.setInterval(draw,42);
      const captured=canvas.captureStream(24);
      const audio=new AudioContext(); this.callAudio=audio;
      const output=audio.createMediaStreamDestination();
      for (const source of [this.callStream,this.remoteStream]) if (source?.getAudioTracks().length) audio.createMediaStreamSource(new MediaStream(source.getAudioTracks())).connect(output);
      this.callRecordStream=new MediaStream([...captured.getVideoTracks(),...output.stream.getAudioTracks()]);
      const response=await fetch(this.path(recordingMeetingId,'/record-start'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mediaType})});
      if (!response.ok) throw new Error(`Could not start recording (${response.status})`);
      if (this.callId!==recordingMeetingId || this.callLeaving) { this.releaseCallCapture(); return; }
      this.uploadQueue=Promise.resolve(); this.nextChunk=0; this.captureError='';
      const recorder=new MediaRecorder(this.callRecordStream,{mimeType:mediaType});
      this.callRecorder=recorder;
      const chatId=this.sessionId,meetingId=recordingMeetingId;
      recorder.ondataavailable=event=>{ if(event.data.size)this.queueChunk(meetingId,event.data,chatId); };
      recorder.onerror=()=>{ this.captureError='Call recording interrupted. Saved chunks remain recoverable.'; this.requestUpdate(); };
      recorder.start(2000);
      await this.callSignal('recording',{active:true});
      this.callRecording=true;
      this.requestUpdate();
    } catch (error) {
      if (this.callRecorder?.state==='recording') this.callRecorder.stop();
      this.callRecorder=undefined;this.callRecording=false;
      this.recordCallByDefault=false;
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
    this.callId='';this.inviteUrl='';this.callFallbackWarning='';this.callRecording=false;this.remoteStream=undefined;this.remoteScreen=undefined;
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
    this.transcribeProviderId='';
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
  private async loadTranscriptionOptions() {
    if (this.sampleScene) return;
    try {
      const response=await fetch(apiPath('/api/meetings/transcription-options'));
      if (!response.ok) throw new Error(`Setup check failed (${response.status})`);
      const options=await response.json() as TranscriptionOptions;
      if (!this.sampleScene) this.transcriptionOptions=options;
    } catch {
      if (!this.sampleScene) this.transcriptionOptions={localReady:false,localDetail:'Could not check local transcription setup.',providerReady:false,providerName:'',providerModel:'',providerDetail:'Could not check Voice settings.'};
    }
    this.requestUpdate();
  }
  private async transcribe(meeting:Meeting,engine:'local'|'voice') {
    this.transcriptBusy=true;this.transcriptNotice='';this.requestUpdate();
    try {
      const response=await fetch(this.path(meeting.id,'/transcribe'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({engine})});
      if(!response.ok)throw new Error((await response.text()).trim() || `Could not queue transcription (${response.status})`);
      await this.load(false);
    } catch(error) { this.transcriptNotice=String(error); }
    this.transcriptBusy=false;this.requestUpdate();
  }
  private transcriptionActions(meeting:Meeting) {
    const options=this.transcriptionOptions;
    if (!options) return html`<mux-ui-feedback kind="loading">Checking transcription setup…</mux-ui-feedback>`;
    return html`<div class="meeting-transcription-actions">
      ${options.localReady ? html`<mux-ui-button variant="secondary" ?disabled=${this.transcriptBusy} @click=${() => void this.transcribe(meeting,'local')}>Transcribe on this server</mux-ui-button>` : nothing}
      ${options.providerReady ? html`<mux-ui-button variant="secondary" ?disabled=${this.transcriptBusy} @click=${() => {this.transcribeProviderId=meeting.id;this.requestUpdate();}}>Transcribe with ${options.providerName}</mux-ui-button><p class="transcription-disclosure">This sends the saved audio to ${options.providerName} using the Voice credential. Muxterm keeps the resulting transcript with this meeting.</p>` : nothing}
      ${!options.localReady ? html`<p class="transcription-disclosure">On this server: ${options.localDetail}</p>` : nothing}
      ${!options.providerReady ? html`<p class="transcription-disclosure">Voice provider: ${options.providerDetail}</p>` : nothing}
      <mux-ui-button size="small" variant="quiet" @click=${() => void this.loadTranscriptionOptions()}>Refresh transcription setup</mux-ui-button>
    </div>`;
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
    return html`<section class="meeting-transcript"><div class="transcript-header"><div><strong>Transcript</strong><p>${state==='ready' ? `Stored with this meeting · ${meeting.transcriptSource === 'local' || !meeting.transcriptSource ? 'transcribed on this server' : `transcribed with ${meeting.transcriptSource}`}.` : 'Choose where saved audio is transcribed. Speaker identity is unknown for mixed audio.'}</p></div>${state==='ready' ? html`<a href=${this.path(meeting.id,'/transcript/export')} download=${`meeting-${meeting.id}.vtt`}>${icon(Download,{size:15})} Export VTT</a>` : nothing}</div>
      ${state==='failed' ? html`<mux-ui-feedback kind="error">${meeting.transcriptError || 'Transcription failed.'}</mux-ui-feedback>` : nothing}
      ${state==='not_started'||state==='failed' ? this.transcriptionActions(meeting) : nothing}
      ${state==='queued'||state==='processing' ? html`<mux-ui-feedback kind="loading">${state==='queued'?'Transcription queued…':`Transcribing saved media ${meeting.transcriptSource === 'local' ? 'on this server' : meeting.transcriptSource ? `with ${meeting.transcriptSource}` : ''}…`}</mux-ui-feedback>` : nothing}
      ${state==='ready' ? this.transcriptMeetingId===meeting.id && this.transcript ? html`<div class="transcript-segments">${this.transcript.segments.map(segment => html`<div class="transcript-segment"><button class="transcript-time" @click=${() => this.seekTranscript(segment.startMs)}>${this.clock(Math.floor(segment.startMs/1000))}</button><div><strong>${segment.speaker}</strong><textarea aria-label=${`Correct transcript at ${this.clock(Math.floor(segment.startMs/1000))}`} .value=${this.correctionDraft[segment.id] ?? segment.text} @input=${(event:Event) => {this.correctionDraft[segment.id]=(event.target as HTMLTextAreaElement).value;}}></textarea></div></div>`)}</div><div class="meeting-buttons"><mux-ui-button variant="secondary" ?disabled=${this.transcriptBusy} @click=${() => void this.saveCorrections(meeting)}>Save corrections</mux-ui-button>${meeting.linkedNoteId ? html`<mux-ui-button variant="secondary" @click=${() => this.openLinkedNote(meeting.linkedNoteId!)}>Open linked note</mux-ui-button>` : html`<mux-ui-button variant="secondary" ?disabled=${this.transcriptBusy} @click=${() => void this.createLinkedNote(meeting)}>Create linked note</mux-ui-button>`}</div>` : html`<mux-ui-feedback kind="loading">Loading transcript…</mux-ui-feedback>` : nothing}
      ${this.transcriptNotice ? html`<mux-ui-feedback kind=${this.transcriptNotice.includes('saved')?'info':'warning'}>${this.transcriptNotice}</mux-ui-feedback>` : nothing}
      <mux-ui-dialog size="compact" presentation="adaptive" label="Send meeting audio for transcription" ?open=${this.transcribeProviderId===meeting.id} @dismiss=${() => {this.transcribeProviderId='';this.requestUpdate();}}>
        <div class="meeting-confirm"><h2>Send audio to ${this.transcriptionOptions?.providerName || 'the Voice provider'}?</h2><p>The saved audio will be sent to ${this.transcriptionOptions?.providerName || 'the configured Voice provider'} for transcription. Muxterm stores the transcript with this meeting.</p><div class="meeting-buttons"><mux-ui-button variant="secondary" @click=${() => {this.transcribeProviderId='';this.requestUpdate();}}>Cancel</mux-ui-button><mux-ui-button variant="primary" @click=${() => {this.transcribeProviderId='';void this.transcribe(meeting,'voice');}}>Send and transcribe</mux-ui-button></div></div>
      </mux-ui-dialog>
    </section>`;
  }
  private duration(meeting:Meeting) {
    const end = meeting.endedAt ? Date.parse(meeting.endedAt) : Date.now();
    return Math.max(0,Math.floor((end-Date.parse(meeting.startedAt))/1000));
  }
  private clock(seconds:number) { return `${Math.floor(seconds/60).toString().padStart(2,'0')}:${(seconds%60).toString().padStart(2,'0')}`; }
  private inputMeter() { return html`<div class="input-meter"><span>Input level</span><div role="meter" aria-label="Microphone input level" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${this.inputLevel}><i style=${`width:${this.inputLevel}%`}></i></div></div>`; }
  private meetingBody(selected?:Meeting) {
    const recent=this.meetings.filter(item=>`${item.title} ${item.participants.join(' ')}`.toLowerCase().includes(this.query.toLowerCase()));
    if (this.callPreparing) return html`<div class="meeting-prejoin">
      ${this.callHostingError ? html`<mux-ui-feedback kind="warning" density="compact">${this.callHostingError}</mux-ui-feedback>` : nothing}
      ${this.callFallbackWarning && !this.callHostingError ? html`<mux-ui-feedback kind="warning" density="compact">${this.callFallbackWarning}</mux-ui-feedback>` : nothing}
      ${this.callStream ? html`
        <video class="call-preview" autoplay playsinline muted aria-label="Camera preview"></video>
        <div class="call-device-fields"><label>Microphone<select aria-label="Call microphone" @change=${(event:Event) => {this.callAudioDeviceId=(event.target as HTMLSelectElement).value;void this.prepareCall();}}>${this.callAudioDevices.length ? this.callAudioDevices.map(device=>html`<option value=${device.deviceId} ?selected=${device.deviceId===this.callAudioDeviceId}>${device.label || 'Microphone'}</option>`) : html`<option>Default microphone</option>`}</select></label><label>Camera<select aria-label="Call camera" @change=${(event:Event) => {this.callVideoDeviceId=(event.target as HTMLSelectElement).value;void this.prepareCall();}}>${this.callVideoDevices.length ? this.callVideoDevices.map(device=>html`<option value=${device.deviceId} ?selected=${device.deviceId===this.callVideoDeviceId}>${device.label || 'Camera'}</option>`) : html`<option>Default camera</option>`}</select></label></div>
        <label class="call-record-default"><input type="checkbox" .checked=${this.recordCallByDefault} @change=${(event:Event) => {this.recordCallByDefault=(event.target as HTMLInputElement).checked;this.requestUpdate();}}><span>Record automatically</span></label>
        <div class="meeting-buttons"><mux-ui-button variant="primary" ?disabled=${this.callStarting} @click=${() => void this.startCall()}>${icon(Video,{size:15})} Create call link</mux-ui-button><mux-ui-button variant="quiet" @click=${() => this.abandonCall()}>Cancel</mux-ui-button></div>
      ` : this.callHostingError ? html`<div class="meeting-buttons"><mux-ui-button variant="secondary" @click=${() => void this.prepareCall()}>Check again</mux-ui-button><mux-ui-button variant="quiet" @click=${() => this.abandonCall()}>Cancel</mux-ui-button></div>` : html`<mux-ui-feedback kind="loading" density="compact">Checking camera and microphone…</mux-ui-feedback>`}
    </div>`;
    if (this.callId) return this.callView();
    if (this.preparation) return html`<div class="meeting-detail"><h2>Record alone</h2>${this.stream ? html`<label class="meeting-field" for="meeting-input">Microphone<select id="meeting-input" @change=${(event:Event) => { this.deviceId=(event.target as HTMLSelectElement).value; void this.prepare(); }}>${this.devices.map(device => html`<option value=${device.deviceId} ?selected=${device.deviceId===this.deviceId}>${device.label || 'Microphone'}</option>`)}</select></label>${this.inputMeter()}<div class="meeting-buttons"><mux-ui-button variant="primary" ?disabled=${this.recordingStarting} @click=${() => void this.startRecording()}>${icon(Mic,{size:15})} Start recording</mux-ui-button><mux-ui-button variant="quiet" @click=${() => this.abandonPreparation()}>Cancel</mux-ui-button></div>` : html`<mux-ui-feedback kind="loading" density="compact">Requesting microphone…</mux-ui-feedback>`}</div>`;
    if (this.activeId) return html`<div class="meeting-detail"><div class="record-live">● Recording ${this.clock(this.elapsed)}</div><h2>${selected?.title || 'Quick recording'}</h2>${this.inputMeter()}<mux-ui-button variant="danger" @click=${() => void this.stopRecording()}>${icon(Square,{size:15})} Stop and save</mux-ui-button></div>`;
    if (selected) return html`<div class="meeting-detail meeting-review"><h2>${selected.recordingState==='ready' ? 'Recording saved' : selected.title}</h2><div class="meeting-meta">${selected.title} · ${new Date(selected.startedAt).toLocaleString()} · ${this.clock(this.duration(selected))}</div>${selected.error ? html`<mux-ui-feedback kind="warning" density="compact">${selected.error}</mux-ui-feedback>` : nothing}${selected.recordingState==='ready' ? html`${selected.mediaType?.startsWith('video/') ? html`<video class="meeting-player" controls preload="metadata" src=${this.path(selected.id,'/media')}></video>` : html`<audio controls preload="metadata" src=${this.path(selected.id,'/media')}></audio>`}<a class="meeting-download" href=${this.path(selected.id,'/media')} download=${`meeting-${selected.id}.webm`}>${icon(Download,{size:15})} Download original</a>${this.transcriptView(selected)}` : selected.chunks > 0 || this.locallyRecoverable.has(selected.id) ? html`<mux-ui-button variant="secondary" @click=${() => void this.recover(selected)}>Recover recording</mux-ui-button>` : nothing}<div class="meeting-buttons"><mux-ui-button variant="danger" @click=${() => { this.deleteId=selected.id; this.requestUpdate(); }}>${icon(Trash2,{size:15})} Delete meeting</mux-ui-button></div></div>`;
    return html`<div class="meeting-home"><div class="meeting-actions"><mux-ui-button variant="primary" @click=${() => void this.prepareCall()}>${icon(Video,{size:15})} Start recorded call</mux-ui-button><mux-ui-button variant="secondary" @click=${() => void this.prepare()}>${icon(Mic,{size:15})} Record alone</mux-ui-button></div><section class="meeting-history" aria-label="Recent meetings"><div class="meeting-history-heading"><h2>Recent meetings</h2><mux-ui-button icon-only size="small" variant="quiet" accessible-label="Refresh meetings" tooltip="Refresh meetings" @click=${() => void this.load()}>${icon(RefreshCw,{size:15})}</mux-ui-button></div><mux-ui-text-field type="search" size="small" aria-label="Search recordings" placeholder="Search recordings" .value=${this.query} @input=${(event:Event) => {this.query=(event.target as MuxUITextField).liveValue;this.requestUpdate();}}></mux-ui-text-field><div class="meeting-rows">${this.loading ? html`<mux-ui-feedback kind="loading" density="compact">Loading meetings…</mux-ui-feedback>` : recent.map(meeting=>html`<button class="meeting-row" @click=${() => this.selectMeeting(meeting)}><span class="meeting-row-icon">${icon(meeting.kind==='call' ? Video : AudioLines,{size:16})}</span><span class="meeting-row-text"><strong>${meeting.title}</strong><small>${new Date(meeting.startedAt).toLocaleDateString()} · ${this.clock(this.duration(meeting))}${meeting.recordingState==='ready' ? ' · Recording ready' : ''}</small></span></button>`)}${!this.loading && !recent.length ? html`<div class="meeting-empty">${this.query?'No matching meetings':'No meetings yet'}</div>` : nothing}</div></section></div>`;
  }
  private networkView() {
    const network=this.callNetwork;
    const routeLabel=network.route==='direct'?'Direct connection':network.route==='relay'?'TURN relay':network.route==='failed'?'No connection':network.route==='stalled'?'Still connecting':'Checking connection';
    const glyph=network.route==='failed' ? WifiOff : network.route==='relay' ? Radio : Signal;
    const details=[network.ice,network.protocol?.toUpperCase(),network.localType && network.remoteType ? `${network.localType} ↔ ${network.remoteType}` : '',network.relayProtocol ? `TURN ${network.relayProtocol.toUpperCase()}` : ''].filter(Boolean).join(' · ');
    return html`<div class="connection-wrap"><mux-ui-button class="connection-trigger ${network.route}" icon-only size="small" variant="quiet" accessible-label=${routeLabel} tooltip=${routeLabel} .expanded=${this.connectionOpen} @click=${() => {this.connectionOpen=!this.connectionOpen;this.layoutOpen=false;this.moreOpen=false;this.requestUpdate();}}>${icon(glyph,{size:17})}</mux-ui-button>${this.connectionOpen ? html`<div class="connection-popover" role="status"><strong>${routeLabel}</strong><span>${details}</span>${network.route==='failed' || network.route==='stalled' ? html`<span>${network.turnConfigured ? 'Check TURN settings' : 'TURN is not configured'}</span>` : nothing}</div>` : nothing}</div>`;
  }
  private callView() {
    const localAudio=this.callStream?.getAudioTracks()[0],localVideo=this.callStream?.getVideoTracks()[0];
    const screen=this.screenStream || this.remoteScreen;
    const waiting=!this.guestJoined;
    return html`<div class="meeting-call">
      <h2>${waiting ? 'Waiting for guest' : 'You and your guest'}</h2>
      ${this.callFallbackWarning ? html`<mux-ui-feedback kind="warning" density="compact">${this.callFallbackWarning}</mux-ui-feedback>` : nothing}
      ${this.callNetwork.route==='failed' ? html`<mux-ui-feedback kind="error" density="compact">${this.callStatus || 'Media connection failed'}</mux-ui-feedback>` : nothing}
      ${this.callStatus.startsWith('Recording failed:') ? html`<mux-ui-feedback kind="error" density="compact">${this.callStatus}</mux-ui-feedback>` : nothing}
      <div class="call-stage ${screen ? 'sharing' : ''} ${waiting ? 'waiting' : ''} layout-${this.callLayout} ${this.selfVideoMinimized ? 'self-minimized' : ''} ${this.sampleScene ? 'sample-media' : ''}">
        ${screen ? html`<div class="call-screen-tile">${this.sampleScene ? html`<div class="sample-screen"><i></i><strong>Project notes</strong></div>` : nothing}<video class="call-screen" autoplay playsinline ?muted=${!!this.screenStream}></video><span>${this.screenStream ? 'Your screen' : 'Guest screen'}</span></div>` : nothing}
        <div class="call-video-tile guest">${this.sampleScene && !waiting ? html`<div class="sample-person guest"><i></i><b></b></div>` : waiting ? html`<div class="waiting-avatar">${icon(Plus,{size:28})}</div>` : nothing}<video class="call-remote" autoplay playsinline></video><span>${waiting ? 'Guest' : 'Guest'}</span></div>
        <div class="call-video-tile self">${this.sampleScene ? html`<div class="sample-person host"><i></i><b></b></div>` : nothing}<video class="call-local" autoplay playsinline muted></video><span>You</span>${this.callLayout==='focus' ? html`<button class="self-minimize" aria-label="Minimize your video" title="Minimize your video" @click=${() => {this.selfVideoMinimized=true;this.requestUpdate();}}>${icon(Minus,{size:14})}</button>` : nothing}</div>
        ${this.callLayout==='focus' && this.selfVideoMinimized ? html`<button class="self-restore" @click=${() => {this.selfVideoMinimized=false;this.requestUpdate();}}>Show my video</button>` : nothing}
      </div>
      ${waiting ? html`<div class="call-invite"><div><strong>Invite your guest</strong><span title=${this.inviteUrl}>${this.inviteUrl}</span></div><mux-ui-button size="small" variant="secondary" @click=${() => void navigator.clipboard.writeText(this.inviteUrl).catch(error=>{this.callStatus=String(error);this.requestUpdate();})}>${icon(Copy,{size:15})} Copy link</mux-ui-button></div>` : nothing}
      <div class="call-controls"><mux-ui-button icon-only size="small" variant="secondary" accessible-label=${(this.sampleScene ? this.sampleMicOn : localAudio?.enabled) ? 'Mute microphone' : 'Unmute microphone'} tooltip=${(this.sampleScene ? this.sampleMicOn : localAudio?.enabled) ? 'Mute microphone' : 'Unmute microphone'} @click=${() => {if(this.sampleScene)this.sampleMicOn=!this.sampleMicOn;else if(localAudio)localAudio.enabled=!localAudio.enabled;this.requestUpdate();}}>${icon((this.sampleScene ? this.sampleMicOn : localAudio?.enabled) ? Mic : MicOff,{size:17})}</mux-ui-button><mux-ui-button icon-only size="small" variant="secondary" ?disabled=${!localVideo&&!this.sampleScene} accessible-label=${(this.sampleScene ? this.sampleCameraOn : localVideo?.enabled) ? 'Turn camera off' : 'Turn camera on'} tooltip=${(this.sampleScene ? this.sampleCameraOn : localVideo?.enabled) ? 'Turn camera off' : 'Turn camera on'} @click=${() => {if(this.sampleScene)this.sampleCameraOn=!this.sampleCameraOn;else if(localVideo)localVideo.enabled=!localVideo.enabled;this.requestUpdate();}}>${icon((this.sampleScene ? this.sampleCameraOn : localVideo?.enabled) ? Video : VideoOff,{size:17})}</mux-ui-button><mux-ui-button icon-only size="small" variant="secondary" accessible-label=${screen ? 'Stop sharing screen' : 'Share screen'} tooltip=${screen ? 'Stop sharing screen' : 'Share screen'} @click=${() => {if(this.sampleScene){this.screenStream=this.screenStream?undefined:new MediaStream();this.requestUpdate();}else void this.toggleShare();}}>${icon(MonitorUp,{size:17})}</mux-ui-button>
        ${!waiting ? html`<div class="call-menu-wrap"><mux-ui-button icon-only size="small" variant="secondary" accessible-label="Change video layout" tooltip="Change video layout" .expanded=${this.layoutOpen} @click=${() => {this.layoutOpen=!this.layoutOpen;this.moreOpen=false;this.connectionOpen=false;this.requestUpdate();}}>${icon(LayoutGrid,{size:17})}</mux-ui-button>${this.layoutOpen ? html`<div class="call-menu layout-menu" role="group" aria-label="Video layouts">${(['side','stacked','focus'] as const).map((layout)=>html`<button aria-pressed=${this.callLayout===layout} @click=${() => {this.callLayout=layout;this.selfVideoMinimized=false;this.layoutOpen=false;this.requestUpdate();}}>${layout==='side'?'Side by side':layout==='stacked'?'Stacked':'Focus guest'}${this.callLayout===layout ? icon(Check,{size:14}) : nothing}</button>`)}</div>` : nothing}</div>` : nothing}
        <div class="call-menu-wrap"><mux-ui-button icon-only size="small" variant="secondary" accessible-label="More call actions" tooltip="More call actions" .expanded=${this.moreOpen} @click=${() => {this.moreOpen=!this.moreOpen;this.layoutOpen=false;this.connectionOpen=false;this.requestUpdate();}}>${icon(Ellipsis,{size:17})}</mux-ui-button>${this.moreOpen ? html`<div class="call-menu more-menu" role="group" aria-label="More call actions"><button @click=${() => {void navigator.clipboard.writeText(this.inviteUrl).catch(error=>{this.callStatus=String(error);this.requestUpdate();});this.moreOpen=false;this.requestUpdate();}}>Copy invite link</button>${this.callRecording ? html`<button @click=${() => {this.recordCallByDefault=false;this.moreOpen=false;if(this.sampleScene){this.callRecording=false;this.requestUpdate();}else void this.stopCallRecording();}}>Stop recording</button>` : !waiting ? html`<button ?disabled=${this.callRecordingStarting || (!this.sampleScene && !this.remoteStream?.getAudioTracks().some(track=>track.readyState==='live'))} @click=${() => {this.moreOpen=false;if(this.sampleScene){this.callRecording=true;this.requestUpdate();}else void this.startCallRecording();}}>Start recording</button>` : nothing}</div>` : nothing}</div>
        <mux-ui-button class="end-call" size="small" variant="danger" accessible-label="End call" tooltip="End call" ?disabled=${this.callLeaving} @click=${() => {if(this.sampleScene){this.callId='';this.requestUpdate();}else void this.leaveCall();}}>${icon(X,{size:16})}<span>End call</span></mux-ui-button>
      </div>
    </div>`;
  }

  override render() {
    const selected=this.selected();
    const home=!this.callPreparing && !this.callId && !this.preparation && !this.activeId && !selected;
    const title=this.callPreparing?'Before you start':this.callId ? this.guestJoined ? 'Call with guest' : 'New call' : this.preparation?'Record alone':this.activeId?'Recording':selected?'Recording':'Meetings';
    const back=()=>{if(this.callPreparing)this.abandonCall();else if(this.preparation)this.abandonPreparation();else {this.selectedId='';this.requestUpdate();}};
    return html`<style>${styles}</style><section class="meeting-layout">
      <header class="meeting-top">${!home && !this.callId && !this.activeId ? html`<mux-ui-button icon-only size="small" variant="quiet" accessible-label="Back to meetings" tooltip="Back to meetings" @click=${back}>${icon(ArrowLeft,{size:17})}</mux-ui-button>` : nothing}<strong>${title}</strong><div class="meeting-top-actions">${this.callId ? html`<span class="record-badge ${this.callRecording?'active':''}"><i></i>${this.callRecording?'Recording':this.recordCallByDefault?'Recording ready':'Recording off'}</span>${this.networkView()}` : this.activeId ? html`<span class="record-badge active"><i></i>${this.clock(this.elapsed)}</span>` : nothing}</div></header>
      <main class="meeting-viewer">${this.error ? html`<mux-ui-feedback kind="error" density="compact">${this.error}</mux-ui-feedback>` : nothing}${this.captureError ? html`<mux-ui-feedback kind="warning" density="compact">${this.captureError}</mux-ui-feedback>` : nothing}${this.meetingBody(selected)}</main>
      <mux-ui-dialog size="compact" presentation="adaptive" label="Delete meeting" ?open=${!!this.deleteId} @dismiss=${() => {this.deleteId='';this.requestUpdate();}}><div class="meeting-confirm"><h2>Delete this meeting?</h2><p>The recording and saved chunks will be removed.</p><div class="meeting-buttons"><mux-ui-button variant="secondary" @click=${() => {this.deleteId='';this.requestUpdate();}}>Cancel</mux-ui-button><mux-ui-button variant="danger" @click=${() => void this.deleteMeeting()}>Delete meeting</mux-ui-button></div></div></mux-ui-dialog>
    </section>`;
  }

}

const styles = `
  mux-meetings { display:block; height:100%; min-width:0; color:var(--ui-text); background:var(--ui-surface-base); font:var(--ui-text-md)/1.45 var(--ui-font-sans); container-type:inline-size; }
  mux-meetings .meeting-layout { display:flex; flex-direction:column; height:100%; min-width:0; min-height:0; }
  mux-meetings .meeting-top { box-sizing:border-box; display:flex; align-items:center; gap:var(--ui-space-2); min-height:50px; padding:0 var(--ui-space-5); border-bottom:1px solid var(--ui-border); flex:none; }
  mux-meetings .meeting-top > strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:var(--ui-text-sm); font-weight:700; }
  mux-meetings .meeting-top-actions { display:flex; align-items:center; gap:var(--ui-space-2); margin-left:auto; }
  mux-meetings .record-badge { display:inline-flex; align-items:center; gap:var(--ui-space-2); padding:5px 9px; border:1px solid var(--ui-border); border-radius:var(--ui-radius-pill); color:var(--ui-text-muted); font-size:var(--ui-text-xs); font-weight:650; white-space:nowrap; }
  mux-meetings .record-badge.active { border-color:color-mix(in srgb,var(--ui-danger) 55%,var(--ui-border)); color:var(--ui-danger); }
  mux-meetings .record-badge i { width:7px; height:7px; border-radius:50%; background:currentColor; }
  mux-meetings .meeting-viewer { flex:1; min-height:0; overflow:auto; padding:var(--ui-space-6); }
  mux-meetings .meeting-home, mux-meetings .meeting-prejoin, mux-meetings .meeting-detail, mux-meetings .meeting-call { max-width:760px; margin:0 auto; }
  mux-meetings .meeting-home { padding-top:var(--ui-space-3); }
  mux-meetings .meeting-actions { display:flex; flex-wrap:wrap; gap:var(--ui-space-2); }
  mux-meetings .meeting-history { margin-top:var(--ui-space-9); }
  mux-meetings .meeting-history-heading { display:flex; align-items:center; justify-content:space-between; gap:var(--ui-space-2); margin-bottom:var(--ui-space-3); }
  mux-meetings .meeting-history h2 { margin:0; font-size:var(--ui-text-sm); font-weight:700; }
  mux-meetings .meeting-history mux-ui-text-field { display:block; margin:0 0 var(--ui-space-2); }
  mux-meetings .meeting-rows { display:flex; flex-direction:column; }
  mux-meetings .meeting-row { display:flex; align-items:center; gap:var(--ui-space-3); width:100%; padding:var(--ui-space-3) var(--ui-space-1); border:0; border-top:1px solid var(--ui-border); background:transparent; color:var(--ui-text); text-align:left; cursor:pointer; }
  mux-meetings .meeting-row:hover, mux-meetings .meeting-row:focus-visible { background:var(--ui-surface-hover); }
  mux-meetings .meeting-row:focus-visible, mux-meetings .call-menu button:focus-visible, mux-meetings .self-minimize:focus-visible, mux-meetings .self-restore:focus-visible { outline:2px solid var(--ui-focus); outline-offset:-2px; }
  mux-meetings .meeting-row-icon { display:grid; place-items:center; width:28px; height:28px; flex:none; color:var(--ui-accent); }
  mux-meetings .meeting-row-text { display:block; min-width:0; }
  mux-meetings .meeting-row-text strong, mux-meetings .meeting-row-text small { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  mux-meetings .meeting-row-text strong { font-size:var(--ui-text-sm); font-weight:650; }
  mux-meetings .meeting-row-text small, mux-meetings .meeting-empty, mux-meetings .meeting-meta { color:var(--ui-text-muted); font-size:var(--ui-text-xs); }
  mux-meetings .meeting-empty { padding:var(--ui-space-4) 0; }
  mux-meetings .meeting-prejoin { max-width:560px; }
  mux-meetings .call-preview { display:block; width:100%; aspect-ratio:16/9; object-fit:cover; background:#151b27; border:1px solid var(--ui-border); border-radius:var(--ui-radius-lg); margin:0 0 var(--ui-space-5); }
  mux-meetings .call-device-fields { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--ui-space-3); }
  mux-meetings .call-device-fields label, mux-meetings .meeting-field { display:grid; gap:var(--ui-space-1); color:var(--ui-text); font-size:var(--ui-text-sm); font-weight:650; }
  mux-meetings .call-device-fields select, mux-meetings .meeting-field select { box-sizing:border-box; width:100%; min-width:0; min-height:39px; padding:var(--ui-space-2) var(--ui-space-3); border:1px solid var(--ui-border); border-radius:var(--ui-radius-md); background:var(--ui-surface-raised); color:var(--ui-text); font:inherit; }
  mux-meetings .call-record-default { display:flex; align-items:center; gap:var(--ui-space-3); margin:var(--ui-space-5) 0; padding:var(--ui-space-3); border:1px solid var(--ui-border); border-radius:var(--ui-radius-md); background:var(--ui-surface-raised); font-weight:650; cursor:pointer; }
  mux-meetings .call-record-default input { accent-color:var(--ui-accent); width:17px; height:17px; margin:0; }
  mux-meetings .meeting-detail { max-width:680px; }
  mux-meetings .meeting-detail h2 { font:600 var(--ui-text-xl)/1.2 var(--ui-font-sans); margin:0 0 var(--ui-space-4); }
  mux-meetings .meeting-review h2 { font-size:var(--ui-text-2xl); }
  mux-meetings .meeting-detail audio { display:block; width:100%; margin:var(--ui-space-7) 0; }
  mux-meetings .meeting-player { display:block; width:100%; max-height:420px; margin:var(--ui-space-7) 0; background:#111827; }
  mux-meetings .meeting-buttons { display:flex; flex-wrap:wrap; gap:var(--ui-space-2); margin-top:var(--ui-space-5); }
  mux-meetings .meeting-download { display:inline-flex; align-items:center; gap:var(--ui-space-2); }
  mux-meetings .record-live { color:var(--ui-danger); font-weight:700; margin-bottom:var(--ui-space-3); }
  mux-meetings .input-meter { display:flex; align-items:center; gap:var(--ui-space-3); margin:var(--ui-space-5) 0; color:var(--ui-text-muted); font-size:var(--ui-text-sm); }
  mux-meetings .input-meter [role=meter] { height:8px; flex:1; max-width:260px; overflow:hidden; border-radius:var(--ui-radius-pill); background:var(--ui-border); }
  mux-meetings .input-meter i { display:block; height:100%; border-radius:inherit; background:var(--ui-accent); transition:width .16s linear; }
  mux-meetings .meeting-call h2 { margin:0 0 var(--ui-space-3); font:650 var(--ui-text-lg)/1.25 var(--ui-font-sans); }
  mux-meetings .call-stage { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--ui-space-2); margin:0 0 var(--ui-space-3); }
  mux-meetings .call-video-tile, mux-meetings .call-screen-tile { position:relative; min-width:0; overflow:hidden; border:1px solid var(--ui-border); border-radius:var(--ui-radius-lg); background:#151b27; aspect-ratio:16/10; }
  mux-meetings .call-stage video { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; }
  mux-meetings .call-screen-tile video { object-fit:contain; }
  mux-meetings .call-stage span { position:absolute; z-index:2; left:var(--ui-space-2); bottom:var(--ui-space-2); padding:2px 6px; border-radius:var(--ui-radius-sm); background:#111827c9; color:white; font-size:var(--ui-text-xs); }
  mux-meetings .call-stage.layout-stacked { grid-template-columns:1fr; }
  mux-meetings .call-stage.layout-stacked .call-video-tile { aspect-ratio:16/7; }
  mux-meetings .call-stage.layout-focus { display:block; position:relative; }
  mux-meetings .call-stage.layout-focus .guest { width:100%; aspect-ratio:16/10; }
  mux-meetings .call-stage.layout-focus .self { position:absolute; z-index:2; width:30%; right:var(--ui-space-3); bottom:var(--ui-space-3); box-shadow:var(--ui-shadow-side-strong); }
  mux-meetings .call-stage.layout-focus .self span { display:none; }
  mux-meetings .call-stage.layout-focus.self-minimized .self { display:none; }
  mux-meetings .self-minimize, mux-meetings .self-restore { display:grid; place-items:center; position:absolute; z-index:3; right:6px; top:6px; min-width:25px; min-height:25px; padding:3px; border:1px solid #ffffff80; border-radius:var(--ui-radius-sm); background:#151b27d9; color:white; cursor:pointer; }
  mux-meetings .self-restore { top:auto; right:var(--ui-space-3); bottom:var(--ui-space-3); padding:var(--ui-space-2) var(--ui-space-3); font:inherit; font-size:var(--ui-text-xs); }
  mux-meetings .call-stage.waiting { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); }
  mux-meetings .call-stage.waiting .guest, mux-meetings .call-stage.waiting .self { position:relative; width:auto; right:auto; bottom:auto; box-shadow:none; }
  mux-meetings .call-stage.waiting .self span { display:block; }
  mux-meetings .call-stage.waiting .self-minimize { display:none; }
  mux-meetings .waiting-avatar { position:absolute; z-index:1; inset:0; display:grid; place-items:center; color:var(--ui-text-muted); }
  mux-meetings .call-stage.waiting .call-remote { display:none; }
  mux-meetings .call-stage.sharing { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); }
  mux-meetings .call-stage.sharing .call-screen-tile { grid-column:1/-1; aspect-ratio:16/9; }
  mux-meetings .call-stage.sharing .guest, mux-meetings .call-stage.sharing .self { position:relative; width:auto; right:auto; bottom:auto; box-shadow:none; }
  mux-meetings .call-stage.sharing .self span { display:block; }
  mux-meetings .call-stage.sharing .self-minimize { display:none; }
  mux-meetings .call-controls { display:flex; align-items:center; gap:var(--ui-space-2); margin:var(--ui-space-3) 0; }
  mux-meetings .call-controls .end-call { margin-left:auto; }
  mux-meetings .call-menu-wrap, mux-meetings .connection-wrap { position:relative; }
  mux-meetings .call-menu, mux-meetings .connection-popover { position:absolute; z-index:10; min-width:165px; padding:var(--ui-space-1); border:1px solid var(--ui-border); border-radius:var(--ui-radius-md); background:var(--ui-surface-raised); box-shadow:var(--ui-shadow-side-strong); }
  mux-meetings .call-menu { bottom:calc(100% + 6px); left:0; }
  mux-meetings .call-menu.more-menu { left:auto; right:0; }
  mux-meetings .call-menu button { box-sizing:border-box; display:flex; align-items:center; justify-content:space-between; gap:var(--ui-space-2); width:100%; padding:var(--ui-space-2) var(--ui-space-3); border:0; border-radius:var(--ui-radius-sm); background:transparent; color:var(--ui-text); text-align:left; white-space:nowrap; cursor:pointer; }
  mux-meetings .call-menu button:hover, mux-meetings .call-menu button[aria-pressed="true"] { background:var(--ui-surface-hover); }
  mux-meetings .call-menu button:disabled { opacity:.5; cursor:not-allowed; }
  mux-meetings .connection-popover { top:calc(100% + 8px); right:0; display:grid; gap:var(--ui-space-1); min-width:195px; padding:var(--ui-space-3); }
  mux-meetings .connection-popover strong { font-size:var(--ui-text-sm); }
  mux-meetings .connection-popover span { color:var(--ui-text-muted); font-size:var(--ui-text-xs); }
  mux-meetings .connection-trigger.relay { color:var(--ui-accent); }
  mux-meetings .connection-trigger.failed, mux-meetings .connection-trigger.stalled { color:var(--ui-danger); }
  mux-meetings .call-invite { display:flex; align-items:center; justify-content:space-between; gap:var(--ui-space-3); padding:var(--ui-space-3); border:1px solid var(--ui-border); border-radius:var(--ui-radius-md); background:var(--ui-surface-raised); }
  mux-meetings .call-invite > div { min-width:0; }
  mux-meetings .call-invite strong, mux-meetings .call-invite span { display:block; }
  mux-meetings .call-invite strong { font-size:var(--ui-text-xs); }
  mux-meetings .call-invite span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--ui-text-muted); font-size:var(--ui-text-xs); }
  mux-meetings .call-invite mux-ui-button { flex:none; }
  mux-meetings .sample-media video { opacity:0; }
  mux-meetings .sample-person { position:absolute; inset:0; background:linear-gradient(145deg,#41566d,#263b55 55%,#1b2c43); }
  mux-meetings .sample-person.guest { background:linear-gradient(145deg,#746658,#4a5366 55%,#354354); }
  mux-meetings .sample-person::before { content:''; position:absolute; width:32%; height:70%; left:34%; bottom:-29%; border-radius:45% 45% 10% 10%; background:#26364f; }
  mux-meetings .sample-person.guest::before { background:#594050; }
  mux-meetings .sample-person i { position:absolute; z-index:1; width:17%; aspect-ratio:1; left:42%; top:23%; border-radius:48%; background:#d6a37e; }
  mux-meetings .sample-person.guest i { background:#a87258; }
  mux-meetings .sample-person b { position:absolute; z-index:2; width:19%; aspect-ratio:1.6; left:41%; top:18%; border-radius:60% 60% 30% 30%; background:#24202b; }
  mux-meetings .sample-screen { position:absolute; inset:0; padding:10%; color:#26354e; background:#f4f6fb; }
  mux-meetings .sample-screen i { display:block; width:22%; height:8px; margin-bottom:10%; border-radius:5px; background:#5f82bb; }
  mux-meetings .sample-screen strong { font-size:clamp(16px,2vw,34px); }
  mux-meetings .meeting-transcript { margin:var(--ui-space-8) 0; padding-top:var(--ui-space-5); border-top:1px solid var(--ui-border); }
  mux-meetings .transcript-header { display:flex; align-items:start; justify-content:space-between; gap:var(--ui-space-4); }
  mux-meetings .transcript-header strong { font-size:var(--ui-text-lg); }
  mux-meetings .transcript-header p, mux-meetings .transcription-disclosure { color:var(--ui-text-muted); font-size:var(--ui-text-sm); }
  mux-meetings .meeting-transcription-actions { display:flex; flex-wrap:wrap; gap:var(--ui-space-3); margin:var(--ui-space-5) 0; }
  mux-meetings .transcript-segments { display:grid; gap:var(--ui-space-3); margin:var(--ui-space-5) 0; }
  mux-meetings .transcript-segment { display:grid; grid-template-columns:70px minmax(0,1fr); gap:var(--ui-space-3); }
  mux-meetings .transcript-segment strong { color:var(--ui-text-muted); font-size:var(--ui-text-xs); }
  mux-meetings .transcript-time { align-self:start; border:0; background:transparent; color:var(--ui-accent); padding:var(--ui-space-1); cursor:pointer; font:inherit; }
  mux-meetings .transcript-segment textarea { box-sizing:border-box; display:block; width:100%; min-height:58px; padding:var(--ui-space-2); border:1px solid var(--ui-border); border-radius:var(--ui-radius-md); background:var(--ui-surface-raised); color:var(--ui-text); font:inherit; resize:vertical; }
  mux-meetings .meeting-confirm { padding:var(--ui-space-5); }
  @container(max-width:470px) {
    mux-meetings .meeting-viewer { padding:var(--ui-space-4); }
    mux-meetings .meeting-actions { flex-direction:column; }
    mux-meetings .call-device-fields { grid-template-columns:1fr; }
    mux-meetings .call-stage.waiting { grid-template-columns:1fr; }
    mux-meetings .call-stage.waiting .call-video-tile { aspect-ratio:16/7; }
    mux-meetings .call-controls .end-call span { display:none; }
    mux-meetings .call-invite { gap:var(--ui-space-1); }
    mux-meetings .record-badge { padding:4px 6px; }
  }
`;

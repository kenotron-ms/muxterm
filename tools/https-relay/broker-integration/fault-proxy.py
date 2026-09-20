#!/usr/bin/env python3
"""DTU-only fault injector in front of the FastAPI sandbox broker via the DTU loopback bridge.

No payloads, credentials or channel IDs are logged. Control endpoints exist
ONLY in this verification program, never in the relay implementation.
"""
import base64, http.client, http.server, json, pathlib, threading
assert pathlib.Path('/run/systemd/container').exists(), 'DTU required'
lock=threading.Lock()
state=dict(mode='',marker='',target=None,hits=0,held=False,duplicates=0,sse_cuts=0)
class Proxy(http.server.BaseHTTPRequestHandler):
 protocol_version='HTTP/1.1'
 def log_message(self,*args):pass
 def answer(self,status,data):
  raw=json.dumps(data).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
 def do_GET(self):self.forward()
 def do_POST(self):self.forward()
 def forward(self):
  data=self.rfile.read(int(self.headers.get('Content-Length',0)))
  if self.path=='/__fault':
   with lock:
    if self.command=='POST':
     req=json.loads(data);state.update(mode=req['mode'],marker=req.get('marker',''),target=None,hits=0,held=False,duplicates=0)
    view={k:v for k,v in state.items() if k not in ('target','marker')}
   self.answer(200,view);return
  with lock:
   if self.path.endswith('/input') and self.command=='POST':
    p=json.loads(data);payload=base64.b64decode(p['data'])
    if state['marker'] and state['marker'].encode() in payload:
     target=(self.path.split('/')[2],p['seq'])
     if state['target'] is None:state['target']=target
     if state['target']==target:state['hits']+=1
   if self.path=='/worker/reply' and self.command=='POST':
    r=json.loads(data)
    if (r['id'],r['seq'])==state['target']:
     if state['mode']=='redeliver' and not state['held']:
      # Deliberately withhold the first worker ACK from the broker. A second
      # poll redelivers that already-written packet to the worker.
      state['held']=True;self.answer(200,{});return
     if state['mode']=='uncertain':state['held']=True;self.answer(503,{});return
  conn=http.client.HTTPConnection('127.0.0.1',18080,timeout=35)
  headers={k:v for k,v in self.headers.items() if k.lower() not in ('host','connection','content-length','transfer-encoding')}
  try:
   conn.request(self.command,self.path,data or None,headers);res=conn.getresponse()
   if res.getheader('Content-Type','').startswith('text/event-stream'):
    self.send_response(res.status);self.send_header('Content-Type','text/event-stream');self.send_header('Connection','close');self.end_headers();self.close_connection=True
    while True:
     chunk=res.read1(65536)
     if not chunk:break
     self.wfile.write(chunk);self.wfile.flush()
     with lock:
      if state['mode']=='sse-cut':state['mode']='';state['sse_cuts']+=1;return
    return
   body=res.read()
   with lock:
    if self.path=='/worker/poll' and state['mode']=='redeliver' and state['target']:
     for c in json.loads(body) if res.status==200 else []:
      if (c['id'],c.get('input',{}).get('seq'))==state['target']:state['duplicates']+=1
    if self.path.endswith('/input') and state['mode']=='lost-response' and res.status==200 and state['hits']==1 and (self.path.split('/')[2],json.loads(data)['seq'])==state['target']:
     state['held']=True;self.answer(503,{});return
   with lock:
    if self.path=='/worker/poll' and state['mode']=='worker-order' and state['target'] and res.status==200:
     commands=json.loads(body)
     for command in commands:
      if (command['id'],command.get('input',{}).get('seq'))==state['target']:
       command['input']['seq']+=1
       state['held']=True
     body=json.dumps(commands).encode()
   self.send_response(res.status)
   self.send_header('Content-Type',res.getheader('Content-Type','application/json'));self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
  except (BrokenPipeError,ConnectionResetError,TimeoutError):self.close_connection=True
  finally:conn.close()
http.server.ThreadingHTTPServer(('127.0.0.1',18081),Proxy).serve_forever()

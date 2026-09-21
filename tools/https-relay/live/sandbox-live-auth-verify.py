import pathlib,json,urllib.request,urllib.error,os,subprocess
r=pathlib.Path('/home/ken/artifacts/sandbox-live-private');cfg=json.loads((r/'client.json').read_text())
def call(path,body=None,token=None):
 req=urllib.request.Request('http://127.0.0.1:8088'+path,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+(cfg['token'] if token is None else token)})
 try:
  with urllib.request.urlopen(req,timeout=25) as res:return res.status,json.load(res)
 except urllib.error.HTTPError as e:return e.code,{}
assert call('/discover')[0]==200
print('PASS real Entra bearer accepted on live broker /discover: HTTP 200')
assert call('/worker/enroll',{'token':json.loads((r/'worker.json').read_text())['enrollmentToken']})[0]==401
print('PASS consumed enrollment replay: HTTP 401')
assert call('/worker/register',{'boot':os.urandom(24).hex()})[0]==401
print('PASS Entra client token rejected on worker route: HTTP 401')
old=os.urandom(24).hex();assert call('/open',{'id':old,'host':cfg['host']})[0]==200
registry=r/'.amplifier-sandbox-broker/registry.jsonl';saved=registry.read_text();entry=json.loads(saved)
try:
 entry['owner_oid']='00000000-0000-0000-0000-000000000000';registry.write_text(json.dumps(entry)+'\n')
 assert call('/discover')[0]==403
 print('PASS ownership revocation rejected previously valid Entra owner: HTTP 403')
finally:registry.write_text(saved)
assert call('/channels/'+old+'/input',{'seq':1,'data':'eA=='})[0]==410
print('PASS revoked connection stayed fenced after owner restored: HTTP 410')
old=os.urandom(24).hex();assert call('/open',{'id':old,'host':cfg['host']})[0]==200
subprocess.run(['python3','/home/ken/artifacts/restart-live-broker.py'],check=True)
subprocess.run(['python3','/home/ken/artifacts/restart-live-worker.py'],check=True)
assert call('/channels/'+old+'/input',{'seq':1,'data':'eA=='})[0]==410
print('PASS broker restart and fresh enrollment rejected old connection input: HTTP 410')

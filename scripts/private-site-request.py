"""Maintenance helper. Input credentials through hidden stdin, never arguments/files."""
import getpass,json,urllib.request,urllib.error
payload=json.loads(getpass.getpass('Private Site request JSON (hidden): '))
origin=payload['origin'].rstrip('/')
assert origin.startswith('https://') and origin.endswith('.chatgpt.site')
for item in payload['requests']:
 path=item['path'];assert path.startswith('/api/')
 body=json.dumps(item.get('body',{})).encode() if item.get('method','GET')!='GET' else None
 request=urllib.request.Request(origin+path,data=body,method=item.get('method','GET'),headers={'OAI-Sites-Authorization':'Bearer '+payload['token'],'Content-Type':'application/json'})
 try:
  with urllib.request.urlopen(request,timeout=1200) as r:
   value=json.load(r)
   if path=='/api/state':
    print(json.dumps({'path':path,'suppliers':value.get('suppliers'),'products':len(value.get('groups',[])),'listings':len(value.get('listings',[])),'jobs':value.get('jobs'),'settings':value.get('settings'),'nextRun':value.get('nextRun')}))
   else:print(json.dumps({'path':path,'result':value}))
 except urllib.error.HTTPError as e: print(json.dumps({'path':path,'status':e.code,'error':e.read().decode()[:2000]}))

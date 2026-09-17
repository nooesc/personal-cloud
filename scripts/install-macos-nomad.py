#!/usr/bin/python3
"""Enroll this user's Mac in an existing private Nomad cluster; never creates a server."""
import argparse,json,os,pathlib,plistlib,shutil,subprocess
p=argparse.ArgumentParser();p.add_argument('--server',required=True);p.add_argument('--advertise',required=True);p.add_argument('--nomad-binary',required=True);p.add_argument('--agent-binary',required=True);p.add_argument('--state',required=True);p.add_argument('--work-dir',required=True);a=p.parse_args()
if os.geteuid()==0:raise SystemExit('Run as the Mac user, not root')
if os.uname().sysname!='Darwin':raise SystemExit('macOS only')
plist=pathlib.Path.home()/'Library/LaunchAgents/dev.nooesc.nomad-client.plist'
if plist.exists():raise SystemExit('Existing Nomad LaunchAgent requires explicit update; no changes made')
identity=json.loads(pathlib.Path(a.state).read_text());base=pathlib.Path.home()/'Library/Application Support/Personal Cloud/Nomad';base.mkdir(parents=True,exist_ok=True);base.chmod(0o700)
data=pathlib.Path.home()/'.dinghy/nomad';data.mkdir(parents=True,exist_ok=True);data.parent.chmod(0o700);data.chmod(0o700)
binary=base/'nomad';shutil.copy2(a.nomad_binary,binary);binary.chmod(0o755)
config={'data_dir':str(pathlib.Path.home()/'.dinghy/nomad'),'bind_addr':'127.0.0.1','advertise':{'http':a.advertise+':4646','rpc':a.advertise+':4647','serf':a.advertise+':4648'},'server':{'enabled':False},'client':{'enabled':True,'servers':[a.server],'cpu_total_compute':(os.cpu_count() or 4)*1000,'reserved':{'cpu':2000,'memory':4096},'options':{'driver.allowlist':'raw_exec'},'meta':{'pc_machine_id':identity['id'],'pc_location':'home','pc_compute':'false','pc_builder':'false','pc_database':'false','pc_native':'true','pc_apple':'true','pc_apple_agent':str(pathlib.Path(a.agent_binary).resolve()),'pc_apple_state':str(pathlib.Path(a.state).resolve()),'pc_apple_work':str(pathlib.Path(a.work_dir).resolve())}},'plugin':{'raw_exec':{'config':{'enabled':True}}},'acl':{'enabled':True},'consul':{'auto_advertise':False,'server_auto_join':False,'client_auto_join':False}}
cfg=base/'client.json';cfg.write_text(json.dumps(config,indent=2));cfg.chmod(0o600)
subprocess.run([str(binary),'config','validate',str(cfg)],check=True)
plist.parent.mkdir(exist_ok=True)
plist.write_bytes(plistlib.dumps({'Label':'dev.nooesc.nomad-client','ProgramArguments':[str(binary),'agent','-config='+str(cfg)],'RunAtLoad':True,'KeepAlive':True,'EnvironmentVariables':{'PATH':'/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'},'StandardOutPath':str(base/'nomad.log'),'StandardErrorPath':str(base/'nomad-error.log')}))
subprocess.run(['launchctl','bootstrap',f'gui/{os.getuid()}',str(plist)],check=True)
print('Nomad client installed. Verify registration and driver health on the existing server before declaring readiness.')

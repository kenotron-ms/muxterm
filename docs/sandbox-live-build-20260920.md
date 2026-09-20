DID A HUMAN-VISIBLE SANDBOX WORKSPACE ACCEPT TYPED INPUT AND RETURN OUTPUT - NO.

Milestone 1 failed at (a): inspection did not locate the already-running sandbox broker on this machine. No broker PID, listening port, or active source directory was identified. The checkout at `/home/ken/workspace/sandboxes` was found, but no running process was connected to it. No broker routes were changed, no broker was restarted, and no replacement service was started.

The investigation read muxterm AGENTS.md and the prior adaptation and browser-verification reports, then inspected host TCP listeners with root process attribution, Python process arguments, system and user units, Docker containers, Incus containers, and network namespaces. The candidate uvicorn process, PID 1215, ran `/app/backend/.venv/bin/python3 -m uvicorn app:app --host 0.0.0.0 --port 8080 --log-level info` in `research-workbench-workbench-1`; its cwd was `/app/backend`. It was not identified as the sandbox broker. PID 542 ran the ledger service on 9199. PID 537 ran the file server on 8899. Incus listener inspection found muxterm and existing verification fixtures, not a broker.

Captured identification output:

```text
$ ps -p 542,537,1215 -o pid,comm,args
537 python3 /usr/bin/python3 /home/ken/.local/bin/fileserver
542 python /home/ken/.local/share/vela-ledger-service/.venv/bin/python -m ledger_service --bind 0.0.0.0 --port 9199 --log-level info
1215 python3 /app/backend/.venv/bin/python3 -m uvicorn app:app --host 0.0.0.0 --port 8080 --log-level info
$ sudo readlink /proc/1215/cwd
/app/backend
$ git -C /home/ken/workspace/sandboxes log -1 --format='%h %s'
446f658 fix(infra): update broker's default sandbox disk to working image (ed8cccc)
$ gh pr view 161 --json state,headRefName,mergeCommit,url
{"headRefName":"feat/https-sandbox-relay","mergeCommit":null,"state":"OPEN","url":"https://github.com/kenotron-ms/muxterm/pull/161"}
$ gh pr view 150 --json state,mergeCommit,url
{"mergeCommit":{"oid":"ddf846afa2a5771040b1d08f568039ea6dbafb41"},"state":"MERGED","url":"https://github.com/kenotron-ms/muxterm/pull/150"}
```

The checkout's `docs/operators/README.md` documented the local launch command `uvicorn broker.app:default_app --host 127.0.0.1 --port 8088 --app-dir .`. The captured host listeners contained no 8088 listener. The same document identified the local default as `StubBackend`, a **stub**, and described a separate Azure Container App named `ca-broker-sandboxes`. No cloud deployment inspection or change was performed. The existing `~/.amplifier-sandbox-broker/` directory contained `fake_vault.json`, `registry.jsonl`, and `sandboxes/`; those files did not identify a running service.

Milestone status:

| Requirement | Result |
| --- | --- |
| (a) Located already-running local broker | FAILED: no matching service identified |
| (b) Implemented relay routes in that service | NOT DONE; broker changes: none |
| (c) Provisioned sandbox with outbound agent/private sessiond | NOT DONE |
| (d) Connected muxterm remote transport | NOT DONE |
| (e) Browser typing, command output, screenshot | NOT DONE; no terminal proof or screenshot captured |
| (f) Fault-injection proof against that broker | NOT RUN |

PR #161 remained prior work against a **reference implementation** broker and a **synthetic workspace fixture** named `sandbox:fixture/w7`. Its earlier screenshots and fault results were not counted as evidence for this task. The existing relay fault rig was inspected but not executed against an unidentified service.

No real Azure resource was created. No Azure resource teardown was needed or performed. Milestone 2 was not started because Milestone 1 failed. No runtime process or container was created for this task. Production muxterm processes, configuration, and other lanes were not changed. No unit tests were written or run. No implementation passed verification; this draft PR contained only the failure record.

Full captured host discovery output followed. Unit-list output was filtered to broker/sandbox names; the empty result was recorded explicitly.

```text
$ date -u
Sun Sep 20 22:45:34 UTC 2026

$ sudo ss -ltnp
State  Recv-Q Send-Q               Local Address:Port  Peer Address:PortProcess                                                         
LISTEN 0      4096                    127.0.0.54:53         0.0.0.0:*    users:(("systemd-resolve",pid=148,fd=20))                      
LISTEN 0      511                        0.0.0.0:18174      0.0.0.0:*    users:(("MainThread",pid=531,fd=21))                           
LISTEN 0      4096                     127.0.0.1:8313       0.0.0.0:*    users:(("muxterm-dev",pid=1358373,fd=3))                       
LISTEN 0      4096                     127.0.0.1:9090       0.0.0.0:*    users:(("muxterm",pid=1176665,fd=3))                           
LISTEN 0      128                      127.0.0.1:42183      0.0.0.0:*    users:(("code-a44adf7f53",pid=167716,fd=12))                   
LISTEN 0      4096                  100.84.25.57:65134      0.0.0.0:*    users:(("tailscaled",pid=310,fd=22))                           
LISTEN 0      5                          0.0.0.0:8899       0.0.0.0:*    users:(("python3",pid=537,fd=3))                               
LISTEN 0      2048                       0.0.0.0:9199       0.0.0.0:*    users:(("python",pid=542,fd=15))                               
LISTEN 0      32                      10.9.113.1:53         0.0.0.0:*    users:(("dnsmasq",pid=156300,fd=9))                            
LISTEN 0      4096                 127.0.0.53%lo:53         0.0.0.0:*    users:(("systemd-resolve",pid=148,fd=18))                      
LISTEN 0      4096                       0.0.0.0:7687       0.0.0.0:*    users:(("docker-proxy",pid=1160,fd=8))                         
LISTEN 0      4096                     127.0.0.1:33914      0.0.0.0:*    users:(("incusd",pid=3239250,fd=7),("incusd",pid=3239250,fd=3))
LISTEN 0      4096                     127.0.0.1:33871      0.0.0.0:*    users:(("incusd",pid=2796753,fd=7),("incusd",pid=2796753,fd=3))
LISTEN 0      128                        0.0.0.0:8082       0.0.0.0:*    users:(("zellij",pid=663,fd=15))                               
LISTEN 0      4096                       0.0.0.0:7474       0.0.0.0:*    users:(("docker-proxy",pid=1139,fd=8))                         
LISTEN 0      4096                       0.0.0.0:5355       0.0.0.0:*    users:(("systemd-resolve",pid=148,fd=12))                      
LISTEN 0      128                        0.0.0.0:22         0.0.0.0:*    users:(("sshd",pid=331,fd=6))                                  
LISTEN 0      4096                             *:31080            *:*    users:(("incusd",pid=819111,fd=7),("incusd",pid=819111,fd=3))  
LISTEN 0      4096                             *:31090            *:*    users:(("incusd",pid=819373,fd=7),("incusd",pid=819373,fd=3))  
LISTEN 0      32        [fd42:3303:c089:6261::1]:53            [::]:*    users:(("dnsmasq",pid=156300,fd=11))                           
LISTEN 0      4096   [fd7a:115c:a1e0::1a3a:193a]:51710         [::]:*    users:(("tailscaled",pid=310,fd=23))                           
LISTEN 0      4096                             *:8311             *:*    users:(("caddy",pid=538,fd=3))                                 
LISTEN 0      4096                          [::]:7687          [::]:*    users:(("docker-proxy",pid=1167,fd=8))                         
LISTEN 0      4096                             *:8087             *:*    users:(("caddy",pid=535,fd=3))                                 
LISTEN 0      4096                             *:8092             *:*    users:(("caddy",pid=532,fd=3))                                 
LISTEN 0      4096                          [::]:7474          [::]:*    users:(("docker-proxy",pid=1146,fd=8))                         
LISTEN 0      4096                             *:4180             *:*    users:(("oauth2-proxy",pid=536,fd=3))                          
LISTEN 0      4096                             *:4182             *:*    users:(("oauth2-proxy",pid=533,fd=3))                          
LISTEN 0      4096                          [::]:5355          [::]:*    users:(("systemd-resolve",pid=148,fd=14))                      
LISTEN 0      128                           [::]:22            [::]:*    users:(("sshd",pid=331,fd=7))                                  

$ docker ps --format {{.Names}} {{.Image}} {{.Ports}}
neo4j-ci neo4j:5.26.22-community 0.0.0.0:7474->7474/tcp, [::]:7474->7474/tcp, 7473/tcp, 0.0.0.0:7687->7687/tcp, [::]:7687->7687/tcp
research-workbench-workbench-1 research-workbench-workbench 

$ incus list
+--------------------+---------+---------------------+------------------------------------------------+-----------+-----------+
|        NAME        |  STATE  |        IPV4         |                      IPV6                      |   TYPE    | SNAPSHOTS |
+--------------------+---------+---------------------+------------------------------------------------+-----------+-----------+
| mc-foundation-0911 | RUNNING | 10.9.113.111 (eth0) | fd42:3303:c089:6261:1266:6aff:fe3b:dd82 (eth0) | CONTAINER | 0         |
+--------------------+---------+---------------------+------------------------------------------------+-----------+-----------+
| muxterm-rp         | RUNNING | 10.9.113.144 (eth0) | fd42:3303:c089:6261:1266:6aff:fec0:7762 (eth0) | CONTAINER | 0         |
+--------------------+---------+---------------------+------------------------------------------------+-----------+-----------+
| pr142-falsify      | STOPPED |                     |                                                | CONTAINER | 0         |
+--------------------+---------+---------------------+------------------------------------------------+-----------+-----------+

$ systemctl --user list-unit-files --no-pager

(no broker/sandbox matches when blank above)

$ git -C /home/ken/workspace/sandboxes remote -v
origin	https://github.com/kenotron-ms/amplifier-sandboxes.git (fetch)
origin	https://github.com/kenotron-ms/amplifier-sandboxes.git (push)

Processes with cwd under sandboxes checkouts: []
```

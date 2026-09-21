set -eu
mkdir -p /opt/relay/tls
openssl req -x509 -newkey rsa:2048 -nodes -keyout /opt/relay/tls/key.pem -out /opt/relay/tls/cert.pem -days 2 -subj /CN=localhost -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:10.222.0.1' >/tmp/cert.log 2>&1
cp /opt/relay/tls/cert.pem /usr/local/share/ca-certificates/relay.crt
update-ca-certificates >/tmp/ca.log 2>&1
ip netns add relay-worker
ip link add relay-host type veth peer name relay-peer
ip link set relay-peer netns relay-worker
ip addr add 10.222.0.1/24 dev relay-host
ip link set relay-host up
ip netns exec relay-worker ip addr add 10.222.0.2/24 dev relay-peer
ip netns exec relay-worker ip link set relay-peer up
ip netns exec relay-worker ip link set lo up
ip netns exec relay-worker iptables -A INPUT -i lo -j ACCEPT
ip netns exec relay-worker iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
ip netns exec relay-worker iptables -P INPUT DROP
ip netns exec relay-worker iptables -A OUTPUT -o lo -j ACCEPT
ip netns exec relay-worker iptables -A OUTPUT -d 10.222.0.1 -p tcp --dport 443 -j ACCEPT
ip netns exec relay-worker iptables -P OUTPUT DROP
ip netns exec relay-worker ip6tables -P INPUT DROP
ip netns exec relay-worker ip6tables -P OUTPUT DROP
cat > /etc/nginx/sites-enabled/default <<'NGINX'
server {
 listen 443 ssl;
 ssl_certificate /opt/relay/tls/cert.pem;
 ssl_certificate_key /opt/relay/tls/key.pem;
 location / {
  proxy_pass http://127.0.0.1:18080;
  proxy_http_version 1.1;
  proxy_buffering off;
  proxy_read_timeout 60s;
 }
}
NGINX
nginx -t
systemctl restart nginx

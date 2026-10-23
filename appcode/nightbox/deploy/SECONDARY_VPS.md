# NightBox secondary VPS

The secondary host is an isolated edge origin for the creator/admin dashboard
and NightBox API traffic. It serves the static Vite build from
`/var/www/nightbox-secondary/web` and proxies NightBox API, upload, video,
watch, and share-link routes to the primary backend at `67.211.219.103`.

It must not share Docker networks, PM2 apps, volumes, databases, or Nginx site
files with unrelated projects on that host. DNS/TLS cutover is deliberately a
separate operational step: issue a certificate on the secondary after the
NightBox DNS records point there, then add the HTTPS listener before switching
production traffic.

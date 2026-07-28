# Static marketing site — served by nginx.
# Coolify: build from this Dockerfile, route the domain to container port 80.
FROM nginx:1.27-alpine

# site config (replaces the default server block)
COPY nginx.conf /etc/nginx/conf.d/default.conf

# static assets
COPY index.html /usr/share/nginx/html/index.html
COPY avatars    /usr/share/nginx/html/avatars
COPY logos      /usr/share/nginx/html/logos

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1/healthz || exit 1

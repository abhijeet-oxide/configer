# Build the SPA and serve it with nginx, proxying /api to the backend.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY . .
RUN npm run build

# nginx-unprivileged runs as a non-root user (uid 101) and listens on 8080, so
# the container needs no root at any point. See nginx.conf for the matching port.
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
